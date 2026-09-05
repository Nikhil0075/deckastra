"""What a workspace is allowed to spend (gap register doc 01 S3).

Phase 5's `RunBudget` enforces per-run ceilings: a token limit, a wall clock, a
revision count. Those stop *one* runaway generation and do nothing about a
hundred ordinary ones, which is the shape the cost actually takes — model spend
is the dominant variable cost of this product, and doc 03's budget work and doc
04 §45.4's rate limits both need something to reference.

Three decisions worth stating.

**The reset is lazy.** The first request of a new period rolls the counters,
rather than a scheduled job doing it. A cron that misses a month silently locks
every workspace out of the product, and the failure looks like a bug in
generation rather than in scheduling.

**Refusal comes before the work, accounting after it.** Checking after would mean
paying for the request that broke the limit; reserving before would mean holding
a reservation through a crash. Charging what was actually spent, once the run
reports it, is the honest middle — a workspace can overshoot by at most one run.

**Null is unlimited, and it is not zero.** A plan with no ceiling and a plan that
allows nothing are different things, and a single integer cannot say both.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from .db.models import Asset, Repository, WorkspaceQuota

#: The plans, as data. A table rather than branching code, because the question
#: "what does free actually include" should be answerable by reading one thing.
PLANS: dict[str, dict[str, int | None]] = {
    "free": {
        "monthly_generations": 30,
        "monthly_tokens": 2_000_000,
        "storage_bytes": 500 * 1024 * 1024,
        "max_repositories": 1,
    },
    "pro": {
        "monthly_generations": 500,
        "monthly_tokens": 50_000_000,
        "storage_bytes": 20 * 1024 * 1024 * 1024,
        "max_repositories": 20,
    },
    "unlimited": {
        # For self-hosting and for the development database. Explicitly a plan
        # rather than a missing row, so "no limits" is a decision someone made.
        "monthly_generations": None,
        "monthly_tokens": None,
        "storage_bytes": None,
        "max_repositories": None,
    },
}

#: A month, as this product counts one. Calendar months would make a workspace
#: created on the 31st a different customer from one created on the 1st.
PERIOD_DAYS = 30


class QuotaExceeded(RuntimeError):
    """A limit reached, with what to do about it.

    Carries the numbers because "quota exceeded" is not actionable and
    "30 of 30 generations this month, resets on the 14th" is.
    """

    def __init__(self, message: str, *, limit: str, used: int, allowed: int, resets_at: str) -> None:
        super().__init__(message)
        self.limit = limit
        self.used = used
        self.allowed = allowed
        self.resets_at = resets_at

    def as_detail(self) -> dict[str, Any]:
        return {
            "message": str(self),
            "limit": self.limit,
            "used": self.used,
            "allowed": self.allowed,
            "resets_at": self.resets_at,
        }


@dataclass(frozen=True)
class Usage:
    """A workspace's standing, as the UI shows it."""

    plan: str
    generations: tuple[int, int | None]
    tokens: tuple[int, int | None]
    storage_bytes: tuple[int, int | None]
    repositories: tuple[int, int | None]
    resets_at: datetime

    def as_dict(self) -> dict[str, Any]:
        def pair(used: int, allowed: int | None) -> dict[str, Any]:
            return {
                "used": used,
                "allowed": allowed,
                # Null when unlimited rather than 0 or 1: a progress bar against
                # no limit is a bar that means nothing.
                "fraction": None if allowed in (None, 0) else round(used / allowed, 4),
            }

        return {
            "plan": self.plan,
            "generations": pair(*self.generations),
            "tokens": pair(*self.tokens),
            "storage_bytes": pair(*self.storage_bytes),
            "repositories": pair(*self.repositories),
            "resets_at": self.resets_at.isoformat(),
        }


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; Postgres does not.

    Comparing a naive to an aware one raises, and the raise happens on the quota
    check — so a development database would break generation in a way production
    never shows.
    """
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def ensure(session: Session, workspace_id: str, *, plan: str = "free") -> WorkspaceQuota:
    """The workspace's quota row, created and rolled forward as needed.

    Every entry point calls this rather than querying directly, so there is one
    place the period can roll and one place a missing row is created. A quota
    that only exists once someone visited a settings page is a quota half the
    workspaces do not have.
    """
    quota = session.get(WorkspaceQuota, workspace_id)

    if quota is None:
        limits = PLANS.get(plan, PLANS["free"])
        quota = WorkspaceQuota(
            workspace_id=workspace_id,
            plan=plan,
            period_start=_now(),
            **limits,
        )
        session.add(quota)
        session.flush()
        return quota

    if _aware(quota.period_start) + timedelta(days=PERIOD_DAYS) <= _now():
        # Lazy roll. Storage is deliberately not reset: it is a level, not a
        # flow, and zeroing it would let a workspace exceed its disk allowance by
        # simply waiting.
        quota.period_start = _now()
        quota.used_generations = 0
        quota.used_tokens = 0
        session.flush()

    return quota


def check_generation(session: Session, workspace_id: str) -> WorkspaceQuota:
    """Refuse before the work, not after.

    Checking afterwards means paying for the request that broke the limit.
    """
    quota = ensure(session, workspace_id)

    if quota.monthly_generations is not None and quota.used_generations >= quota.monthly_generations:
        raise QuotaExceeded(
            f"This workspace has used all {quota.monthly_generations} generations in its "
            f"current period. The allowance resets on {_readable(_resets_at(quota))}.",
            limit="generations",
            used=quota.used_generations,
            allowed=quota.monthly_generations,
            resets_at=_resets_at(quota).isoformat(),
        )

    if quota.monthly_tokens is not None and quota.used_tokens >= quota.monthly_tokens:
        raise QuotaExceeded(
            "This workspace has used its token allowance for the current period. "
            f"It resets on {_readable(_resets_at(quota))}.",
            limit="tokens",
            used=quota.used_tokens,
            allowed=quota.monthly_tokens,
            resets_at=_resets_at(quota).isoformat(),
        )

    return quota


def check_repository(session: Session, workspace_id: str) -> WorkspaceQuota:
    quota = ensure(session, workspace_id)
    if quota.max_repositories is None:
        return quota

    connected = (
        session.query(Repository).filter(Repository.workspace_id == workspace_id).count()
    )
    if connected >= quota.max_repositories:
        raise QuotaExceeded(
            f"This workspace can connect {quota.max_repositories} "
            f"repositor{'y' if quota.max_repositories == 1 else 'ies'} on its current plan.",
            limit="repositories",
            used=connected,
            allowed=quota.max_repositories,
            resets_at=_resets_at(quota).isoformat(),
        )
    return quota


def check_storage(session: Session, workspace_id: str, additional_bytes: int) -> WorkspaceQuota:
    quota = ensure(session, workspace_id)
    if quota.storage_bytes is None:
        return quota

    if quota.used_storage_bytes + additional_bytes > quota.storage_bytes:
        raise QuotaExceeded(
            "This upload would take the workspace over its storage allowance.",
            limit="storage_bytes",
            used=quota.used_storage_bytes,
            allowed=quota.storage_bytes,
            resets_at=_resets_at(quota).isoformat(),
        )
    return quota


def record_generation(
    session: Session, workspace_id: str, *, tokens: int = 0
) -> WorkspaceQuota:
    """Charge what was actually spent, once the run has reported it.

    After the fact rather than reserved up front. A reservation has to be
    released, and a crash between reserving and releasing leaves a workspace
    permanently poorer — the cost of the honest version is that a workspace can
    overshoot by at most one run.
    """
    quota = ensure(session, workspace_id)
    quota.used_generations += 1
    quota.used_tokens += max(0, tokens)
    session.flush()
    return quota


def recount_storage(session: Session, workspace_id: str) -> WorkspaceQuota:
    """Recompute storage from the assets themselves.

    Recomputed rather than incremented, for the same reason as an asset's
    reference count: an increment missed once is wrong forever, and the rows are
    the truth.
    """
    quota = ensure(session, workspace_id)

    total = (
        session.query(Asset)
        .filter(Asset.workspace_id == workspace_id, Asset.deleted_at.is_(None))
        .with_entities(Asset.bytes)
        .all()
    )
    quota.used_storage_bytes = sum(row[0] or 0 for row in total)
    session.flush()
    return quota


def usage(session: Session, workspace_id: str) -> Usage:
    quota = ensure(session, workspace_id)
    repositories = (
        session.query(Repository).filter(Repository.workspace_id == workspace_id).count()
    )

    return Usage(
        plan=quota.plan,
        generations=(quota.used_generations, quota.monthly_generations),
        tokens=(quota.used_tokens, quota.monthly_tokens),
        storage_bytes=(quota.used_storage_bytes, quota.storage_bytes),
        repositories=(repositories, quota.max_repositories),
        resets_at=_resets_at(quota),
    )


def set_plan(session: Session, workspace_id: str, plan: str) -> WorkspaceQuota:
    if plan not in PLANS:
        raise ValueError(f"{plan!r} is not a plan. Choose from: {', '.join(PLANS)}.")

    quota = ensure(session, workspace_id)
    quota.plan = plan
    for field, value in PLANS[plan].items():
        setattr(quota, field, value)
    session.flush()
    return quota


def _resets_at(quota: WorkspaceQuota) -> datetime:
    return _aware(quota.period_start) + timedelta(days=PERIOD_DAYS)


def _readable(when: datetime) -> str:
    """A date a person reads, formatted without platform-specific directives.

    `%-d` is a glibc extension and raises on Windows, which would turn a quota
    message into a 500 on exactly the machines most likely to be running the
    development server.
    """
    return f"{when.day} {when:%B}"
