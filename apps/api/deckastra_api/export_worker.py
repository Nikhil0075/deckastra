"""Durable export worker. Run as ``python -m deckastra_api.export_worker``."""

from __future__ import annotations

import os
import socket
import time

from . import export_service
from .db.session import session_scope


def main() -> None:
    worker_id = os.environ.get("DECKASTRA_EXPORT_WORKER_ID", socket.gethostname())
    poll_seconds = float(os.environ.get("DECKASTRA_EXPORT_POLL_SECONDS", "1"))
    while True:
        with session_scope() as session:
            job = export_service.process_one(session, worker_id)
        if job is None:
            time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
