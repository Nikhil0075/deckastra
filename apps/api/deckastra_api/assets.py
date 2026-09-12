"""The asset lifecycle (gap register doc 05 S2).

The gap: `assets` had no soft delete, no reference counting, no orphan cleanup
and no quota. Generated images accumulated forever, and deleting a slide silently
orphaned its uploads — the file stayed on disk, invisible, counting against
nothing and reachable by nobody.

The model here turns on one observation: **an asset outlives the slide that used
it.** Version history is the product's promise, so a deck's third version can
still cite an image its fifth version deleted, and an undo has to bring the
picture back. Cascade-deleting on slide removal would break both.

So:

- **References are counted from the documents, not incremented on edit.** An
  increment missed once is wrong forever; a recount is right every time it runs.
  It is the same argument the reference count itself makes against a foreign key.
- **Zero references is a candidate, not a corpse.** Reaching zero starts a clock.
  Only the sweeper removes bytes, and only after the grace period, so an undo
  inside that window finds the file where it left it.
- **Storage is recounted, never accumulated.** `used_storage_bytes` is derived
  from the live assets, for the same reason.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import quotas, store
from .db.models import Asset, Presentation, PresentationVersion, Project, Workspace
from .ids import new_id
from .db.session import supports_row_locks

logger = logging.getLogger("deckastra.assets")

#: How long an unreferenced asset survives before the sweeper removes it.
#:
#: Long enough that a user who deleted a slide on Friday and undid it on Monday
#: still has their picture. Short enough that a workspace's storage reflects what
#: is actually in use rather than everything ever uploaded.
ORPHAN_GRACE_DAYS = 30

KINDS = ("image", "video", "audio", "font", "document")


class AssetError(RuntimeError):
    """An asset operation that cannot proceed, with a reason a user can read."""


@dataclass
class SweepResult:
    scanned: int
    deleted: list[str]
    reclaimed_bytes: int


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def register(
    session: Session,
    *,
    workspace_id: str,
    created_by: str,
    storage_key: str,
    kind: str = "image",
    filename: str | None = None,
    content_type: str | None = None,
    size_bytes: int = 0,
    width: int | None = None,
    height: int | None = None,
) -> Asset:
    """Record a file the workspace now owns.

    The quota is checked *before* the row exists, so a workspace at its limit
    never has an asset it is not allowed to keep. Registering first and checking
    after would leave the caller holding a row it has to remember to delete.
    """
    if kind not in KINDS:
        raise AssetError(f"{kind!r} is not an asset kind. Choose from: {', '.join(KINDS)}.")

    # Serialize quota decisions per workspace. Two completion requests that each
    # fit alone must not both pass against the same stale used byte count.
    #
    # The lock is real on PostgreSQL and absent on SQLite, where SQLAlchemy drops
    # the clause. A desktop install is unmetered and single-process, so there is
    # nothing to serialise; branching says that rather than letting the clause
    # read as protection it does not provide.
    locked = select(Workspace).where(Workspace.id == workspace_id)
    if supports_row_locks(session):
        locked = locked.with_for_update()
    workspace = session.execute(locked).scalar_one_or_none()
    if workspace is None:
        raise AssetError("No such workspace.")
    quotas.recount_storage(session, workspace_id)
    quotas.check_storage(session, workspace_id, size_bytes)

    asset = Asset(
        id=new_id("ast"),
        workspace_id=workspace_id,
        created_by=created_by,
        kind=kind,
        # Opaque (doc 05 §24). A canonical document carries this, never a signed
        # URL — those are minted at render time and expire.
        storage_key=storage_key,
        filename=filename,
        content_type=content_type,
        bytes=max(0, size_bytes),
        width=width,
        height=height,
        reference_count=0,
    )
    session.add(asset)
    session.flush()

    quotas.recount_storage(session, workspace_id)
    return asset


def referenced_ids(document: dict[str, Any]) -> set[str]:
    """Every asset a document cites.

    Walks the whole document rather than only `document["assets"]`, because the
    manifest is a convenience and the elements are the truth. A background image
    added by a patch that forgot to update the manifest is still a reference, and
    an asset swept because the manifest was stale is a picture that vanishes from
    a deck nobody edited.
    """
    found: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, inner in value.items():
                if key in ("assetId", "asset_id") and isinstance(inner, str):
                    found.add(inner)
                elif key == "id" and value.get("storageKey") and isinstance(inner, str):
                    # An entry in the document's own asset manifest.
                    found.add(inner)
                else:
                    walk(inner)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(document)
    return found


def recount_references(session: Session, workspace_id: str) -> int:
    """Count references in every retained version, including operation-only history.

    Reuse the store's authoritative replay instead of scanning patch values:
    patches may remove or indirectly introduce references. Corrupt history must
    abort the recount, never authorize deletion from an incomplete result.
    """
    live: dict[str, int] = {}
    versions = session.execute(
        select(PresentationVersion)
        .join(Presentation, Presentation.id == PresentationVersion.presentation_id)
        .join(Project, Project.id == Presentation.project_id)
        .where(Project.workspace_id == workspace_id)
    ).scalars()

    for version in versions:
        document = version.snapshot_json
        if document is None:
            document = store.load_presentation(
                session, version.presentation_id, at_version=version.id
            ).document
        for asset_id in referenced_ids(document):
            live[asset_id] = live.get(asset_id, 0) + 1

    changed = 0
    for asset in session.query(Asset).filter(Asset.workspace_id == workspace_id).all():
        count = live.get(asset.id, 0)
        if asset.reference_count != count:
            asset.reference_count = count
            changed += 1

    session.flush()
    return changed


def soft_delete(session: Session, asset: Asset) -> Asset:
    """Mark an asset for removal without removing it.

    A user who deletes a slide and undoes it expects the picture back, and the
    only way to give it to them is to still have it. The bytes go when the
    sweeper runs, not when the button is clicked.
    """
    if asset.deleted_at is None:
        asset.deleted_at = _now()
        session.flush()
        quotas.recount_storage(session, asset.workspace_id)
    return asset


def restore(session: Session, asset: Asset) -> Asset:
    """Undo a soft delete, if the sweeper has not been past."""
    asset.deleted_at = None
    session.flush()
    quotas.recount_storage(session, asset.workspace_id)
    return asset


def sweep(
    session: Session,
    workspace_id: str,
    *,
    grace_days: int = ORPHAN_GRACE_DAYS,
    remove: Callable[[str], None] | None = None,
    dry_run: bool = False,
) -> SweepResult:
    """Remove assets nothing has referenced for the grace period.

    `dry_run` is the default posture for anything that deletes user data by
    inference. The counting is the interesting part and it is worth being able to
    look at the answer before acting on it.

    `remove` is the hook for actually deleting bytes from storage — injected
    rather than imported, because this module should not know whether storage is
    a directory, S3, or a test double.
    """
    recount_references(session, workspace_id)
    cutoff = _now() - timedelta(days=grace_days)

    candidates = [
        asset
        for asset in session.query(Asset)
        .filter(Asset.workspace_id == workspace_id, Asset.reference_count == 0)
        .all()
        # Unreferenced *and* old enough. An asset uploaded a minute ago has a
        # reference count of zero because the user has not placed it yet.
        if _aware(asset.created_at) <= cutoff
        and (asset.deleted_at is None or _aware(asset.deleted_at) <= cutoff)
    ]

    result = SweepResult(scanned=len(candidates), deleted=[], reclaimed_bytes=0)
    if dry_run:
        result.deleted = [asset.id for asset in candidates]
        result.reclaimed_bytes = sum(asset.bytes or 0 for asset in candidates)
        return result

    for asset in candidates:
        if remove is not None:
            try:
                # Bytes first for this one object. If it fails, retain the row so
                # the next sweep can retry and no cleanup failure is forgotten.
                remove(asset.storage_key)
            except Exception:
                logger.exception("Could not remove asset bytes for %s; retained for retry", asset.id)
                continue
        result.deleted.append(asset.id)
        result.reclaimed_bytes += asset.bytes or 0
        session.delete(asset)

    session.flush()
    quotas.recount_storage(session, workspace_id)

    if result.deleted:
        logger.info("Swept %d asset(s) from %s", len(result.deleted), workspace_id)

    return result


def describe(asset: Asset) -> dict[str, Any]:
    return {
        "id": asset.id,
        "kind": asset.kind,
        "filename": asset.filename,
        "content_type": asset.content_type,
        "bytes": asset.bytes,
        "width": asset.width,
        "height": asset.height,
        "reference_count": asset.reference_count,
        "deleted_at": asset.deleted_at.isoformat() if asset.deleted_at else None,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
        # Not the storage key. It is opaque, but it is also a path into a
        # bucket, and a list endpoint has no reason to hand it out.
    }
