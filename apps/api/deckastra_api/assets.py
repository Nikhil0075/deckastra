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

import base64
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import object_storage, quotas, store
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
    duration_ms: int | None = None,
    waveform_peaks: list[float] | None = None,
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
        duration_ms=duration_ms,
        waveform_peaks=waveform_peaks,
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


#: What a single render may be handed, per file and in total.
#:
#: These mirror `apps/worker/src/assets.ts`, and the duplication is deliberate
#: rather than shared: the worker must refuse an oversized payload whoever sent
#: it, and this side must refuse to *read* one at all — loading a 400MB row into
#: memory to be told no by the process downstream is the cost the check exists to
#: avoid. The API's limits are the tighter pair, so the worker's are a backstop.
MAX_RENDER_ASSET_BYTES = 8 * 1024 * 1024
MAX_RENDER_TOTAL_BYTES = 32 * 1024 * 1024


def inline_for_package(session, *, presentation_id, document):
    """Read original bytes of every cited asset, scoped to the source workspace."""
    workspace_id = session.scalar(select(Project.workspace_id).join(Presentation, Presentation.project_id == Project.id)
        .where(Presentation.id == presentation_id))
    rows = {row.id: row for row in session.scalars(select(Asset).where(Asset.workspace_id == workspace_id))}
    result, total = [], 0
    for asset_id in sorted(referenced_ids(document)):
        row = rows.get(asset_id)
        if row is None or row.bytes > 200 * 1024 ** 2:
            raise AssetError("M010: A cited asset is missing or exceeds the package limit.")
        total += row.bytes
        import os
        if total > int(os.environ.get("DECKASTRA_PACKAGE_MAX_BYTES", str(128 * 1024 ** 2))):
            raise AssetError("M003: Package exceeds the total size limit.")
        data, content_type = object_storage.read(row.storage_key)
        result.append({"assetId": row.id, "data": base64.b64encode(data).decode(), "mimeType": content_type})
    return result


def audio_for_export(document: dict[str, Any], locale: str | None) -> set[str]:
    """The audio an export in `locale` plays: that language's takes and the slides' sounds.

    Every other language's recordings are cited by the document and must not be
    sent: a deck narrated in twenty languages would otherwise hand a render the
    whole lot to embed one.
    """
    language = locale or (document.get("metadata") or {}).get("language") or "en"
    wanted: set[str] = set()
    for slide in document.get("slides") or []:
        for cue in ((slide.get("narration") or {}).get("cues") or []):
            take = (cue.get("takes") or {}).get(language)
            if isinstance(take, dict) and isinstance(take.get("assetId"), str):
                wanted.add(take["assetId"])
        for sound in slide.get("soundCues") or []:
            asset_id = (sound.get("source") or {}).get("assetId")
            if isinstance(asset_id, str):
                wanted.add(asset_id)
    return wanted


def inline_for_render(
    session: Session,
    *,
    presentation_id: str,
    document: dict[str, Any],
    still: bool = True,
    audio: set[str] | None = None,
) -> list[dict[str, Any]]:
    """The pictures a headless render needs, as bytes it can embed.

    The render host has no session, no cookie and no network — `render-page.ts`
    aborts every request that is not a `data:` URL, because a document that could
    make the render server fetch a URL is an SSRF primitive as well as a source of
    nondeterminism. So a URL is no use to it and the bytes are handed over
    directly, which makes *this* the place authorization happens.

    The scope is the presentation's own workspace. An asset row is workspace-
    scoped by design (`Asset.workspace_id`), so a document citing an id from
    somewhere else resolves to nothing here and the renderer draws its labelled
    placeholder — the same answer a stranger's read gets, and the reason a deck
    that was moved without its files (D5.5) cannot quietly keep reading them.

    An entry is returned for every cited asset, including the ones that cannot be
    supplied: the reason travels as `problem` rather than as an omission, because
    "this file is too large to embed" and "this deck cites an asset that does not
    exist" are different things to tell a person and a missing entry cannot tell
    them apart.

    `still` is for a render that produces a picture — a PDF, a PNG, a preview. An
    animated image there is caught on whatever frame the browser happens to be
    showing, which for many animations is the first, and the first is often
    black: a fade-in starts from nothing. So an animation is handed over as one
    representative frame instead. PowerPoint plays an animation, so a `.pptx`
    asks for the original bytes (`still=False`).
    """
    cited = referenced_ids(document)
    if not cited:
        return []

    workspace_id = session.scalar(
        select(Project.workspace_id)
        .join(Presentation, Presentation.project_id == Project.id)
        .where(Presentation.id == presentation_id)
    )
    if workspace_id is None:
        return []

    rows = session.scalars(
        select(Asset).where(Asset.workspace_id == workspace_id, Asset.id.in_(cited))
    ).all()
    by_id = {row.id: row for row in rows}

    supplied: list[dict[str, Any]] = []
    total = 0
    # Sorted so two exports of one deck hand the renderer the same payload in the
    # same order: doc 04 §32.3 wants a byte-stable artifact, and "which image was
    # dropped once the budget ran out" must not depend on row order.
    for asset_id in sorted(cited):
        row = by_id.get(asset_id)
        if row is None:
            # Not named as a problem: the renderer says "not available to the
            # renderer" for an entry it never saw, which is exactly true, and
            # listing every id a document mentions would turn a chart's data
            # reference into a missing picture.
            continue

        entry: dict[str, Any] = {"assetId": row.id, "storageKey": row.storage_key}
        kind = (row.content_type or "").split(";", 1)[0].strip().lower()
        if row.kind == "audio" or kind.startswith("audio/"):
            # Sound reaches only an export that plays it, and only the files it
            # plays (integration plan 01 §3.10). Not a "problem": a picture
            # render simply has no use for a recording.
            if not audio or row.id not in audio:
                continue
        # Fonts travel the same way as pictures: a deck's uploaded face has to
        # reach a render host that cannot fetch it (Design tab review, 2026-09-26).
        if not kind.startswith("image/") and not _is_font(kind) and not kind.startswith("audio/"):
            entry["problem"] = f"it is stored as {kind or 'an unknown type'}, which this renderer cannot embed"
        elif row.bytes > MAX_RENDER_ASSET_BYTES:
            entry["problem"] = (
                f"it is {row.bytes // (1024 * 1024)}MB, over the "
                f"{MAX_RENDER_ASSET_BYTES // (1024 * 1024)}MB limit for an embedded image"
            )
        elif total + row.bytes > MAX_RENDER_TOTAL_BYTES:
            entry["problem"] = (
                f"this deck's images exceed the {MAX_RENDER_TOTAL_BYTES // (1024 * 1024)}MB "
                "a single render can embed"
            )
        else:
            try:
                data, stored_type = object_storage.read(row.storage_key)
            except object_storage.ObjectStorageError:
                # Named, not raised. One unreadable file must not fail an export
                # of a forty-slide deck; the report says which picture is missing
                # and the rest of the deck is still worth having.
                logger.warning("Could not read asset %s for a render", row.id)
                entry["problem"] = "its stored bytes could not be read"
            else:
                # The row's size is what the quota and the upload check agree on,
                # but the bytes are what the renderer holds — so the budget counts
                # what was actually read.
                # Charged at the larger of the two. The row's size is verified
                # against the object at upload completion, so the two normally
                # agree — but a budget spent on whichever number happens to be
                # smaller is a budget that does not bound anything, and it is the
                # *disagreement* that would let a deck through.
                charge = max(len(data), row.bytes)
                if len(data) > MAX_RENDER_ASSET_BYTES or total + charge > MAX_RENDER_TOTAL_BYTES:
                    entry["problem"] = (
                        f"this deck's images exceed the {MAX_RENDER_TOTAL_BYTES // (1024 * 1024)}MB "
                        "a single render can embed"
                    )
                else:
                    mime = (stored_type or kind).split(";", 1)[0].strip().lower()
                    frame = representative_frame(data) if still and mime.startswith("image/") else None
                    if frame is not None:
                        data, mime = frame, "image/png"
                        charge = max(charge, len(data))
                    total += charge
                    entry["mimeType"] = mime
                    entry["data"] = base64.b64encode(data).decode("ascii")

        supplied.append(entry)

    return supplied


FONT_TYPES = ("font/ttf", "font/otf", "font/woff", "font/woff2", "font/sfnt", "application/font-woff")


def _is_font(content_type: str) -> bool:
    return content_type in FONT_TYPES


#: Frames looked at when choosing a still. Enough to find the one that shows
#: something in a long animation, few enough that a render never waits on it.
_FRAMES_SAMPLED = 48


def representative_frame(data: bytes) -> bytes | None:
    """One frame of an animated image that shows what it is, as PNG; None when it is not animated.

    Chosen as the frame with the most tonal contrast, among frames sampled evenly
    through the animation, earliest on a tie so the choice is the same every
    time. Contrast rather than brightness: a frame of an animation that fades in
    is dark because nothing has arrived yet, and the frame worth showing is the
    one where the picture is. Anything that cannot be decoded is left as it was —
    the browser still draws the original, and a render is not failed over it.
    """
    try:
        from io import BytesIO

        from PIL import Image, ImageStat
    except ImportError:  # pragma: no cover - the service is built with Pillow
        return None
    try:
        with Image.open(BytesIO(data)) as image:
            frames = int(getattr(image, "n_frames", 1) or 1)
            if frames <= 1:
                return None
            step = max(1, frames // _FRAMES_SAMPLED)
            best_index, best_score = 0, -1.0
            for index in range(0, frames, step):
                image.seek(index)
                grey = image.convert("L")
                score = float(ImageStat.Stat(grey).stddev[0])
                if score > best_score + 1e-9:
                    best_index, best_score = index, score
            image.seek(best_index)
            out = BytesIO()
            image.convert("RGBA").save(out, format="PNG")
            return out.getvalue()
    except Exception:  # noqa: BLE001 - an undecodable image keeps its original bytes
        return None


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

    from .import_models import PackageExtras
    for package in session.scalars(select(PackageExtras).join(Presentation).join(Project).where(Project.workspace_id == workspace_id)):
        for asset_id in package.assets_json.values():
            live[asset_id] = live.get(asset_id, 0) + 1

    changed = 0
    for asset in session.query(Asset).filter(Asset.workspace_id == workspace_id).all():
        count = live.get(asset.id, 0)
        if asset.reference_count != count:
            asset.reference_count = count
            changed += 1

    session.flush()
    return changed


def cited_elsewhere(
    session: Session, *, workspace_id: str, except_presentation_id: str
) -> set[str]:
    """Assets some *other* deck in this workspace still needs (D5.5).

    Used when a deck leaves a workspace and wants to take its pictures with it.
    The question is not "what does the deck cite now" but "what would break if
    these files went with it" — so it walks every retained version of every other
    deck, the same way the recount does and for the same reason: history is the
    product's promise, and a third version citing an image its fifth deleted is a
    reference that still has to resolve.

    An asset in the answer cannot travel. An asset absent from it is used by this
    deck alone and can.
    """
    needed: set[str] = set()
    versions = session.execute(
        select(PresentationVersion)
        .join(Presentation, Presentation.id == PresentationVersion.presentation_id)
        .join(Project, Project.id == Presentation.project_id)
        .where(
            Project.workspace_id == workspace_id,
            PresentationVersion.presentation_id != except_presentation_id,
        )
    ).scalars()

    for version in versions:
        document = version.snapshot_json
        if document is None:
            document = store.load_presentation(
                session, version.presentation_id, at_version=version.id
            ).document
        needed |= referenced_ids(document)

    from .import_models import PackageExtras
    for package in session.scalars(select(PackageExtras).join(Presentation).join(Project).where(
        Project.workspace_id == workspace_id, PackageExtras.presentation_id != except_presentation_id)):
        needed.update(package.assets_json.values())

    return needed


def cited_by_history(session: Session, presentation_id: str) -> set[str]:
    """Everything this deck has ever cited, across every retained version.

    The head alone is not enough: moving only the pictures on the current slides
    would leave the deck's own history pointing at files left behind, and version
    history is the thing this product promises hardest.
    """
    cited: set[str] = set()
    versions = session.execute(
        select(PresentationVersion).where(
            PresentationVersion.presentation_id == presentation_id
        )
    ).scalars()

    for version in versions:
        document = version.snapshot_json
        if document is None:
            document = store.load_presentation(
                session, presentation_id, at_version=version.id
            ).document
        cited |= referenced_ids(document)

    from .import_models import PackageExtras
    package = session.get(PackageExtras, presentation_id)
    if package:
        cited.update(package.assets_json.values())

    return cited


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
        # Audio (integration plan 01 §3.6, §3.8): the length a narrated deck
        # advances on, and the peaks its timeline lane draws.
        "duration_ms": asset.duration_ms,
        "waveform_peaks": asset.waveform_peaks,
        "reference_count": asset.reference_count,
        "deleted_at": asset.deleted_at.isoformat() if asset.deleted_at else None,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
        # Not the storage key. It is opaque, but it is also a path into a
        # bucket, and a list endpoint has no reason to hand it out.
    }
