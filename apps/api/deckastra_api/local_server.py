"""The sidecar the desktop app supervises (milestone D1).

`python -m deckastra_api.local_server`. It configures the process for one user on
one machine, migrates the database, seeds the singleton account, and serves the
ordinary API on a loopback port.

The contract with the supervisor is deliberately as narrow as the export
worker's: **one JSON object on stdout, then nothing.** The supervisor reads that
line to learn the port and stops reading; everything after it is log output. A
chattier protocol would mean the supervisor parsing a stream, and a stream is
where a partial line becomes a hang.

    {"ready": true, "port": 51234, "database": "...", "assets": "..."}

Three properties this file exists to guarantee:

- **Loopback only.** Bound to 127.0.0.1, never 0.0.0.0. A service that answers on
  the LAN is a service someone else's laptop can reach, and this one authenticates
  with a single shared secret.
- **Port zero.** The OS picks a free port. A fixed port collides with whatever
  else the user is running and, worse, makes the service predictable to anything
  probing localhost.
- **Everything is derived from one directory.** The database and asset bytes
  live under `--data-dir`. That says where the bytes are and
  **not** that copying them while the app runs is a backup: a live SQLite file
  copied by hand is whatever was flushed, and separate walks give different
  moments. `backup.py` is the supported answer, and `--restore-from`
  below is its other half.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import socket
import sqlite3
import sys
import threading
import time
from pathlib import Path

logger = logging.getLogger("deckastra.local")


def configure_environment(data_dir: Path) -> dict[str, str]:
    """Point every subsystem at this install's directory.

    Set before anything imports the application, because `database_url()` and
    `object_storage.local_root()` read the environment at call time and the first
    call happens during import of the route modules.

    Exports belong here too. Until this was set they went to the system temp
    directory, which broke the promise that a backup is a copy of this one
    directory, and put finished files where the OS's own cleanup may delete them
    while their rows still offer a download.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    assets = data_dir / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    database = data_dir / "deckastra.db"

    settings = {
        "DECKASTRA_LOCAL_MODE": "1",
        # Forward slashes: SQLAlchemy's URL parser treats a backslash as part of
        # the path on every platform, and a Windows path pasted in raw produces a
        # database file with a literal backslash in its name.
        "DATABASE_URL": f"sqlite:///{database.as_posix()}",
        "DECKASTRA_ASSET_DIR": str(assets),
        # `export_service.export_root()` appends `deckastra-exports`, so this is
        # the data directory itself: exports land beside the database and assets.
        "DECKASTRA_EXPORT_DIR": str(data_dir),
    }
    for key, value in settings.items():
        os.environ[key] = value
    return settings


class SchemaFromTheFuture(RuntimeError):
    """This data was written by a build that knows migrations this one does not."""


def _alembic_config():
    from alembic.config import Config

    from .paths import resource_root

    root = resource_root()
    config = Config(str(root / "infrastructure" / "database" / "alembic.ini"))
    config.set_main_option("script_location", str(root / "infrastructure" / "database" / "migrations"))
    return config


def _recorded_revision(database: Path) -> str | None:
    """What revision the database says it is at, without opening the app."""
    import sqlite3

    if not database.is_file():
        return None
    connection = sqlite3.connect(str(database))
    try:
        row = connection.execute("SELECT version_num FROM alembic_version LIMIT 1").fetchone()
    except sqlite3.DatabaseError:
        # No `alembic_version` table: either a fresh file or something that is
        # not one of ours. `upgrade` decides, and says so if it cannot.
        return None
    finally:
        connection.close()
    return str(row[0]) if row else None


def check_schema_supported(data_dir: Path) -> None:
    """Refuse data written by a newer build, rather than migrating it downward
    (final package review, item 15).

    An older binary meeting a newer database is a real case for a product with
    manual upgrades: someone reinstalls the version they still have the
    installer for. Alembic's `upgrade head` handles it by accident — it cannot
    find the recorded revision and raises — but the message is about revision
    identifiers, and the person needs to be told which of the two things to do:
    install the newer version again, or restore a backup.

    It is a **refusal, not a repair**. There is no downgrade path here: the
    older build cannot know what the newer one added, and running its
    migrations against this file would be guessing with someone's decks.
    """
    from alembic.script import ScriptDirectory

    recorded = _recorded_revision(data_dir / "deckastra.db")
    if recorded is None:
        return
    known = {revision.revision for revision in ScriptDirectory.from_config(_alembic_config()).walk_revisions()}
    if recorded not in known:
        raise SchemaFromTheFuture(
            f"This workspace was written by a newer version of Deckastra (database revision {recorded}, "
            "which this version does not know). Install that version again, or restore a backup taken "
            "with this one. Your data has not been changed."
        )


def migrate(data_dir: Path) -> None:
    """Bring the database up to head.

    On launch, every launch. A desktop app has no operator to run migrations, and
    an install that opens against a stale schema fails in whichever route touches
    the new column first — which is the least diagnosable place for it to happen.

    A failure here is deliberately fatal, and that is the property item 15 names:
    a half-migrated database must not go on to `seed()`, because seeding an
    install whose tables are in an unknown state is how a partial upgrade comes
    to open as an empty workspace with someone's decks still on the disk.
    """
    from alembic import command
    from alembic.script import ScriptDirectory

    database = data_dir / "deckastra.db"
    staging = data_dir / "deckastra.db.migrating"
    previous = data_dir / "deckastra.db.pre-migration"
    check_schema_supported(data_dir)

    # A killed SQLite batch migration can leave `_alembic_tmp_*` tables behind.
    # Running against a same-directory staging copy makes the whole upgrade one
    # atomic file replacement: a failure damages only the disposable stage, and
    # the next launch starts from exactly the same profile bytes.
    staging.unlink(missing_ok=True)
    if database.is_file():
        source = sqlite3.connect(str(database))
        target = sqlite3.connect(str(staging))
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
    else:
        sqlite3.connect(str(staging)).close()

    original_url = os.environ.get("DATABASE_URL")
    stage_url = f"sqlite:///{staging.as_posix()}"
    os.environ["DATABASE_URL"] = stage_url
    config = _alembic_config()
    config.set_main_option("sqlalchemy.url", stage_url)
    try:
        command.upgrade(config, "head")

        connection = sqlite3.connect(str(staging))
        try:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            revision = connection.execute("SELECT version_num FROM alembic_version LIMIT 1").fetchone()
        finally:
            connection.close()
        head = ScriptDirectory.from_config(config).get_current_head()
        if integrity != ("ok",) or revision != (head,):
            raise RuntimeError(
                "The migrated workspace did not pass integrity and revision checks; the original was not changed."
            )

        # Flush the completed database before making it the profile's primary
        # file. Keep one pre-migration copy for recovery and diagnostics.
        # Windows rejects fsync on a read-only CRT descriptor; rb+ opens the
        # same completed bytes without changing them and gives fsync a valid
        # descriptor on every supported platform.
        with staging.open("rb+") as completed:
            completed.flush()
            os.fsync(completed.fileno())
        if database.is_file():
            shutil.copy2(database, previous)
        os.replace(staging, database)
    finally:
        if original_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = original_url
        staging.unlink(missing_ok=True)


def startup_progress(stage: str, message: str) -> None:
    """Report startup work without pretending the HTTP service is ready."""
    print(json.dumps({"progress": stage, "message": message}), flush=True)


def start_export_worker() -> threading.Thread:
    """Process export jobs in this process, on a thread.

    The deployed product runs `python -m deckastra_api.export_worker` as its own
    process, so exports scale independently and a crash there does not take the
    API with it. A desktop install has one user and one machine: a second process
    would be a second thing to supervise for no gain, and nothing was starting one
    — which is why a local export sat at `queued` forever, with the editor
    reporting progress that would never arrive.

    A daemon thread, because it is not the app's reason to stay alive. A quit
    during an export loses that export, which the job's own retry handles on the
    next launch; blocking shutdown on a render would be worse.
    """
    from . import export_service
    from .db.session import session_scope

    def loop() -> None:
        worker_id = "local"
        while True:
            try:
                from .mydeck_import import process_one as import_package
                import_package()
                with session_scope() as session:
                    job = export_service.process_one(session, worker_id)
            except Exception:  # noqa: BLE001 - one bad job must not end the loop
                logger.exception("Export worker failed on a job")
                job = None
            if job is None:
                time.sleep(0.25)

    thread = threading.Thread(target=loop, name="deckastra-exports", daemon=True)
    thread.start()
    return thread


def seed(data_dir: Path) -> None:
    """Create the one account, if this is a first launch."""
    from .db.session import session_scope
    from . import local_mode

    with session_scope() as session:
        local_mode.bootstrap(session)


def _listening_socket(port: int) -> socket.socket:
    """Bind and listen *before* announcing, and hand the socket to uvicorn.

    The obvious version — pick a free port, print it, then start uvicorn — has a
    race that is not theoretical: the supervisor connects the moment it reads the
    line, and uvicorn has not bound yet, so the first request is refused rather
    than queued. Binding here closes it. Once `listen()` has returned the kernel
    accepts connections into the backlog, so a request that arrives during
    startup waits instead of failing.
    """
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # No SO_REUSEADDR: on Windows it permits two processes to bind the same port,
    # which is exactly the collision a second instance must not be able to cause.
    server.bind(("127.0.0.1", port))
    server.listen(128)
    server.set_inheritable(True)
    return server


def restore_offline(source: Path, data_dir: Path) -> int:
    """Put a backup back, with the service stopped (item 14).

    A one-shot rather than a route, and the reason is not squeamishness: the
    database a restore replaces is the one the running service holds open. The
    app stops the service, runs this, and starts it again — which is also why
    this prints the same single-JSON-line contract the ready announcement uses,
    so the supervisor parses one thing rather than two.

    Nothing is replaced until `backup.verify` has passed, and what is replaced is
    moved aside rather than deleted. A restore happens when something has
    already gone wrong, which is the worst moment to make the previous state
    unrecoverable.
    """
    from . import backup

    configure_environment(data_dir)
    try:
        result = backup.restore(source, data_dir)
    except backup.BackupError as error:
        print(json.dumps({"restored": False, "error": str(error)}), flush=True)
        return 1

    # Migrate afterwards, not before: a backup from an older build carries an
    # older schema, and bringing it forward is exactly what opening it means.
    # Left to the next launch it would still happen — but then a failure would
    # arrive as a service that will not start, rather than as this restore
    # saying so while the replaced copy is still sitting beside it.
    try:
        migrate(data_dir)
    except Exception as error:  # noqa: BLE001 - reported, never a traceback on stdout
        print(
            json.dumps(
                {
                    "restored": True,
                    "migrated": False,
                    "error": f"The data was restored but could not be brought up to date: {error}",
                    "replaced": result["replaced"],
                }
            ),
            flush=True,
        )
        return 1

    print(
        json.dumps(
            {
                "restored": True,
                "migrated": True,
                "replaced": result["replaced"],
                "counts": result["manifest"].get("counts", {}),
                "created_at": result["manifest"].get("created_at"),
                "journals": result["journals"],
            }
        ),
        flush=True,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Deckastra workspace service locally.")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0, help="0 asks the operating system.")
    parser.add_argument(
        "--restore-from",
        type=Path,
        help="Put this backup back and exit, instead of serving. The service must not be running.",
    )
    arguments = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)

    if arguments.restore_from is not None:
        return restore_offline(arguments.restore_from, arguments.data_dir)

    settings = configure_environment(arguments.data_dir)

    from . import local_mode

    # Read once, early, so a missing secret is a startup failure rather than a
    # 401 on every request with no explanation.
    local_mode.launch_secret()

    startup_progress("migration", "Checking and upgrading the local workspace")
    migrate(arguments.data_dir)
    startup_progress("seed", "Preparing the local account")
    seed(arguments.data_dir)
    startup_progress("service", "Starting the workspace service")
    start_export_worker()

    # Imported before announcing, not after. A failure in here is a real
    # traceback on stderr at startup; announced first, it becomes a supervisor
    # health timeout that says only "bound a port but never answered".
    import uvicorn

    from .main import app

    server = _listening_socket(arguments.port)
    port = int(server.getsockname()[1])

    # Startup progress and the final ready record share a line-delimited JSON
    # protocol. By now the socket is listening, so "ready" means connectable.
    print(
        json.dumps(
            {
                "ready": True,
                "port": port,
                "database": settings["DATABASE_URL"],
                "assets": settings["DECKASTRA_ASSET_DIR"],
            }
        ),
        flush=True,
    )

    config = uvicorn.Config(app, log_level="warning", access_log=False)
    uvicorn.Server(config).run(sockets=[server])
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
