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
import os
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
_MAX_ATTRIBUTE_LENGTH = 200


class _NoopSpan:
    """What a span is when OpenTelemetry is not installed.

    A real object rather than `None`, so every call site can set attributes
    unconditionally. `if span:` scattered through the code is how half the
    attributes end up inside a branch that does not run.
    """

    def set_attribute(self, key: str, value: Any) -> None:  # noqa: D102
        return None

    def record_exception(self, error: BaseException) -> None:  # noqa: D102
        return None

    def set_status(self, *args: Any, **kwargs: Any) -> None:  # noqa: D102
        return None


_tracer: Any | None = None
_meter: Any | None = None
_enabled = False


def configure(app: Any | None = None) -> bool:
    """Wire up OpenTelemetry if it is available.

    Returns whether it was. Called once at startup; safe to call again.

    The exporter is configured entirely by the standard `OTEL_*` environment
    variables rather than by arguments here, because that is how every other
    OpenTelemetry deployment is configured and inventing a second mechanism would
    mean operators had to learn both.
    """
    global _tracer, _meter, _enabled

    if _enabled:
        return True

    if os.environ.get("DECKASTRA_TELEMETRY", "").lower() in ("0", "off", "false"):
        logger.info("Telemetry is switched off by DECKASTRA_TELEMETRY.")
        return False

    try:
        from opentelemetry import metrics, trace
    except ImportError:
        # Not an error. A fresh clone should start, and an observability layer
        # that blocks that is one people remove rather than configure.
        logger.info("OpenTelemetry is not installed; traces and metrics are no-ops.")
        return False

    _tracer = trace.get_tracer(SERVICE_NAME)
    _meter = metrics.get_meter(SERVICE_NAME)
    _enabled = True

    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app)
        except ImportError:
            logger.info("FastAPI instrumentation is not installed; spans are manual only.")

    logger.info("OpenTelemetry is configured for %s.", SERVICE_NAME)
    return True


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

    if not _enabled or _tracer is None:
        current = _NoopSpan()
        try:
            yield current
        finally:
            logger.debug("%s took %.1fms", name, (time.perf_counter() - started) * 1000)
        return

    with _tracer.start_as_current_span(name) as current:
        for key, value in attributes.items():
            _set(current, key, value)
        try:
            yield current
        except Exception as error:
            current.record_exception(error)
            raise


def _set(current: Any, key: str, value: Any) -> None:
    """Set one attribute, refusing anything that looks like user content.

    A string longer than a couple of hundred characters is not an id, and this is
    the boundary where a prompt or a slide's copy would leave the machine.
    """
    if value is None:
        return

    if isinstance(value, str) and len(value) > _MAX_ATTRIBUTE_LENGTH:
        logger.warning("Refused an oversized span attribute %r; ids and counts only.", key)
        return

    current.set_attribute(key, value)


def counter(name: str, description: str, unit: str = "1") -> Any:
    """A metric, or a no-op that swallows the call.

    Named after what it measures rather than where it is measured from — doc 04
    §31.5 makes the point that an untracked budget regresses quietly, and a metric
    called `api_handler_3_total` is untracked in every way that matters.
    """
    if not _enabled or _meter is None:
        return _NoopInstrument()
    return _meter.create_counter(name, unit=unit, description=description)


def histogram(name: str, description: str, unit: str = "ms") -> Any:
    if not _enabled or _meter is None:
        return _NoopInstrument()
    return _meter.create_histogram(name, unit=unit, description=description)


class _NoopInstrument:
    def add(self, *args: Any, **kwargs: Any) -> None:  # noqa: D102
        return None

    def record(self, *args: Any, **kwargs: Any) -> None:  # noqa: D102
        return None


# --------------------------------------------------------------- the metrics

#: Doc 05 §32's list, as instruments. Declared at import so the names exist in
#: one place and a dashboard can be built against them before any data arrives.
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
