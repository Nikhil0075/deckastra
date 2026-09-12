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
from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    """A hard ceiling was hit. Carries what the run produced up to that point."""

    def __init__(self, budget: str, limit: float, used: float) -> None:
        super().__init__(
            f"The {budget} budget is exhausted ({used:.0f} of {limit:.0f}). "
            "The run stopped here; what it produced so far is kept."
        )
        self.budget = budget
        self.limit = limit
        self.used = used


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

    # ------------------------------------------------------------- hard stops

    def spend_tokens(self, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.used_tokens += input_tokens + output_tokens
        if self.used_tokens > self.max_total_tokens:
            raise BudgetExceeded("token", self.max_total_tokens, self.used_tokens)

    def check_clock(self) -> None:
        elapsed = time.monotonic() - self.started_at
        if elapsed > self.max_wall_clock_seconds:
            raise BudgetExceeded("time", self.max_wall_clock_seconds, elapsed)

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
            "warnings": list(self.warnings),
        }
