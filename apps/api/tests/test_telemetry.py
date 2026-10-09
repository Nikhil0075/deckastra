"""Real SDK/exporter delivery and the content boundary, without external services."""

from __future__ import annotations

import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from opentelemetry.sdk.metrics.export import MetricExporter, MetricExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import telemetry
from deckastra_api.ids import new_id


class MetricSink(MetricExporter):
    def __init__(self):
        super().__init__()
        self.batches = []

    def export(self, metrics_data, timeout_millis=10_000, **kwargs):
        self.batches.append(metrics_data)
        return MetricExportResult.SUCCESS

    def force_flush(self, timeout_millis=10_000):
        return True

    def shutdown(self, timeout_millis=30_000, **kwargs):
        pass

    def points(self, name):
        return [point for batch in self.batches for resource in batch.resource_metrics
                for scope in resource.scope_metrics for metric in scope.metrics
                if metric.name == name for point in metric.data.data_points]


@pytest.fixture(autouse=True)
def isolated_telemetry(monkeypatch):
    telemetry.shutdown()
    for key in list(os.environ):
        if key.startswith("OTEL_") or key == "DECKASTRA_TELEMETRY":
            monkeypatch.delenv(key)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    yield
    telemetry.shutdown()


def test_unconfigured_and_disabled_are_not_reported_as_exporting(monkeypatch):
    assert telemetry.configure() is False
    assert not telemetry.enabled()
    monkeypatch.setenv("DECKASTRA_TELEMETRY", "off")
    assert not telemetry.configure(trace_exporter=InMemorySpanExporter())
    monkeypatch.setenv("DECKASTRA_TELEMETRY", "1")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
    assert not telemetry.configure()
    assert not telemetry.enabled()


def test_existing_instruments_deliver_reconfigure_and_stop():
    first, second = MetricSink(), MetricSink()
    workspace = new_id("wsp")
    assert telemetry.configure(metric_exporter=first)
    telemetry.record_quota_refusal(workspace_id=workspace, limit="monthly_generations")
    assert telemetry.flush()
    assert first.points("deckastra.quota_refusals")[-1].value == 1
    assert telemetry.configure(metric_exporter=second)
    telemetry.record_quota_refusal(workspace_id=workspace, limit="monthly_generations")
    telemetry.record_quota_refusal(workspace_id=workspace, limit="monthly_generations")
    assert telemetry.flush()
    assert second.points("deckastra.quota_refusals")[-1].value == 2
    telemetry.shutdown()
    before = len(second.batches)
    telemetry.record_quota_refusal(workspace_id=workspace, limit="monthly_generations")
    telemetry.flush()
    assert len(second.batches) == before
    assert not telemetry.enabled()


def test_invalid_optional_exporter_configuration_does_not_break_startup(monkeypatch):
    monkeypatch.setenv("DECKASTRA_TELEMETRY", "1")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "not-a-number")
    assert not telemetry.configure()
    assert not telemetry.enabled()


def test_content_cannot_escape_through_late_attributes_metrics_or_exceptions():
    from opentelemetry.trace import Status, StatusCode

    traces, metrics = InMemorySpanExporter(), MetricSink()
    telemetry.configure(trace_exporter=traces, metric_exporter=metrics)
    secret = "private deck sentence"
    run_id = new_id("run")
    with pytest.raises(ValueError, match=secret):
        with telemetry.span(secret, prompt=secret, **{telemetry.RUN_ID: run_id}) as current:
            current.set_attribute("title", secret)
            current.set_attributes({telemetry.MODEL: secret, "unknown": secret, telemetry.TOKENS_IN: 42})
            current.set_status(Status(StatusCode.ERROR, secret))
            current.record_exception(RuntimeError(secret))
            raise ValueError(secret)
    telemetry.GENERATIONS.add(1, {"prompt": secret, "workspace_id": secret, "outcome": "completed"})
    telemetry.GENERATIONS.add(-1, {"outcome": "completed"})
    assert telemetry.flush()
    saved = traces.get_finished_spans()[0]
    assert saved.name == "operation"
    assert saved.attributes == {telemetry.RUN_ID: run_id, telemetry.TOKENS_IN: 42}
    assert saved.status.status_code == StatusCode.ERROR
    assert saved.status.description is None
    assert saved.events and all(dict(event.attributes) == {"error.type": "error"} for event in saved.events)
    points = metrics.points("deckastra.generations")
    assert points[-1].value == 1
    assert dict(points[-1].attributes) == {"outcome": "completed"}
    assert secret not in str(saved.to_json()) + repr(metrics.batches)


def test_otlp_environment_exports_trace_and_metric_protobuf_to_a_real_collector(monkeypatch):
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest

    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append((self.path, self.headers["Content-Type"], body))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "2")
        # Standard signal-specific settings override the common default.
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/protobuf")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/protobuf")
        assert telemetry.configure()
        configuration = telemetry._configuration
        assert telemetry.configure()
        assert telemetry._configuration == configuration
        with telemetry.span("generation", **{telemetry.RUN_ID: new_id("run")}):
            telemetry.record_generation(workspace_id=new_id("wsp"), run_id=new_id("run"),
                                        duration_ms=12, tokens_in=7, tokens_out=3, outcome="completed")
        assert telemetry.flush()
        payloads = {path: body for path, content_type, body in received if content_type == "application/x-protobuf"}
        traces = ExportTraceServiceRequest.FromString(payloads["/v1/traces"])
        metrics = ExportMetricsServiceRequest.FromString(payloads["/v1/metrics"])
        assert traces.resource_spans[0].scope_spans[0].spans[0].name == "generation"
        values = {metric.name: metric for resource in metrics.resource_metrics
                  for scope in resource.scope_metrics for metric in scope.metrics}
        assert values["deckastra.generations"].sum.data_points[0].as_int == 1
        assert values["deckastra.tokens"].sum.data_points[0].as_int == 10
        assert telemetry.configure(force=True)
        assert telemetry._configuration > configuration
        with telemetry.span("export", **{telemetry.PRESENTATION_ID: new_id("prs")}):
            telemetry.record_export(workspace_id=new_id("wsp"), kind="pdf", duration_ms=3, outcome="failed")
        assert telemetry.flush()
        latest = {path: body for path, _, body in received}
        reconfigured = ExportTraceServiceRequest.FromString(latest["/v1/traces"])
        assert reconfigured.resource_spans[0].scope_spans[0].spans[0].name == "export"
        exported = ExportMetricsServiceRequest.FromString(latest["/v1/metrics"])
        failures = [metric for resource in exported.resource_metrics for scope in resource.scope_metrics
                    for metric in scope.metrics if metric.name == "deckastra.exports"]
        assert failures[0].sum.data_points[0].as_int == 1
        assert any(a.key == "outcome" and a.value.string_value == "failed"
                   for a in failures[0].sum.data_points[0].attributes)
    finally:
        telemetry.shutdown()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
