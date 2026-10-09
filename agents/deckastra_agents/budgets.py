"""Run budgets (gap register doc 03 S1).

Doc 03 §21 says agents must never silently ignore a failure, and doc 03 §27
defers "unbounded agent recursion" — but neither states the numbers, which meant
there was nothing to enforce. These are the numbers.

The rule that shapes all of it: **exhausting a budget degrades and warns, it never
fails silently and it never fails hard.** A user who asked for a deck and got
nothing has lost more than a user who got a deck with a warning that the Critic
did not get to finish. The warning is part of the output, not a log line.

Two ceilings are hard stops rather than degradations, because past them the run
is no longer doing what the user asked:

- the per-run token ceiling, which is money,
- the wall-clock ceiling, which is a user who has walked away.
"""

from __future__ import annotations

import time
import threading
from contextvars import ContextVar
from typing import Callable
from dataclasses import dataclass, field


# Request-scoped billing for paid Google services. This is account plumbing,
# not model routing; speech and translation use it as well as media generation.
cost_observer = ContextVar("deckastra_account_cost_observer", default=None)


class BudgetExceeded(RuntimeError):
    """A hard ceiling was hit. Carries what the run produced up to that point."""

    def __init__(self, budget: str, limit: float, used: float) -> None:
        amounts = f"US${used:.4f} required; US${limit:.4f} ceiling" if "cost" in budget else f"{used:.0f} of {limit:.0f}"
        super().__init__(
            f"The {budget} budget is exhausted ({amounts}). "
            "The run stopped here; what it produced so far is kept."
        )
        self.budget = budget
        self.limit = limit
        self.used = used


class RunCancelled(RuntimeError):
    """Cancellation is a stop, never a reason to change providers."""


@dataclass
class RunBudget:
    """What one generation may spend.

    Defaults chosen from what a ten-slide deck actually costs, with headroom:
    roughly 30k tokens for a story plan and a critic pass, so 250k allows a full
    run plus several revisions before anything is unusual.
    """

    #: doc 03 §13.4 — after this many revise verdicts on one slide, take the best.
    max_revisions_per_slide: int = 2
    #: Across the whole deck, so a deck-wide disagreement cannot loop per slide.
    max_revisions_per_run: int = 3
    max_total_tokens: int = 250_000
    max_wall_clock_seconds: float = 180.0
    #: Per tool call. A hung integration must not hold the whole run.
    tool_timeout_seconds: float = 20.0
    #: Per workspace per day, checked by the caller before a run starts.
    daily_credit: int = 200

    used_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    # Structured requests, including repair outcomes; no prompts or response text.
    structured_requests: list[dict[str, object]] = field(default_factory=list)
    revisions_this_run: int = 0
    revisions_by_slide: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    started_at: float = field(default_factory=time.monotonic)
    #: Time spent loading a local model, kept off the run's clock (see `exclude_time`).
    startup_seconds: float = 0.0
    cancelled: Callable[[], bool] = field(default=lambda: False, repr=False)
    max_cost_usd: float | None = None
    used_cost_usd: float = 0.0
    reserved_cost_usd: float = 0.0
    cost_observer: Callable[[str, float, float], None] | None = field(default=None, repr=False)
    _cost_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ------------------------------------------------------------- hard stops

    def spend_tokens(self, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.used_tokens += input_tokens + output_tokens
        if self.used_tokens > self.max_total_tokens:
            raise BudgetExceeded("token", self.max_total_tokens, self.used_tokens)

    def check_clock(self) -> None:
        if self.cancelled():
            raise RunCancelled("The run was cancelled; completed changes and usage are retained.")
        elapsed = time.monotonic() - self.started_at
        if elapsed > self.max_wall_clock_seconds:
            raise BudgetExceeded("time", self.max_wall_clock_seconds, elapsed)

    def check_cancelled(self) -> None:
        """Cancellation without the clock, for waits that have their own bound."""
        if self.cancelled():
            raise RunCancelled("The run was cancelled; completed changes and usage are retained.")

    def exclude_time(self, seconds: float) -> None:
        """Keep a local model's start-up off the run's clock.

        Loading weights is the machine's cost, not the job's, and it has its own
        bound (the supervisor's start-up timeout). Counting it here meant a cold
        start spent most of a one-slide job's time before the model saw the
        slide, and the job then timed out on work that had barely begun.
        """
        if seconds > 0:
            self.started_at += seconds
            self.startup_seconds += seconds

    def reserve_cost(self, operation_id: str, maximum: float, *, task: str = "", model: str = "") -> None:
        """Unknown paid outcomes retain their reservation, preventing blind retries."""
        import math
        self.check_clock()
        if not math.isfinite(maximum) or maximum < 0:
            raise ValueError("A reservation must be a finite nonnegative amount.")
        with self._cost_lock:
            total = self.used_cost_usd + self.reserved_cost_usd + maximum
            if self.max_cost_usd is None or total > self.max_cost_usd:
                raise BudgetExceeded("cost", self.max_cost_usd or 0, total)
            if self.cost_observer:
                observer = self.cost_observer
                if task and hasattr(observer, "for_call"):
                    observer = observer.for_call(task, model)
                observer(operation_id, maximum, -1)
            self.reserved_cost_usd += maximum

    def reconcile_cost(self, operation_id: str, reserved: float, actual: float) -> None:
        import math
        if not math.isfinite(actual) or actual < 0:
            raise ValueError("Reported cost must be finite and nonnegative.")
        with self._cost_lock:
            if self.cost_observer:
                self.cost_observer(operation_id, reserved, actual)
            self.reserved_cost_usd = max(0.0, self.reserved_cost_usd - reserved)
            self.used_cost_usd += actual
        if self.max_cost_usd is not None and self.used_cost_usd + self.reserved_cost_usd > self.max_cost_usd:
            raise BudgetExceeded("cost", self.max_cost_usd, self.used_cost_usd + self.reserved_cost_usd)

    # ---------------------------------------------------------- degradations

    def may_revise(self, slide_id: str | None) -> bool:
        """Whether the Critic may send this slide back again.

        Returning False is the Critic-disagreement fallback (gap register doc 03
        S3): the run accepts the best candidate it has and attaches the
        unresolved issues to the slide, rather than looping until a budget
        somewhere else kills it. A user can see and act on an attached issue; they
        cannot act on a run that never finished.
        """
        if self.revisions_this_run >= self.max_revisions_per_run:
            self.warn(
                "The Critic asked for more revisions than this run allows; "
                "the best version so far was kept and the remaining issues are "
                "attached to the slides."
            )
            return False

        if slide_id is not None:
            used = self.revisions_by_slide.get(slide_id, 0)
            if used >= self.max_revisions_per_slide:
                self.warn(
                    f"Slide {slide_id} was revised {used} times without agreement; "
                    "the highest-scoring version was kept."
                )
                return False

        return True

    def record_revision(self, slide_id: str | None) -> None:
        self.revisions_this_run += 1
        if slide_id is not None:
            self.revisions_by_slide[slide_id] = self.revisions_by_slide.get(slide_id, 0) + 1

    def warn(self, message: str) -> None:
        """Deduplicated: a loop that warns per iteration produces a wall of noise."""
        if message not in self.warnings:
            self.warnings.append(message)

    # ------------------------------------------------------------- reporting

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started_at

    def report(self) -> dict[str, object]:
        return {
            "used_tokens": self.used_tokens,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "structured_requests": [dict(request) for request in self.structured_requests],
            "max_total_tokens": self.max_total_tokens,
            "revisions": self.revisions_this_run,
            "max_revisions": self.max_revisions_per_run,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "startup_seconds": round(self.startup_seconds, 2),
            "used_cost_usd": self.used_cost_usd,
            "reserved_cost_usd": self.reserved_cost_usd,
            "max_cost_usd": self.max_cost_usd,
            "warnings": list(self.warnings),
        }
