"""A backup is one moment, not one directory copy (final package review, item 14).

`local_server` has always said "everything is derived from one directory, so a
backup is a directory copy". That is true of where the bytes are and false of
*when* they are consistent. Copying a live SQLite file while the app is running
copies whatever the page cache happened to hold; copying the database and then
the assets as separate walks gives different moments, and the seam between them
is exactly where a deck ends up citing an image that is not in the backup.

**The review's correction, and the whole design here: define the boundary.**

- The application database is taken with SQLite's **online backup API**, which
  is a consistent read of a database other connections are still writing. Not a
  file copy.
- The asset files to copy are read **from the snapshot**, never from the live
  database, so the file list and the rows that reference it are the same moment.
- Asset-byte deletion is **held** for the length of the snapshot
  (`deletions_held`), so a file the snapshot references cannot be swept out from
  under it. New uploads are not held: the snapshot does not reference them and
  copying them would only be copying more than was asked for.

What is *not* in a backup, said here rather than discovered later: export
artifacts. An export is a derived file, and its row records an **absolute**
path, so carrying the bytes to another profile would restore rows that point
somewhere the file is not. Re-exporting is a button; a wrong path is a bug
report. `docs/UPGRADING.md` says so where a person will read it.

One process, one lock. `deletions_held` is a `threading.Lock`, which means what
it says on a desktop install — one service process, and SQLite serialises
writers — and means nothing across processes. That is why `snapshot` refuses
anything but SQLite rather than quietly offering a weaker guarantee on a server.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from collections.abc import Iterator
from pathlib import Path

from .db.session import database_url
from .paths import migrations_digest

logger = logging.getLogger(__name__)

#: Bumped when the layout of a backup directory changes. A restore refuses a
#: format it does not know rather than guessing at a newer one.
FORMAT = 1

MANIFEST = "manifest.json"
DATABASE = "deckastra.db"
ASSETS = "assets"


class BackupError(Exception):
    """A backup could not be taken, or could not be trusted enough to restore."""


_gate = threading.Lock()


@contextmanager
def deletions_held() -> Iterator[None]:
    """Hold off deleting stored bytes while a snapshot is being taken.

    Acquired by the sweeper and by the asset-delete route, and by `snapshot`
    itself. A plain mutex: whoever gets there first finishes, and the other
    waits. A sweep is seconds and a snapshot is seconds, so waiting is cheaper
    than the alternative — a backup that references a file the sweeper removed
    between the row being read and the bytes being copied.
    """
    with _gate:
        yield


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def database_path(url: str | None = None) -> Path | None:
    """This install's SQLite file, or None when the database is not SQLite."""
    resolved = url if url is not None else database_url()
    if not resolved.startswith("sqlite"):
        return None
    location = resolved.split("///", 1)[-1] if "///" in resolved else ""
    if not location or location.startswith(":memory:"):
        return None
    return Path(location)


def _copy_database(source: Path, destination: Path) -> None:
    """A consistent copy of a database other connections may be writing.

    `Connection.backup` is SQLite's own online backup: it reads pages under the
    same locking the engine uses, so the copy is a transactionally consistent
    database rather than a snapshot of whatever was flushed. A `shutil.copy`
    here would produce a file that opens and is sometimes wrong, which is worse
    than one that does not open at all.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    read = sqlite3.connect(str(source))
    try:
        write = sqlite3.connect(str(destination))
        try:
            read.backup(write)
        finally:
            write.close()
    finally:
        read.close()


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _snapshot_assets(database: Path) -> list[tuple[str, str, int]]:
    """`(id, storage_key, bytes)` for every asset row **in the snapshot**."""
    connection = sqlite3.connect(str(database))
    try:
        rows = connection.execute("SELECT id, storage_key, bytes FROM assets").fetchall()
    finally:
        connection.close()
    return [(str(row[0]), str(row[1]), int(row[2] or 0)) for row in rows]


def _count(database: Path, table: str) -> int:
    connection = sqlite3.connect(str(database))
    try:
        return int(connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
    except sqlite3.DatabaseError:
        return 0
    finally:
        connection.close()


def snapshot(
    destination: Path,
    *,
    asset_root: Path | None,
    journals: object = None,
    app_version: str | None = None,
) -> dict:
    """Write a consistent backup into `destination`, and return its manifest.

    `journals` is whatever the shell collected from its windows — the editor's
    recovery journals live in browser storage, outside this process and outside
    the data directory, so they can only arrive from the outside. They are
    carried verbatim: the format belongs to the renderer, and a backup that
    parsed it would be a second definition to drift.
    """
    source = database_path()
    if source is None:
        raise BackupError("Backing up is for a local install; this service is not on SQLite.")
    if not source.exists():
        raise BackupError(f"There is no database at {source}.")

    destination = Path(destination)
    if destination.exists() and any(destination.iterdir()):
        raise BackupError("That folder already has something in it. Choose an empty one.")
    destination.mkdir(parents=True, exist_ok=True)

    files: dict[str, dict] = {}
    missing: list[dict] = []

    with deletions_held():
        _copy_database(source, destination / DATABASE)

        # The file list comes from the copy, so rows and bytes are one moment.
        for asset_id, key, recorded in _snapshot_assets(destination / DATABASE):
            for name in (key, f"{key}.meta.json"):
                origin = (asset_root / name) if asset_root else None
                if origin is None or not origin.is_file():
                    # A sidecar `.meta.json` is written beside every local blob,
                    # but an S3-era row has none and its absence is not a loss.
                    if name.endswith(".meta.json"):
                        continue
                    missing.append({"asset_id": asset_id, "storage_key": key, "bytes": recorded})
                    continue
                target = destination / ASSETS / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(origin, target)

    if journals is not None:
        (destination / "journals.json").write_text(json.dumps(journals), encoding="utf8")

    for path in sorted(destination.rglob("*")):
        if path.is_file() and path.name != MANIFEST:
            files[path.relative_to(destination).as_posix()] = {
                "bytes": path.stat().st_size,
                "sha256": _digest(path),
            }

    database_copy = destination / DATABASE
    manifest = {
        "format": FORMAT,
        "created_at": _now(),
        "app_version": app_version,
        "migrations": migrations_digest(),
        "source_database": str(source),
        "counts": {
            "presentations": _count(database_copy, "presentations"),
            "versions": _count(database_copy, "presentation_versions"),
            "assets": _count(database_copy, "assets"),
            "runs": _count(database_copy, "agent_runs"),
        },
        # Named rather than omitted: "this backup has 40 assets" and "this backup
        # has 40 assets, one of whose files was already gone" are different
        # facts, and only one of them is a surprise at restore time.
        "missing_assets": missing,
        "excludes": ["exports"],
        "files": files,
    }
    (destination / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf8")
    return manifest


def verify(source: Path) -> dict:
    """Read a backup's manifest and check it describes what is on disk.

    Every failure here happens **before** a restore touches anything, which is
    the property the review asked for: an incomplete or corrupted backup must
    not be discovered halfway through replacing the live data.
    """
    source = Path(source)
    manifest_path = source / MANIFEST
    if not manifest_path.is_file():
        raise BackupError(f"{source} does not look like a Deckastra backup: there is no {MANIFEST}.")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise BackupError("That backup's manifest could not be read.") from error

    if manifest.get("format") != FORMAT:
        raise BackupError(
            f"That backup was written in format {manifest.get('format')}, and this build reads {FORMAT}."
        )

    files = manifest.get("files")
    if not isinstance(files, dict) or DATABASE not in files:
        raise BackupError("That backup's manifest does not list a database.")

    for name, expected in sorted(files.items()):
        path = source / name
        if not path.is_file():
            raise BackupError(f"That backup is incomplete: {name} is missing.")
        if path.stat().st_size != expected.get("bytes") or _digest(path) != expected.get("sha256"):
            raise BackupError(f"That backup is damaged: {name} is not what the manifest records.")

    # It hashes correctly and it is still worth opening: a file can be a faithful
    # copy of something that was never a database.
    connection = sqlite3.connect(str(source / DATABASE))
    try:
        connection.execute("SELECT count(*) FROM presentations").fetchone()
    except sqlite3.DatabaseError as error:
        raise BackupError("That backup's database cannot be opened.") from error
    finally:
        connection.close()

    return manifest


def restore(source: Path, data_dir: Path) -> dict:
    """Replace this install's data with a backup's. **The service must be stopped.**

    Not a route, and not something the running service can do to itself: the
    database being replaced is the one it has open. The shell stops the service,
    runs this as a one-shot, and starts it again.

    What is replaced is moved aside rather than deleted. A restore is what
    somebody reaches for when something has already gone wrong, and it is the
    worst possible moment to make the previous state unrecoverable.
    """
    manifest = verify(source)
    source = Path(source)
    data_dir = Path(data_dir)

    # A backup written by a *newer* build, refused before anything is replaced
    # rather than after (found while checking the claim in `docs/UPGRADING.md`,
    # 2026-09-20). Restoring one and then failing to migrate it leaves the
    # person's own data in `replaced-…` and an install that will not open —
    # recoverable, because nothing is deleted, but it is a recovery they should
    # not have been put through. Imported here rather than at module scope: this
    # is the one thing in backing up that needs to know about migrations.
    from .local_server import check_schema_supported

    check_schema_supported(source)
    data_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    aside = data_dir / f"replaced-{stamp}"
    aside.mkdir(parents=True, exist_ok=True)

    database = data_dir / DATABASE
    for existing in (database, data_dir / ASSETS):
        if existing.exists():
            shutil.move(str(existing), str(aside / existing.name))
    # SQLite's sidecars belong to the database that was moved, and a `-wal` left
    # beside a restored file is a journal for a database that is no longer there.
    for stray in data_dir.glob(f"{DATABASE}*-*"):
        if stray.is_file():
            shutil.move(str(stray), str(aside / stray.name))

    shutil.copy2(source / DATABASE, database)
    if (source / ASSETS).is_dir():
        shutil.copytree(source / ASSETS, data_dir / ASSETS, dirs_exist_ok=True)

    journals = None
    if (source / "journals.json").is_file():
        try:
            journals = json.loads((source / "journals.json").read_text(encoding="utf8"))
        except ValueError:
            # The decks are already back. A journal that cannot be parsed costs
            # the unsaved edits it held, not the restore.
            logger.warning("The backup's recovery journals could not be read.")

    return {"manifest": manifest, "replaced": str(aside), "journals": journals}
