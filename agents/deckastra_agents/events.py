"""The streaming event schema (doc 03 §20, gap register doc 03 S3).

A generation takes tens of seconds. Without progress the user is looking at a
spinner wondering whether it hung; with the wrong progress they are looking at
the model's reasoning, which is both noisy and a privacy problem.

So the event shape is fixed here and every agent emits through it:

    stage       which node is running
    agent_id    which agent, for the inspector and for attribution
    status      started | progress | completed | failed | waiting
    message     one user-facing sentence, never chain-of-thought
    progress    0..1 where the node can estimate it, else None
    artifacts   ids of things produced, never the things themselves

The last one is the load-bearing constraint. A slide preview is 200KB; putting it
in an event puts it in the checkpoint, the Redis channel and the SSE stream. The
event carries the id and the client fetches what it needs (doc 03 §19).
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Literal

EventStatus = Literal["started", "progress", "completed", "failed", "waiting"]


@dataclass(frozen=True)
class AgentEvent:
    run_id: str
    stage: str
    status: EventStatus
    message: str
    agent_id: str | None = None
    progress: float | None = None
    #: Ids only. Never the artifact itself — see the module docstring.
    artifact_refs: list[str] = field(default_factory=list)
    #: Milliseconds since the epoch, so a client can order events it receives late.
    at: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}

    def to_sse(self) -> str:
        """One Server-Sent Event.

        Named by status so a client can listen selectively, and terminated with
        the blank line the protocol requires — a missing one makes the stream
        appear to hang, which is indistinguishable from the failure this whole
        mechanism exists to rule out.
        """
        return f"event: {self.status}\ndata: {json.dumps(self.to_dict())}\n\n"


#: What a node calls to report progress. Injected rather than imported so a node
#: can be tested by passing a list's `append`.
Emitter = Callable[[AgentEvent], None]


def collector() -> tuple[list[AgentEvent], Emitter]:
    """An emitter that appends to a list. For tests and for synchronous runs."""
    events: list[AgentEvent] = []
    return events, events.append


class RedisEmitter:
    """Publishes events to a Redis channel for the SSE endpoint to relay.

    Redis rather than the Postgres checkpointer for this specific job: progress
    events are ephemeral, high-frequency and worthless after the run, while
    checkpoints are durable and worth recovering. Doc 03 §19 and doc 05 §25
    disagreed about which store to use; the answer is both, for different things
    (gap register doc 05 S2).

    A publish failure is swallowed. Losing a progress event is a worse UI; losing
    the generation because the progress channel was down would be absurd.
    """

    def __init__(self, client: Any, channel_prefix: str = "deckastra:run:") -> None:
        self._client = client
        self._prefix = channel_prefix

    def __call__(self, event: AgentEvent) -> None:
        try:
            self._client.publish(
                f"{self._prefix}{event.run_id}", json.dumps(event.to_dict())
            )
        except Exception:  # noqa: BLE001 - progress must never fail a run
            pass


def fan_out(*emitters: Emitter) -> Emitter:
    """Send each event to several places — a Redis channel and the run's log."""

    def emit(event: AgentEvent) -> None:
        for emitter in emitters:
            emitter(event)

    return emit
