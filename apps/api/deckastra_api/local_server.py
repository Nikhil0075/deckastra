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
- **Everything is derived from one directory.** The database, its checkpoints and
  the asset bytes all live under `--data-dir`, so a backup is a directory copy and
  so is a restore.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
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


def migrate(data_dir: Path) -> None:
    """Bring the database up to head.

    On launch, every launch. A desktop app has no operator to run migrations, and
    an install that opens against a stale schema fails in whichever route touches
    the new column first — which is the least diagnosable place for it to happen.
    """
    from alembic import command
    from alembic.config import Config

    from .paths import resource_root

    root = resource_root()
    config = Config(str(root / "infrastructure" / "database" / "alembic.ini"))
    config.set_main_option("script_location", str(root / "infrastructure" / "database" / "migrations"))
    command.upgrade(config, "head")


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Deckastra workspace service locally.")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0, help="0 asks the operating system.")
    arguments = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)

    settings = configure_environment(arguments.data_dir)

    from . import local_mode

    # Read once, early, so a missing secret is a startup failure rather than a
    # 401 on every request with no explanation.
    local_mode.launch_secret()

    migrate(arguments.data_dir)
    seed(arguments.data_dir)
    start_export_worker()

    # Imported before announcing, not after. A failure in here is a real
    # traceback on stderr at startup; announced first, it becomes a supervisor
    # health timeout that says only "bound a port but never answered".
    import uvicorn

    from .main import app

    server = _listening_socket(arguments.port)
    port = int(server.getsockname()[1])

    # stdout carries exactly one line, and the supervisor stops reading after it.
    # By now the socket is listening, so "ready" means connectable.
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
