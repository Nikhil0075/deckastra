"""Persistence: snapshot + operation log, and the authorization chain.

These run against SQLite. The schema is written to be dialect-portable for
exactly this reason: behaviour worth testing on every push — optimistic
concurrency, snapshot replay, cascade deletes — stops being tested the moment it
requires a container to run.

What SQLite cannot cover is called out where it matters. The migration itself is
exercised against both, and `test_migrations.py` asserts it produces the same
schema the models describe.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import store  # noqa: E402
from deckastra_api.auth import (  # noqa: E402
    Forbidden,
    Role,
    issue_dev_token,
    resolve_presentation_access,
    verify_dev_token,
)
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Presentation,
    PresentationVersion,
    Project,
    TransactionRow,
    User,
    Workspace,
    WorkspaceMember,
)
from deckastra_api.ids import new_id  # noqa: E402
from deckastra_api.patch import apply_patch  # noqa: E402

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "presentation-schema"
    / "fixtures"
    / "technical-deck.mydeck.json"
)


def load_document() -> dict:
    with FIXTURE.open(encoding="utf-8") as handle:
        document = json.load(handle)
    document["id"] = new_id("doc")
    return document


@pytest.fixture()
def db(tmp_path, monkeypatch) -> Session:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    db_session.reset_engine()
    db_session.create_all()

    with db_session.session_scope() as session:
        yield session

    db_session.reset_engine()


@pytest.fixture()
def workspace(db: Session) -> dict[str, str]:
    """A workspace with an owner, an editor and a viewer."""
    users = {}
    for label, role in [("owner", "owner"), ("editor", "editor"), ("viewer", "viewer")]:
        user_id = new_id("usr")
        db.add(User(id=user_id, email=f"{label}@example.com", name=label))
        users[label] = user_id

    outsider = new_id("usr")
    db.add(User(id=outsider, email="outsider@example.com", name="outsider"))
    users["outsider"] = outsider

    workspace_id = new_id("wsp")
    db.add(Workspace(id=workspace_id, name="Test workspace", owner_id=users["owner"]))

    for label, role in [("owner", "owner"), ("editor", "editor"), ("viewer", "viewer")]:
        db.add(
            WorkspaceMember(
                id=new_id("mbr"), workspace_id=workspace_id, user_id=users[label], role=role
            )
        )

    project_id = new_id("prj")
    db.add(
        Project(
            id=project_id, workspace_id=workspace_id, name="Test project", created_by=users["owner"]
        )
    )
    db.flush()

    return {**users, "workspace_id": workspace_id, "project_id": project_id}


@pytest.fixture()
def presentation(db: Session, workspace: dict[str, str]) -> store.LoadedPresentation:
    return store.create_presentation(
        db,
        project_id=workspace["project_id"],
        document=load_document(),
        created_by=workspace["owner"],
    )


# ------------------------------------------------------------------ versioning


def test_first_version_carries_a_full_snapshot(db: Session, presentation):
    version = db.get(PresentationVersion, presentation.version_id)
    # There is nothing to replay from otherwise.
    assert version.snapshot_json is not None
    assert version.parent_version_id is None


def test_load_returns_what_was_stored(db: Session, presentation):
    loaded = store.load_presentation(db, presentation.presentation_id)
    assert loaded.document == presentation.document
    assert loaded.version_id == presentation.version_id


def commit_edit(
    db: Session,
    loaded: store.LoadedPresentation,
    value: str,
    *,
    source: str = "user",
    **kwargs,
):
    slide_id = loaded.document["slides"][0]["id"]
    operations = [{"op": "replace", "path": f"/slides/id:{slide_id}/keyMessage", "value": value}]
    document, inverse = apply_patch(loaded.document, operations)

    return store.commit_transaction(
        db,
        presentation_id=loaded.presentation_id,
        operations=operations,
        inverse_operations=inverse,
        document=document,
        parent_version_id=loaded.version_id,
        expected_version_id=loaded.version_id,
        intent=f"Set key message to {value}",
        source=source,
        created_by="usr_test",
        **kwargs,
    )


def test_a_committed_edit_advances_the_head(db: Session, presentation):
    result = commit_edit(db, presentation, "changed")

    reloaded = store.load_presentation(db, presentation.presentation_id)
    assert reloaded.version_id == result.version_id
    assert reloaded.document["slides"][0]["keyMessage"] == "changed"


def test_intermediate_versions_store_operations_not_copies(db: Session, presentation):
    # Saving a full copy of a 12MB document for every nudge is the thing the
    # operation log exists to avoid (doc 05 §22).
    result = commit_edit(db, presentation, "changed")

    version = db.get(PresentationVersion, result.version_id)
    assert version.snapshot_json is None
    assert version.ops_since_snapshot == 1

    transaction = db.get(TransactionRow, result.transaction_id)
    assert transaction.operations_json
    assert transaction.inverse_operations_json


def test_reads_replay_forward_from_the_nearest_snapshot(db: Session, presentation):
    loaded = presentation
    for i in range(10):
        result = commit_edit(db, loaded, f"v{i}")
        loaded = store.load_presentation(db, presentation.presentation_id)
        assert loaded.version_id == result.version_id

    # Ten edits, one snapshot, nine replays — and the result must be exactly what
    # the last commit produced.
    final = store.load_presentation(db, presentation.presentation_id)
    assert final.document["slides"][0]["keyMessage"] == "v9"

    snapshots = [
        v
        for v in store.version_history(db, presentation.presentation_id, limit=100)
        if v.snapshot_json is not None
    ]
    assert len(snapshots) == 1


def test_a_snapshot_is_written_every_n_operations(db: Session, presentation):
    loaded = presentation
    for i in range(store.SNAPSHOT_EVERY + 2):
        commit_edit(db, loaded, f"v{i}")
        loaded = store.load_presentation(db, presentation.presentation_id)

    snapshots = [
        v
        for v in store.version_history(db, presentation.presentation_id, limit=200)
        if v.snapshot_json is not None
    ]
    assert len(snapshots) >= 2


def test_an_agent_run_always_snapshots(db: Session, presentation):
    # So a bad generation can be rolled back to a known-good state without
    # replaying through it.
    result = commit_edit(db, presentation, "by agent", source="agent", agent_id="layout")
    assert result.snapshotted is True
    assert db.get(PresentationVersion, result.version_id).snapshot_json is not None


def test_historical_versions_can_be_read(db: Session, presentation):
    first = commit_edit(db, presentation, "one")
    loaded = store.load_presentation(db, presentation.presentation_id)
    commit_edit(db, loaded, "two")

    # The whole point of keeping the operation log rather than only the head.
    at_first = store.load_presentation(db, presentation.presentation_id, at_version=first.version_id)
    assert at_first.document["slides"][0]["keyMessage"] == "one"

    at_origin = store.load_presentation(
        db, presentation.presentation_id, at_version=presentation.version_id
    )
    assert at_origin.document == presentation.document


def test_replay_reproduces_the_document_exactly(db: Session, presentation):
    """A reconstructed document must be byte-identical to what was committed."""
    loaded = presentation
    committed: dict | None = None

    for i in range(5):
        result = commit_edit(db, loaded, f"round{i}")
        committed = result.document
        loaded = store.load_presentation(db, presentation.presentation_id)

    canonical = lambda v: json.dumps(v, sort_keys=True, separators=(",", ":"))  # noqa: E731
    assert canonical(loaded.document) == canonical(committed)


# ------------------------------------------------------- optimistic concurrency


def test_a_stale_expected_version_is_refused(db: Session, presentation):
    # Silently overwriting someone else's change is the worst possible failure for
    # a document product (doc 04 §30.2), so a conflict is surfaced.
    first = store.load_presentation(db, presentation.presentation_id)
    second = store.load_presentation(db, presentation.presentation_id)

    commit_edit(db, first, "first writer wins")

    with pytest.raises(store.VersionConflict) as excinfo:
        commit_edit(db, second, "second writer")

    assert "changed since you loaded it" in str(excinfo.value)
    assert excinfo.value.expected == second.version_id


def test_omitting_the_expected_version_skips_the_check(db: Session, presentation):
    # For callers that genuinely mean last-write-wins, such as a server-side
    # migration. It must be an explicit choice, not the default.
    slide_id = presentation.document["slides"][0]["id"]
    operations = [{"op": "replace", "path": f"/slides/id:{slide_id}/keyMessage", "value": "forced"}]
    document, inverse = apply_patch(presentation.document, operations)

    result = store.commit_transaction(
        db,
        presentation_id=presentation.presentation_id,
        operations=operations,
        inverse_operations=inverse,
        document=document,
        parent_version_id=presentation.version_id,
        expected_version_id=None,
        intent="Forced",
        source="system",
        created_by="system",
    )
    assert result.version_id


# ---------------------------------------------------------------- transactions


def test_a_pending_proposal_writes_no_version(db: Session, presentation):
    # Nothing happened to the document yet; that is the distinction `status`
    # records (doc 02 §31.6).
    before = len(store.version_history(db, presentation.presentation_id, limit=100))

    slide_id = presentation.document["slides"][0]["id"]
    operations = [{"op": "replace", "path": f"/slides/id:{slide_id}/keyMessage", "value": "proposed"}]
    _, inverse = apply_patch(presentation.document, operations)

    transaction_id = store.create_pending_transaction(
        db,
        presentation_id=presentation.presentation_id,
        operations=operations,
        inverse_operations=inverse,
        parent_version_id=presentation.version_id,
        intent="Proposal",
        created_by="usr_test",
        agent_id="layout",
        risk_tier="low",
    )

    row = store.get_transaction(db, transaction_id)
    assert row.status == "pending"
    assert row.result_version_id is None
    assert len(store.version_history(db, presentation.presentation_id, limit=100)) == before

    # And the document is untouched.
    assert store.load_presentation(db, presentation.presentation_id).document["slides"][0][
        "keyMessage"
    ] == presentation.document["slides"][0]["keyMessage"]


def test_history_can_be_filtered_by_status(db: Session, presentation):
    commit_edit(db, presentation, "applied one")
    slide_id = presentation.document["slides"][0]["id"]
    _, inverse = apply_patch(
        presentation.document,
        [{"op": "replace", "path": f"/slides/id:{slide_id}/keyMessage", "value": "p"}],
    )
    store.create_pending_transaction(
        db,
        presentation_id=presentation.presentation_id,
        operations=[{"op": "replace", "path": f"/slides/id:{slide_id}/keyMessage", "value": "p"}],
        inverse_operations=inverse,
        parent_version_id=presentation.version_id,
        intent="Proposal",
        created_by="usr_test",
    )

    assert len(store.transaction_history(db, presentation.presentation_id)) == 2
    assert len(store.transaction_history(db, presentation.presentation_id, status="pending")) == 1
    assert len(store.transaction_history(db, presentation.presentation_id, status="applied")) == 1


def test_every_applied_transaction_records_its_lineage(db: Session, presentation):
    # Closes doc 05 S1: without both version columns the lineage is implicit and
    # cannot be replayed.
    result = commit_edit(db, presentation, "changed")
    row = db.get(TransactionRow, result.transaction_id)

    assert row.parent_version_id == presentation.version_id
    assert row.result_version_id == result.version_id
    assert row.status == "applied"
    assert row.applied_at is not None


def test_missing_presentation_reads_as_not_found(db: Session):
    with pytest.raises(store.NotFound):
        store.load_presentation(db, "doc_01JB8Z9K2QW4RN7F3XG5HTMD6A")


# --------------------------------------------------------------- authorization


def test_dev_tokens_are_signed(monkeypatch):
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "s3cret")
    token = issue_dev_token("usr_1")

    assert verify_dev_token(token) == "usr_1"
    # A bare user id in a header would let anyone be anyone.
    assert verify_dev_token("usr_2.deadbeef") is None
    assert verify_dev_token("usr_1") is None


def test_the_chain_resolves_by_membership_not_ownership(db: Session, workspace, presentation):
    # doc 05 §21 gave workspaces an owner and nothing else, so the chain could not
    # be resolved for anyone but the owner. This is the gap S1 fix working.
    for label, expected in [
        ("owner", Role.OWNER),
        ("editor", Role.EDITOR),
        ("viewer", Role.VIEWER),
    ]:
        access = resolve_presentation_access(
            db, user_id=workspace[label], presentation_id=presentation.presentation_id
        )
        assert access.role == expected
        assert access.workspace_id == workspace["workspace_id"]


def test_a_non_member_gets_not_found_rather_than_forbidden(db: Session, workspace, presentation):
    # A 403 on a resource you cannot see confirms it exists, which turns the API
    # into an enumeration oracle.
    with pytest.raises(Forbidden) as excinfo:
        resolve_presentation_access(
            db, user_id=workspace["outsider"], presentation_id=presentation.presentation_id
        )
    assert excinfo.value.status_code == 404


def test_a_viewer_cannot_edit(db: Session, workspace, presentation):
    access = resolve_presentation_access(
        db, user_id=workspace["viewer"], presentation_id=presentation.presentation_id
    )
    assert access.can_edit is False

    with pytest.raises(Forbidden):
        resolve_presentation_access(
            db,
            user_id=workspace["viewer"],
            presentation_id=presentation.presentation_id,
            require=Role.EDITOR,
        )


def test_an_editor_can_edit_but_is_not_an_admin(db: Session, workspace, presentation):
    access = resolve_presentation_access(
        db,
        user_id=workspace["editor"],
        presentation_id=presentation.presentation_id,
        require=Role.EDITOR,
    )
    assert access.can_edit is True

    with pytest.raises(Forbidden):
        resolve_presentation_access(
            db,
            user_id=workspace["editor"],
            presentation_id=presentation.presentation_id,
            require=Role.ADMIN,
        )


def test_deleting_a_workspace_cascades(db: Session, workspace, presentation):
    db.delete(db.get(Workspace, workspace["workspace_id"]))
    db.flush()

    assert db.get(Project, workspace["project_id"]) is None
    assert db.get(Presentation, presentation.presentation_id) is None
    # Versions and transactions go with the presentation, so a deleted deck leaves
    # no orphaned history behind.
    assert store.version_history(db, presentation.presentation_id) == []
    assert store.transaction_history(db, presentation.presentation_id) == []


def test_a_user_cannot_hold_two_roles_in_one_workspace(db: Session, workspace):
    from sqlalchemy.exc import IntegrityError

    db.add(
        WorkspaceMember(
            id=new_id("mbr"),
            workspace_id=workspace["workspace_id"],
            user_id=workspace["editor"],
            role="admin",
        )
    )
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_documents_never_carry_credentials(db: Session, presentation):
    # A .mydeck file must be safe to email, including one that has been through
    # the store.
    blob = json.dumps(store.load_presentation(db, presentation.presentation_id).document)
    for forbidden in ("apiKey", "Bearer ", "X-Amz-Signature", "DATABASE_URL", "password"):
        assert forbidden not in blob
