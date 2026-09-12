"""Timed PostgreSQL + object-storage restore rehearsal.

This is intentionally an opt-in operational command. It inserts one uniquely
named sentinel into the source database, dumps the complete database, restores
it into a generated scratch database, and proves that the sentinel's version
chain and referenced object can both be read. Existing rows are never modified.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, delete, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from deckastra_api import object_storage, store  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Asset,
    Project,
    User,
    Workspace,
    WorkspaceMember,
)
from deckastra_api.ids import new_id  # noqa: E402

DATABASE_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,62}$")
CORE_TABLES = ("presentations", "presentation_versions", "transactions", "assets")
SENTINEL_BYTES = b"deckastra restore rehearsal sentinel v1\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", db_session.DEFAULT_URL))
    parser.add_argument("--compose-file", default=str(ROOT / "infrastructure/docker/docker-compose.yml"))
    parser.add_argument("--evidence", type=Path)
    parser.add_argument(
        "--allow-sentinel-write",
        action="store_true",
        help="Required: authorizes insertion and cleanup of the isolated rehearsal sentinel.",
    )
    return parser.parse_args()


def docker_postgres(compose_file: str, *command: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "compose", "-f", compose_file, "exec", "-T", "postgres", *command],
        cwd=ROOT,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def expected_migration_heads() -> set[str]:
    configuration = Config(str(ROOT / "infrastructure/database/alembic.ini"))
    configuration.set_main_option(
        "script_location", str(ROOT / "infrastructure/database/migrations")
    )
    return set(ScriptDirectory.from_config(configuration).get_heads())


def database_counts(session: Session) -> dict[str, int]:
    from sqlalchemy import text

    return {
        table: int(session.execute(text(f'SELECT count(*) FROM "{table}"')).scalar_one())
        for table in CORE_TABLES
    }


def migration_heads(session: Session) -> set[str]:
    from sqlalchemy import text

    return set(session.execute(text("SELECT version_num FROM alembic_version")).scalars())


def seed_sentinel(session: Session) -> dict[str, str]:
    user_id, workspace_id, project_id = new_id("usr"), new_id("wsp"), new_id("prj")
    asset_id, member_id = new_id("ast"), new_id("mbr")
    suffix = workspace_id.split("_", 1)[1].lower()
    storage_key = f"restore-rehearsal/{workspace_id}/{asset_id}.bin"

    user = User(id=user_id, email=f"restore-{suffix}@invalid.local", name="Restore rehearsal")
    session.add(user)
    session.flush()
    workspace = Workspace(id=workspace_id, name="Restore rehearsal", owner_id=user_id)
    session.add(workspace)
    session.flush()
    session.add(WorkspaceMember(id=member_id, workspace_id=workspace_id, user_id=user_id, role="owner"))
    session.add(Project(id=project_id, workspace_id=workspace_id, name="Restore rehearsal", created_by=user_id))
    session.flush()

    fixture = ROOT / "packages/presentation-schema/fixtures/technical-deck.mydeck.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))
    presentation_id = new_id("doc")
    document["id"] = presentation_id
    document["metadata"]["title"] = "Restore rehearsal origin"
    document["assets"] = [{
        "id": asset_id,
        "type": "file",
        "storageKey": storage_key,
        "fileName": "restore-sentinel.txt",
        "mimeType": "text/plain",
        "byteSize": len(SENTINEL_BYTES),
        "createdBy": "upload",
    }]
    created = store.create_presentation(
        session, project_id=project_id, document=document, created_by=user_id
    )
    session.add(Asset(
        id=asset_id, workspace_id=workspace_id, created_by=user_id, kind="document",
        storage_key=storage_key, filename="restore-sentinel.txt", content_type="text/plain",
        bytes=len(SENTINEL_BYTES), reference_count=1,
    ))
    updated = copy.deepcopy(document)
    updated["metadata"]["title"] = "Restore rehearsal committed"
    committed = store.commit_transaction(
        session,
        presentation_id=presentation_id,
        operations=[{"op": "replace", "path": "/metadata/title", "value": "Restore rehearsal committed"}],
        inverse_operations=[{"op": "replace", "path": "/metadata/title", "value": "Restore rehearsal origin"}],
        document=updated,
        parent_version_id=created.version_id,
        expected_version_id=created.version_id,
        intent="Restore rehearsal version-chain check",
        source="user",
        created_by=user_id,
        label="Restore rehearsal edit",
    )
    session.flush()
    return {
        "user_id": user_id,
        "workspace_id": workspace_id,
        "presentation_id": presentation_id,
        "origin_version_id": created.version_id,
        "head_version_id": committed.version_id,
        "asset_id": asset_id,
        "storage_key": storage_key,
    }


def purge_object(client: Any, bucket: str, key: str) -> None:
    versions = client.list_object_versions(Bucket=bucket, Prefix=key)
    objects = [
        {"Key": item["Key"], "VersionId": item["VersionId"]}
        for group in (versions.get("Versions", []), versions.get("DeleteMarkers", []))
        for item in group
        if item.get("Key") == key
    ]
    if objects:
        client.delete_objects(Bucket=bucket, Delete={"Objects": objects, "Quiet": True})


def write_evidence(path: Path | None, evidence: dict[str, Any]) -> None:
    payload = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
    if path is None:
        print(payload, end="")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    print(path.resolve())


def main() -> int:
    arguments = parse_args()
    if not arguments.allow_sentinel_write:
        raise SystemExit("Refusing to mutate the source database without --allow-sentinel-write.")

    source_url = make_url(arguments.database_url)
    source_database = source_url.database or ""
    if source_url.get_backend_name() != "postgresql" or not DATABASE_NAME.fullmatch(source_database):
        raise SystemExit("The rehearsal requires a PostgreSQL URL with a simple database name.")

    suffix = f"{int(time.time())}_{os.getpid()}"
    scratch_database = f"deckastra_restore_{suffix}"
    dump_path = f"/tmp/{scratch_database}.dump"
    scratch_url = source_url.set(database=scratch_database)
    client, bucket = object_storage._client(), object_storage.bucket()
    sentinel: dict[str, str] | None = None
    scratch_created = False
    started = time.perf_counter()
    evidence: dict[str, Any] = {
        "kind": "local_restore_rehearsal",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "source_database": source_database,
        "scratch_database": scratch_database,
        "rpo_target_minutes": 5,
        "rto_target_minutes": 60,
        "production_pitr_verified": False,
        "stage": "preflight",
        "status": "failed",
    }

    db_session.reset_engine()
    os.environ["DATABASE_URL"] = arguments.database_url
    try:
        evidence["stage"] = "storage_policy"
        versioning = client.get_bucket_versioning(Bucket=bucket).get("Status")
        lifecycle = client.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
        retention = any(
            rule.get("Status") == "Enabled"
            and rule.get("NoncurrentVersionExpiration", {}).get("NoncurrentDays") == 35
            for rule in lifecycle
        )
        if versioning != "Enabled" or not retention:
            raise RuntimeError("Asset bucket versioning and 35-day noncurrent retention are required.")

        evidence["stage"] = "seed"
        with db_session.session_scope() as source:
            sentinel = seed_sentinel(source)
        client.put_object(
            Bucket=bucket, Key=sentinel["storage_key"], Body=SENTINEL_BYTES, ContentType="text/plain"
        )

        evidence["stage"] = "source_validation"
        source_engine = db_session.get_engine()
        with Session(source_engine) as source:
            source_counts = database_counts(source)
            source_heads = migration_heads(source)
        expected_heads = expected_migration_heads()
        if source_heads != expected_heads:
            raise RuntimeError(f"Source migration heads {sorted(source_heads)} != {sorted(expected_heads)}")

        evidence["stage"] = "database_dump"
        docker_postgres(arguments.compose_file, "pg_dump", "-U", source_url.username or "deckastra", "-d", source_database, "-Fc", "-f", dump_path)
        docker_postgres(arguments.compose_file, "createdb", "-U", source_url.username or "deckastra", scratch_database)
        scratch_created = True
        docker_postgres(arguments.compose_file, "pg_restore", "-U", source_url.username or "deckastra", "--exit-on-error", "--no-owner", "-d", scratch_database, dump_path)

        evidence["stage"] = "restore_validation"
        scratch_engine = create_engine(scratch_url, pool_pre_ping=True)
        try:
            with Session(scratch_engine) as restored:
                restored_counts = database_counts(restored)
                restored_heads = migration_heads(restored)
                head = store.load_presentation(restored, sentinel["presentation_id"])
                origin = store.load_presentation(
                    restored, sentinel["presentation_id"], at_version=sentinel["origin_version_id"]
                )
                asset = restored.scalar(select(Asset).where(Asset.id == sentinel["asset_id"]))
                if head.version_id != sentinel["head_version_id"] or head.document["metadata"]["title"] != "Restore rehearsal committed":
                    raise RuntimeError("Restored presentation head did not match the committed sentinel.")
                if origin.document["metadata"]["title"] != "Restore rehearsal origin":
                    raise RuntimeError("Restored historical version could not be replayed.")
                if asset is None or asset.storage_key != sentinel["storage_key"]:
                    raise RuntimeError("Restored asset row did not match the document reference.")
                if client.get_object(Bucket=bucket, Key=asset.storage_key)["Body"].read() != SENTINEL_BYTES:
                    raise RuntimeError("The referenced object could not be recovered.")
            if restored_counts != source_counts or restored_heads != expected_heads:
                raise RuntimeError("Restored database counts or migration heads differ from the source dump.")
        finally:
            scratch_engine.dispose()

        duration = time.perf_counter() - started
        evidence.update({
            "status": "passed",
            "stage": "complete",
            "duration_seconds": round(duration, 3),
            "local_rto_target_met": duration <= 3600,
            "asset_bucket_versioning": versioning,
            "asset_noncurrent_retention_days": 35,
            "migration_heads": sorted(expected_heads),
            "table_counts": source_counts,
            "verified": [
                "complete PostgreSQL dump restored into an isolated database",
                "Alembic head matched before and after restore",
                "presentation head and historical version replayed",
                "referenced asset row and object bytes recovered",
            ],
        })
        return_code = 0
    except Exception as error:
        evidence["error_type"] = type(error).__name__
        evidence["duration_seconds"] = round(time.perf_counter() - started, 3)
        return_code = 1
    finally:
        if scratch_created:
            docker_postgres(arguments.compose_file, "dropdb", "-U", source_url.username or "deckastra", "--force", "--if-exists", scratch_database, check=False)
        docker_postgres(arguments.compose_file, "rm", "-f", dump_path, check=False)
        if sentinel is not None:
            try:
                with db_session.session_scope() as source:
                    source.execute(delete(Workspace).where(Workspace.id == sentinel["workspace_id"]))
                    source.flush()
                    source.execute(delete(User).where(User.id == sentinel["user_id"]))
                purge_object(client, bucket, sentinel["storage_key"])
            except Exception as cleanup_error:
                evidence["cleanup_error_type"] = type(cleanup_error).__name__
                evidence["status"] = "failed"
                return_code = 1
        evidence["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_evidence(arguments.evidence, evidence)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
