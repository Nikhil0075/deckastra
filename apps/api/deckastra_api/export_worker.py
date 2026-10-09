"""Durable export worker. Run as ``python -m deckastra_api.export_worker``."""

from __future__ import annotations

import os
import logging
import socket
import time

from . import export_service
from .db.session import session_scope


def _imports() -> None:
    from .mydeck_import import process_one
    process_one()


def _erasures() -> None:
    from .account_deletion import process_one
    process_one()


def run_once(worker_id: str, state: dict) -> bool:
    """One pass over every kind of background work. Returns whether an export ran.

    Each kind of work fails on its own. They used to share one ``try``, so an
    import or an erasure that raised on every pass meant the export queue was
    never reached at all: on 2026-10-06 one abandoned upload stopped every PDF
    export in the cloud for three days, while the worker reported itself healthy.
    """
    log = logging.getLogger("deckastra")
    for name, work in (("import", _imports), ("account erasure", _erasures)):
        try:
            work()
        except Exception as error:
            # No identities, tokens or storage paths in retry diagnostics.
            log.error("Background %s will retry: %s", name, type(error).__name__)
    try:
        with session_scope() as session:
            if os.environ.get("DECKASTRA_ENV") == "production" and time.monotonic() >= state.get("maintenance_at", 0):
                from .maintenance import expire_payloads
                expire_payloads(session)
                state["maintenance_at"] = time.monotonic() + 300
    except Exception as error:
        log.error("Background maintenance will retry: %s", type(error).__name__)
    try:
        with session_scope() as session:
            return export_service.process_one(session, worker_id) is not None
    except Exception as error:
        log.error("Background export will retry: %s", type(error).__name__)
        return False


def main() -> None:
    worker_id = os.environ.get("DECKASTRA_EXPORT_WORKER_ID", socket.gethostname())
    poll_seconds = float(os.environ.get("DECKASTRA_EXPORT_POLL_SECONDS", "1"))
    state: dict = {}
    while True:
        if not run_once(worker_id, state):
            time.sleep(max(0.1, poll_seconds))


if __name__ == "__main__":
    main()
