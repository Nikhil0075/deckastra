"""Durable export worker. Run as ``python -m deckastra_api.export_worker``."""

from __future__ import annotations

import os
import logging
import socket
import time

from . import export_service
from .db.session import session_scope


def main() -> None:
    worker_id = os.environ.get("DECKASTRA_EXPORT_WORKER_ID", socket.gethostname())
    poll_seconds = float(os.environ.get("DECKASTRA_EXPORT_POLL_SECONDS", "1"))
    maintenance_at = 0
    while True:
        try:
            from .mydeck_import import process_one as import_package
            import_package()
            from .account_deletion import process_one as erase_account
            erase_account()
            with session_scope() as session:
                if os.environ.get("DECKASTRA_ENV") == "production" and time.monotonic() >= maintenance_at:
                    from .maintenance import expire_payloads
                    expire_payloads(session)
                    maintenance_at = time.monotonic() + 300
                job = export_service.process_one(session, worker_id)
        except Exception as error:
            # No identities, tokens or storage paths in retry diagnostics.
            logging.getLogger("deckastra").error("Background work will retry: %s", type(error).__name__)
            time.sleep(max(1, poll_seconds))
            continue
        if job is None:
            time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
