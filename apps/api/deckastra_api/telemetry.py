"""Observability (gap register doc 05 S3).

Doc 05 §32 lists what to track and not how, and the gap register's fix is to name
the stack: OpenTelemetry for traces and metrics, plus an LLM-specific tracer for
agent runs, because doc 03 §22's evaluation loop needs run-level traces to be
worth anything.

This is the seam rather than the vendor. Three things make that a real decision
rather than an evasion:

**OpenTelemetry is optional at runtime.** If the package is not installed, every
call here is a no-op and the product runs. An observability layer that a fresh
clone cannot start without is one people delete.

**Spans carry the ids the product reasons in.** `presentation_id`, `run_id`,
`workspace_id`, `version_id`. A trace that only has HTTP routes tells you the API
was slow; one carrying the run id tells you *which generation* was slow and lets
you open it in the agent inspector.

**Nothing user-written goes in an attribute.** A deck's title, a prompt, a
retrieved chunk — none of it. Traces leave the machine and land in a third-party
store, and a span attribute is the easiest place in a system to leak a customer's
words without noticing. Ids and counts only; the words stay in the database
behind the authorisation chain.
"""

from __future__ import annotations

import logging
import math
import os
import re
import time
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger("deckastra.telemetry")

#: The service name every span and metric is tagged with.
SERVICE_NAME = "deckastra-api"

#: Attribute keys, as constants. A typo in a span attribute is invisible — the
#: span is still recorded, the dashboard just never matches it.
PRESENTATION_ID = "deckastra.presentation_id"
WORKSPACE_ID = "deckastra.workspace_id"
RUN_ID = "deckastra.run_id"
VERSION_ID = "deckastra.version_id"
STAGE = "deckastra.stage"
MODEL = "deckastra.model"
TOKENS_IN = "deckastra.tokens_in"
TOKENS_OUT = "deckastra.tokens_out"
SLIDE_COUNT = "deckastra.slide_count"
OUTCOME = "deckastra.outcome"

#: Attributes that must never carry user text. Enforced rather than remembered:
#: a trace store is a third party, and a span attribute is the easiest place in a
#: system to leak a customer's words.
_ID_PREFIXES = {
    "presentation_id": "prs", "workspace_id": "wsp", "run_id": "run",
    "version_id": "ver", "user_id": "usr", "project_id": "prj", "slide_id": "sld",
}
_ENUMS = {
    "outcome": {"completed", "failed", "refused", "exhausted", "awaiting_approval", "model", "stub"},
    "stage": {"orchestrator", "research", "story", "creative", "layout", "motion", "critic", "propose", "edit", "unknown"},
    "task_type": {"planning", "structured", "critique", "fast"},
    "direction": {"input", "output", "total"},
    "kind": {"png", "pdf", "pptx", "mydeck"},
    "limit": {"monthly_generations", "monthly_tokens", "storage_bytes", "daily_credits"},
    "http.request.method": {"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"},
}
_COUNTS = {"tokens_in", "tokens_out", "slide_count", "http.response.status_code"}
_SPAN_NAMES = {"http.request", "export", "generation", "agent.run", "agent.model", "agent.edit", "index"}


def _safe_attributes(attributes: dict[str, Any] | None) -> dict[str, Any]:
    """Allow known dimensions and values, not arbitrary short strings.

    This applies equally to initial attributes, later writes and metric labels.
    Unknown keys are dropped without logging their names or their contents.
    """
    result: dict[str, Any] = {}
    for key, value in (attributes or {}).items():
        if not isinstance(key, str):
            continue
        bare = key.removeprefix("deckastra.")
        if bare in _ID_PREFIXES and isinstance(value, str):
            if re.fullmatch(_ID_PREFIXES[bare] + r"_[0-9A-HJKMNP-TV-Z]{26}", value):
                result[key] = value
        elif bare in _ENUMS and isinstance(value, str) and value in _ENUMS[bare]:
            result[key] = value
        elif bare in _COUNTS and type(value) is int and value >= 0:
            result[key] = value
        elif bare == "model" and isinstance(value, str):
            from deckastra_agents.router import MODELS
            if value in {*MODELS.values(), "stub"}:
                result[key] = value
    return result


class _NoopSpan:
    """What a span is when OpenTelemetry is not installed.

    A real object rather than `None`, so every call site can set attributes
    unconditionally. `if span:` scattered through the code is how half the
    attributes end up inside a branch that does not run.
    """

    def set_attribute(self, key: str, value: Any) -> None:  # noqa: D102
        return None

    def set_attributes(self, attributes: dict[str, Any]) -> None:
        return None

    def record_exception(self, error: BaseException) -> None:  # noqa: D102
        return None

    def set_status(self, *args: Any, **kwargs: Any) -> None:  # noqa: D102
        return None


_tracer: Any | None = None
_meter: Any | None = None
_enabled = False
#: Bumped by every successful `configure()`. Instruments compare against it so a
#: reconfigured meter replaces what they resolved against a previous one.
_configuration = 0
_providers: tuple[Any, ...] = ()


def configure(
    app: Any | None = None, *, force: bool = False,
    trace_exporter: Any | None = None, metric_exporter: Any | None = None,
) -> bool:
    """Own real SDK providers and exporters, without replacing global providers.

    Deployment uses OTLP HTTP/protobuf and standard OTEL endpoint/header/timeout
    variables. No collector is contacted on an unconfigured fresh clone. Explicit
    exporters support embedded deployments and real SDK delivery tests. `force`
    rebuilds providers; ordinary repeated startup calls are idempotent.
    """
    global _tracer, _meter, _enabled, _configuration, _providers
    if os.environ.get("DECKASTRA_TELEMETRY", "").lower() in ("0", "off", "false"):
        shutdown()
        return False
    explicit = trace_exporter is not None or metric_exporter is not None
    if _enabled and not force and not explicit:
        return True
    requested = os.environ.get("DECKASTRA_TELEMETRY", "").lower() in {"1", "on", "true"}
    endpoints = any(os.environ.get(key) for key in (
        "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    ))
    if not (explicit or requested or endpoints):
        shutdown()
        return False
    default_protocol = os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
    protocols = [os.environ.get(key, default_protocol) for key in (
        "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    )]
    if not explicit and any(protocol != "http/protobuf" for protocol in protocols):
        shutdown()
        logger.warning("Telemetry requires OTLP http/protobuf; configuration was not enabled.")
        return False
    try:
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        if not explicit:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
            trace_exporter = OTLPSpanExporter()
            metric_exporter = OTLPMetricExporter()
    except ImportError:
        shutdown()
        logger.warning("Telemetry SDK/exporter unavailable; telemetry is disabled.")
        return False
    except (ValueError, TypeError):
        shutdown()
        logger.warning("Invalid telemetry exporter configuration; telemetry is disabled.")
        return False
    shutdown()
    try:
        resource = Resource({"service.name": SERVICE_NAME})
        tracer_provider = TracerProvider(resource=resource)
        _providers = (tracer_provider,)
        if trace_exporter is not None:
            tracer_provider.add_span_processor(BatchSpanProcessor(trace_exporter))
        readers = [PeriodicExportingMetricReader(metric_exporter)] if metric_exporter is not None else []
        meter_provider = MeterProvider(resource=resource, metric_readers=readers)
        _providers = (tracer_provider, meter_provider)
    except (ValueError, TypeError):
        shutdown()
        logger.warning("Invalid telemetry SDK configuration; telemetry is disabled.")
        return False
    _tracer = tracer_provider.get_tracer(SERVICE_NAME)
    _meter = meter_provider.get_meter(SERVICE_NAME)
    _enabled = True
    _configuration += 1
    logger.info("OpenTelemetry SDK providers configured for %s.", SERVICE_NAME)
    return True


def flush(timeout_millis: int = 5_000) -> bool:
    outcomes = [provider.force_flush(timeout_millis=timeout_millis) for provider in _providers]
    return all(outcome is not False for outcome in outcomes)


def shutdown() -> None:
    global _providers, _tracer, _meter, _enabled, _configuration
    previous, _providers = _providers, ()
    _enabled, _tracer, _meter = False, None, None
    _configuration += 1
    for provider in previous:
        provider.shutdown()


async def http_middleware(request: Any, call_next: Any) -> Any:
    # Fixed operation name; never capture a URL/query, authorization header,
    # request/response body or a user-controlled path segment.
    with span("http.request", **{"http.request.method": request.method}) as current:
        response = await call_next(request)
        current.set_attribute("http.response.status_code", response.status_code)
        current.set_attribute(OUTCOME, "failed" if response.status_code >= 500 else "completed")
        return response


class TracedModelClient:
    """Measure model calls at the API boundary without tracing prompt content."""

    def __init__(self, client: Any, run_id: str) -> None:
        self._client, self._run_id = client, run_id

    def complete(self, request: Any, budget: Any) -> Any:
        with span("agent.model", **{RUN_ID: self._run_id, "task_type": request.task_type}) as current:
            response = self._client.complete(request, budget)
            current.set_attributes({
                MODEL: response.model, TOKENS_IN: response.input_tokens,
                TOKENS_OUT: response.output_tokens,
                OUTCOME: "refused" if response.refusal else "completed",
            })
            return response


def enabled() -> bool:
    return _enabled


@contextmanager
def span(name: str, **attributes: Any) -> Iterator[Any]:
    """One operation, traced.

    Falls back to a no-op span and a debug log line, so the same code path runs
    whether or not a collector exists. The duration is measured either way and
    logged at debug — which is what makes a local run diagnosable without any
    infrastructure at all.
    """
    started = time.perf_counter()
    name = name if name in _SPAN_NAMES else "operation"

    if not _enabled or _tracer is None:
        current = _NoopSpan()
        try:
            yield current
        finally:
            logger.debug("%s took %.1fms", name, (time.perf_counter() - started) * 1000)
        return

    # SDK defaults record exception text and stack traces automatically. Disable
    # those defaults as well as shielding the object returned to callers.
    with _tracer.start_as_current_span(name, record_exception=False, set_status_on_exception=False) as current:
        safe = _SafeSpan(current)
        safe.set_attributes(attributes)
        try:
            yield safe
        except Exception as error:
            safe.record_exception(error)
            raise


class _SafeSpan:
    def __init__(self, current: Any) -> None:
        self._current = current

    def set_attribute(self, key: str, value: Any) -> None:
        self.set_attributes({key: value})

    def set_attributes(self, attributes: dict[str, Any]) -> None:
        self._current.set_attributes(_safe_attributes(attributes))

    def record_exception(self, error: BaseException) -> None:
        from opentelemetry.trace import StatusCode
        # Error category only. No message, stack, request body or exception args.
        category = "timeout" if isinstance(error, TimeoutError) else "error"
        self._current.add_event("exception", {"error.type": category})
        self._current.set_status(StatusCode.ERROR)

    def set_status(self, status: Any, description: str | None = None) -> None:
        from opentelemetry.trace import StatusCode
        code = getattr(status, "status_code", status)
        if isinstance(code, StatusCode):
            self._current.set_status(code)


class _Instrument:
    """A metric that resolves itself the first time it is used.

    The reason this is not just `_meter.create_counter(...)`: the instruments
    below are declared at import, and `configure()` runs at startup — later. An
    instrument created eagerly captured the no-op meter and stayed a no-op for
    the life of the process, whatever telemetry was configured afterwards. Every
    metric the product records went nowhere, silently, which is the one way an
    observability layer can fail that nobody notices.

    Resolving on first use also means an instrument is never created for a
    process that has no meter — a test run, a CLI, a fresh clone.
    """

    def __init__(self, kind: str, name: str, description: str, unit: str) -> None:
        self._kind = kind
        self._name = name
        self._description = description
        self._unit = unit
        self._real: Any | None = None
        #: The generation of `configure()` this was resolved against, so a
        #: reconfigure (a test, mostly) does not leave a stale instrument behind.
        self._generation = -1

    def _resolve(self) -> Any | None:
        if not _enabled or _meter is None:
            return None
        if self._real is not None and self._generation == _configuration:
            return self._real

        factory = (
            _meter.create_counter if self._kind == "counter" else _meter.create_histogram
        )
        self._real = factory(self._name, unit=self._unit, description=self._description)
        self._generation = _configuration
        return self._real

    def add(self, amount: Any, attributes: Any = None) -> None:
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            return
        instrument = self._resolve()
        if instrument is not None:
            instrument.add(amount, _safe_attributes(attributes))

    def record(self, amount: Any, attributes: Any = None) -> None:
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            return
        instrument = self._resolve()
        if instrument is not None:
            instrument.record(amount, _safe_attributes(attributes))


def counter(name: str, description: str, unit: str = "1") -> _Instrument:
    """A metric, or a no-op that swallows the call.

    Named after what it measures rather than where it is measured from — doc 04
    §31.5 makes the point that an untracked budget regresses quietly, and a metric
    called `api_handler_3_total` is untracked in every way that matters.
    """
    return _Instrument("counter", name, description, unit)


def histogram(name: str, description: str, unit: str = "ms") -> _Instrument:
    return _Instrument("histogram", name, description, unit)


# --------------------------------------------------------------- the metrics

#: Doc 05 §32's list, as instruments. Declared at import so the names exist in
#: one place and a dashboard can be built against them before any data arrives —
#: and lazily bound, because at import there is no meter to bind to yet.
GENERATIONS = counter("deckastra.generations", "Deck generations started")
GENERATION_MS = histogram("deckastra.generation_duration", "How long a generation took")
TOKENS = counter("deckastra.tokens", "Model tokens spent", unit="{token}")
EXPORTS = counter("deckastra.exports", "Exports produced")
EXPORT_MS = histogram("deckastra.export_duration", "How long an export took")
QUOTA_REFUSALS = counter("deckastra.quota_refusals", "Requests refused by a quota")
SHARE_VIEWS = counter("deckastra.share_views", "Shared decks opened by a link")
INDEX_MS = histogram("deckastra.index_duration", "How long a repository index took")


def record_generation(
    *, workspace_id: str, run_id: str, duration_ms: float, tokens_in: int, tokens_out: int, outcome: str
) -> None:
    """The one metric call the generation path makes.

    A function rather than four instrument calls at the call site, so the
    dimensions stay consistent. Two places recording the same counter with
    different attribute sets produce a metric that cannot be summed.
    """
    labels = {"workspace_id": workspace_id, "outcome": outcome}
    GENERATIONS.add(1, labels)
    GENERATION_MS.record(duration_ms, labels)
    TOKENS.add(tokens_in + tokens_out, {**labels, "direction": "total"})


def record_export(*, workspace_id: str, kind: str, duration_ms: float, outcome: str) -> None:
    labels = {"workspace_id": workspace_id, "kind": kind, "outcome": outcome}
    EXPORTS.add(1, labels)
    EXPORT_MS.record(duration_ms, labels)


def record_quota_refusal(*, workspace_id: str, limit: str) -> None:
    QUOTA_REFUSALS.add(1, {"workspace_id": workspace_id, "limit": limit})
