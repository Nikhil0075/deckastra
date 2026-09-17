"""Shared database fixtures.

The suite runs against SQLite by default and against PostgreSQL when
``POSTGRES_TEST_URL`` is set. Both matter, for different reasons:

- SQLite keeps the behaviour worth checking on every push — optimistic
  concurrency, snapshot replay, cascade deletes — testable with no container.
  A test that needs a server to run is a test that stops running.
- PostgreSQL is what actually gets deployed, and the schema is not
  dialect-neutral: ``JsonColumn`` resolves to ``JSONB`` there and to ``JSON``
  everywhere else, which changes how values round-trip. A migration that has only
  ever run on SQLite is a migration that has not been tested.

CI sets ``POSTGRES_TEST_URL`` against a service container, so every push
exercises both. Locally:

    docker compose -f infrastructure/docker/docker-compose.yml up -d postgres
    POSTGRES_TEST_URL=postgresql+psycopg://deckastra:deckastra_local@localhost:5432/deckastra \\
      python -m pytest apps/api -q
"""

from __future__ import annotations

import os
import socket
import urllib.parse
import uuid

import pytest
from sqlalchemy import create_engine, text

POSTGRES_URL = os.environ.get("POSTGRES_TEST_URL")


def postgres_available() -> bool:
    """True when a PostgreSQL server is configured and reachable."""
    if not POSTGRES_URL:
        return False
    try:
        engine = create_engine(POSTGRES_URL)
        with engine.connect() as connection:
            connection.execute(text("select 1"))
        engine.dispose()
        return True
    except Exception:  # noqa: BLE001 - any connection failure means "not available"
        return False


requires_postgres = pytest.mark.skipif(
    not postgres_available(),
    reason="Set POSTGRES_TEST_URL to a reachable PostgreSQL server to run this.",
)


@pytest.fixture()
def postgres_url() -> str:
    """A private, empty database on the configured PostgreSQL server.

    A database per test rather than a schema per test. A schema would be cheaper,
    but pointing at one means a `search_path` in the URL, and percent-encoding
    that puts a `%` into the connection string — which Alembic's ConfigParser
    then tries to interpolate and fails on. A separate database keeps the URL
    plain, which is worth more than the milliseconds.

    Tests that share a database fail in ways that depend on execution order,
    which is the worst kind of flake to chase.
    """
    if not POSTGRES_URL:
        pytest.skip("POSTGRES_TEST_URL is not set")

    name = f"deckastra_test_{uuid.uuid4().hex[:12]}"
    # CREATE DATABASE cannot run inside a transaction block.
    admin = create_engine(POSTGRES_URL, isolation_level="AUTOCOMMIT")

    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))

    base, _, query = POSTGRES_URL.partition("?")
    url = base.rsplit("/", 1)[0] + f"/{name}" + (f"?{query}" if query else "")

    yield url

    with admin.connect() as connection:
        # Anything still connected would block the drop; there should be nothing,
        # but a failed test can leave a session behind and the next run should not
        # inherit its mess.
        connection.execute(
            text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = :name AND pid <> pg_backend_pid()"
            ),
            {"name": name},
        )
        connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
    admin.dispose()


# ------------------------------------------------------------- object storage


def object_store_available() -> bool:
    """True when something is listening on the configured S3 endpoint.

    A socket, not a call through `object_storage`. Every failure that module can
    have comes back as one `ObjectStorageError` — "no such object" and "nothing is
    listening" are the same exception — so a probe that went through it reads an
    unreachable endpoint as a working one and runs the whole suite against
    nothing. The first version of this guard did exactly that: with MinIO stopped
    it reported available and the tests spent 75 seconds in boto3's retries before
    failing.
    """
    endpoint = os.environ.get("S3_ENDPOINT_URL", "http://localhost:9000")
    parsed = urllib.parse.urlparse(endpoint)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((parsed.hostname or "localhost", port), timeout=1):
            return True
    except OSError:
        return False


requires_object_store = pytest.mark.skipif(
    not object_store_available(),
    reason=(
        "Start the object store to run this: "
        "docker compose -f infrastructure/docker/docker-compose.yml up -d minio"
    ),
)
