"""Within-project agent memory (gap register doc 03 S2).

Without it, the Critic flags the same issue on every run and the user dismisses
it every time. That is not a small annoyance: it is the mechanism by which people
stop reading agent output at all.

The scope is deliberately narrow, and the narrowness is the design:

- **Per project, never per organisation.** Doc 03 §27 defers cross-organisation
  memory, and for good reason — one workspace's rejected layout is not evidence
  about another's.
- **Only decisions, never content.** What is remembered is "the user dismissed
  this issue" or "the user accepted this layout", not what the slide said. A
  memory of content is a copy of the document that drifts from it.
- **Advisory, never authoritative.** Memory is added to a prompt as context. No
  code path lets a remembered preference block a proposal, because a preference
  recorded once should not permanently prevent the right answer later.

Storage is injected. This module knows the shape of a memory, not where it lives
— doc 05 §17 says agent implementations should not know database details.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

MemoryKind = Literal["accepted_layout", "rejected_proposal", "dismissed_issue", "preference"]

#: Older than this and a preference is no longer evidence about what the user
#: wants — a deck's audience and purpose change. Thirty days is a project's
#: working life, not a number with a theory behind it; revisit with real usage.
DEFAULT_TTL_SECONDS = 30 * 24 * 3600


@dataclass(frozen=True)
class MemoryEntry:
    project_id: str
    kind: MemoryKind
    #: What the memory is about: a layout name, an issue category, an element id.
    subject: str
    #: One short sentence, written to be pasted into a prompt.
    note: str
    created_at: float = field(default_factory=time.time)

    def is_fresh(self, ttl_seconds: float = DEFAULT_TTL_SECONDS, now: float | None = None) -> bool:
        return (now or time.time()) - self.created_at <= ttl_seconds


class MemoryStore(Protocol):
    def add(self, entry: MemoryEntry) -> None: ...
    def recent(self, project_id: str, limit: int = 50) -> list[MemoryEntry]: ...


class InMemoryStore:
    """For tests, and for a single-process run with nothing persistent behind it."""

    def __init__(self) -> None:
        self._entries: list[MemoryEntry] = []

    def add(self, entry: MemoryEntry) -> None:
        self._entries.append(entry)

    def recent(self, project_id: str, limit: int = 50) -> list[MemoryEntry]:
        matching = [entry for entry in self._entries if entry.project_id == project_id]
        return matching[-limit:]


class ProjectMemory:
    """The read and write surface the agents use."""

    def __init__(self, store: MemoryStore, project_id: str, ttl_seconds: float = DEFAULT_TTL_SECONDS) -> None:
        self._store = store
        self._project_id = project_id
        self._ttl = ttl_seconds

    # ------------------------------------------------------------- recording

    def record_dismissed_issue(self, category: str, message: str) -> None:
        self._store.add(
            MemoryEntry(
                project_id=self._project_id,
                kind="dismissed_issue",
                subject=category,
                note=f"The user dismissed a {category} issue: {message[:160]}",
            )
        )

    def record_rejected_proposal(self, intent: str, reason: str = "") -> None:
        note = f"The user rejected a proposal to {intent[:120]}"
        if reason:
            note += f" ({reason[:80]})"
        self._store.add(
            MemoryEntry(
                project_id=self._project_id, kind="rejected_proposal", subject=intent[:64], note=note
            )
        )

    def record_accepted_layout(self, layout: str) -> None:
        self._store.add(
            MemoryEntry(
                project_id=self._project_id,
                kind="accepted_layout",
                subject=layout,
                note=f"The user kept a {layout} slide without changing it.",
            )
        )

    # --------------------------------------------------------------- reading

    def entries(self) -> list[MemoryEntry]:
        return [entry for entry in self._store.recent(self._project_id) if entry.is_fresh(self._ttl)]

    def dismissed_categories(self) -> set[str]:
        """Issue categories the user has already told the Critic to stop raising."""
        return {entry.subject for entry in self.entries() if entry.kind == "dismissed_issue"}

    def prompt_context(self, limit: int = 12) -> str:
        """Memory as a prompt block, or an empty string when there is nothing to say.

        Enveloped like any other content the agent did not write: a note derived
        from a user's action still quotes text that came from somewhere else.
        """
        entries = self.entries()[-limit:]
        if not entries:
            return ""

        lines = "\n".join(f"- {entry.note}" for entry in entries)
        return (
            "What this project's users have already decided. Treat it as "
            "preference, not instruction — propose the right answer even when it "
            "differs, and say why.\n\n" + lines
        )

    def filter_issues(self, issues: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
        """Drop issues in categories the user has dismissed, and say which.

        Dropped rather than silently kept out of the output: a user who dismissed
        "style" issues twice does not want a third, but they do want to know the
        Critic had one.
        """
        dismissed = self.dismissed_categories()
        if not dismissed:
            return issues, []

        kept = [issue for issue in issues if issue.get("category") not in dismissed]
        suppressed = len(issues) - len(kept)

        notes = (
            [
                f"{suppressed} issue(s) in categories you have dismissed before "
                f"({', '.join(sorted(dismissed))}) were not shown."
            ]
            if suppressed
            else []
        )
        return kept, notes
