"""D5.6: pulling a cloud workspace onto a device.

The push direction could not come first. A `create` needs a *remote* project id,
and a device that had only ever pushed has no mapping for one — so the first
slice of a transport is the direction that establishes what the two sides call
things. The answer turned out to be that there is nothing to establish: **ids
travel**, because a presentation takes its id from its document (D5.0) and a
workspace or project created on the server is created by the server. Only version
ids do not, which is what `Presentation.remote_version_id` is for.

The server here is a **real second store**, not canned JSON. `remote_account`
and friends are captured from one database and replayed into another, the way the
D5.0 replay spike ran two stores one after the other — so what these tests check
is that a device can mirror a workspace another Deckastra actually produced,
rather than that it can parse a dictionary I wrote.
"""

from __future__ import annotations

import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import auth, bootstrap, store, sync  # noqa: E402
from deckastra_api.compose import blank_document  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Presentation,
    Project,
    Workspace,
    WorkspaceMember,
)
from deckastra_api.ids import new_id  # noqa: E402


def use_store(tmp_path: Path, name: str) -> None:
    """Point the process at one database and forget the other."""
    import os

    os.environ["DATABASE_URL"] = f"sqlite:///{tmp_path / f'{name}.db'}"
    db_session.reset_engine()
    db_session.create_all()


class CapturedServer:
    """A server's answers, taken from a real store and replayed into another.

    Holding the *answers* rather than a live session is what makes the two stores
    genuinely separate: the device reads a snapshot of what the server said, with
    no way to reach back into its database. That is also what a network is.
    """

    def __init__(
        self,
        account: dict,
        presentations: dict[str, list[dict]],
        documents: dict[str, dict],
    ) -> None:
        self._account = account
        self._presentations = presentations
        self._documents = documents
        self.asked_for: list[str] = []

    def account(self) -> dict:
        return copy.deepcopy(self._account)

    def presentations(self, project_id: str) -> list[dict]:
        return copy.deepcopy(self._presentations.get(project_id, []))

    def document(self, presentation_id: str) -> dict:
        self.asked_for.append(presentation_id)
        return copy.deepcopy(self._documents[presentation_id])


def a_cloud_workspace(tmp_path: Path, *, decks: int = 2, role: str = "editor") -> CapturedServer:
    """Build a workspace in one store and capture what its API would answer."""
    use_store(tmp_path, "cloud")

    with db_session.session_scope() as session:
        user, workspace, project = auth.provision_personal_account(
            session, email="them@acme.example", name="Acme"
        )
        workspace.name = "Acme"
        project.name = "Launch"

        summaries: list[dict] = []
        documents: dict[str, dict] = {}
        for index in range(decks):
            document = blank_document(title=f"Deck {index + 1}")
            created = store.create_presentation(
                session,
                project_id=project.id,
                document=document,
                created_by=user.id,
            )
            summaries.append({"id": created.presentation_id, "title": created.title})
            documents[created.presentation_id] = {
                "document": copy.deepcopy(created.document),
                "version_id": created.version_id,
            }

        account = {
            "user": {"id": user.id, "email": user.email, "name": user.name},
            "workspaces": [
                {
                    "id": workspace.id,
                    "name": workspace.name,
                    "role": role,
                    "origin": "local",  # local *to the server*, which owns it
                    "projects": [
                        {"id": project.id, "name": project.name, "description": None}
                    ],
                }
            ],
        }

    return CapturedServer(account, {project.id: summaries}, documents)


@pytest.fixture()
def device(tmp_path, monkeypatch):
    """A machine that has just signed in: its own account, nothing mirrored yet."""
    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        user, workspace, project = auth.provision_personal_account(
            session, email="me@local", name="Me"
        )
        return {"user_id": user.id, "workspace_id": workspace.id, "project_id": project.id}


# ------------------------------------------------------------- what it mirrors


def test_a_workspace_arrives_with_the_servers_own_ids(tmp_path, device):
    """The mapping, and the reason there is no mapping table.

    A workspace created on the server is created *by* the server, so it has the
    server's id; a presentation takes its id from its document (D5.0). Mirroring
    keeps both. Had the device minted its own, every later push would need a
    translation table on both sides, and the first bug in it would send a change
    to the wrong deck.
    """
    server = a_cloud_workspace(tmp_path)
    remote_workspace = server.account()["workspaces"][0]

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert report.workspaces == [remote_workspace["id"]]
    assert len(report.decks_pulled) == 2

    with db_session.session_scope() as session:
        mirrored = session.get(Workspace, remote_workspace["id"])
        assert mirrored is not None
        # The column the whole of D5.4 branches on.
        assert mirrored.origin == "cloud"
        assert mirrored.name == "Acme"

        project = session.get(Project, remote_workspace["projects"][0]["id"])
        assert project is not None
        assert project.workspace_id == mirrored.id

        for presentation_id in report.decks_pulled:
            deck = session.get(Presentation, presentation_id)
            assert deck is not None
            assert deck.project_id == project.id


def test_the_membership_arrives_confirmed_and_authorizes(tmp_path, device):
    """A mirrored membership is a cache, and a cache authorizes only while
    confirmed (D5.4). Bootstrap is the thing that confirms it — and it does so
    through `confirm_membership`, which is the only writer of `confirmed_at`."""
    server = a_cloud_workspace(tmp_path, role="editor")
    workspace_id = server.account()["workspaces"][0]["id"]

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    with db_session.session_scope() as session:
        status = auth.membership_status(session, device["user_id"], workspace_id)
        assert status.state == "confirmed"
        assert status.role is auth.Role.EDITOR
        assert status.confirmed_at is not None


def test_the_version_it_mirrors_is_recorded(tmp_path, device):
    """The one identity that does not travel (D5.0).

    Without this column nothing could answer "which server version is this a copy
    of", which is what a later push needs in order to say what its change is based
    on, and what divergence detection compares.
    """
    server = a_cloud_workspace(tmp_path, decks=1)
    remote = server.account()["workspaces"][0]
    project_id = remote["projects"][0]["id"]
    expected = {
        summary["id"]: server.document(summary["id"])["version_id"]
        for summary in server.presentations(project_id)
    }

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    with db_session.session_scope() as session:
        for presentation_id, remote_version in expected.items():
            deck = session.get(Presentation, presentation_id)
            assert deck.remote_version_id == remote_version
            # And the local chain is its own, which is the finding this column
            # exists because of.
            assert deck.current_version_id != remote_version


# ------------------------------------------------------------------- the echo


def test_a_pulled_deck_does_not_offer_itself_straight_back(tmp_path, device):
    """The trap that would have made the first sync loop.

    A deck in a syncing workspace enqueues itself for upload (D5.2). A mirrored
    one doing that means the device immediately offers the server back the deck it
    just received — and it would arrive there as a brand-new deck carrying an id
    the server already has.
    """
    server = a_cloud_workspace(tmp_path, decks=2)

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])
        assert len(report.decks_pulled) == 2

        for presentation_id in report.decks_pulled:
            assert sync.pending_for(session, presentation_id) == []

    # And the queue is empty as a whole, not merely per deck — so nothing was
    # enqueued under some other id either.
    sent: list[str] = []
    with db_session.session_scope() as session:
        drained = sync.drain(session, lambda outgoing: (sent.append(outgoing.kind), "v")[1])
    assert sent == []
    assert drained.sent == 0


def test_an_edit_after_the_pull_is_owed_normally(tmp_path, device):
    """The negative control for the case above.

    If nothing a mirrored deck ever did was queued, "the pull queued nothing"
    would be true of a device that can never sync at all.
    """
    server = a_cloud_workspace(tmp_path, decks=1)

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])
        presentation_id = report.decks_pulled[0]

        loaded = store.load_presentation(session, presentation_id)
        document = copy.deepcopy(loaded.document)
        document["metadata"]["title"] = "Edited on this device"
        store.commit_transaction(
            session,
            presentation_id=presentation_id,
            operations=[{"op": "replace", "path": "/metadata/title", "value": "Edited on this device"}],
            inverse_operations=[
                {"op": "replace", "path": "/metadata/title", "value": loaded.title}
            ],
            document=document,
            parent_version_id=loaded.version_id,
            expected_version_id=loaded.version_id,
            intent="Retitle",
            source="user",
            created_by=device["user_id"],
        )

    with db_session.session_scope() as session:
        queued = sync.pending_for(session, presentation_id)
        assert [row.kind for row in queued] == ["change"]


# ------------------------------------------------------------------- refusals


def test_a_local_workspace_is_never_taken_over_by_the_server(tmp_path, device):
    """The dangerous one.

    A server answering with an id that matches one of this machine's own
    workspaces would otherwise take it over — decks and all — and the person would
    have handed it over by signing in.
    """
    server = a_cloud_workspace(tmp_path, decks=1)

    use_store(tmp_path, "device")
    # The server claims the id of the workspace this device already owns.
    hijack = server.account()
    hijack["workspaces"][0]["id"] = device["workspace_id"]
    hijack["workspaces"][0]["name"] = "Acme"
    server._account = hijack

    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert report.workspaces == []
    assert any("already a workspace on this device" in one for one in report.refused)

    with db_session.session_scope() as session:
        mine = session.get(Workspace, device["workspace_id"])
        assert mine.origin == "local"
        assert mine.name != "Acme"
        # And the membership is untouched: still this machine's own authority,
        # not a cache with an expiry.
        assert auth.membership_status(
            session, device["user_id"], device["workspace_id"]
        ).state == "authoritative"


def test_a_deck_whose_document_names_another_deck_is_refused(tmp_path, device):
    """The id in the document *is* the presentation id (D5.0), so one that
    disagrees with the row it arrived under would create a deck under an id
    nothing else refers to."""
    server = a_cloud_workspace(tmp_path, decks=1)
    presentation_id = next(iter(server._documents))
    server._documents[presentation_id]["document"]["id"] = new_id("doc")

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert report.decks_pulled == []
    assert any("names a different deck" in one for one in report.refused)


def test_a_document_this_build_cannot_open_is_refused_by_name(tmp_path, device):
    """Storing it would not make it openable, and a silent skip leaves a person
    looking for a deck that is simply missing from the list."""
    server = a_cloud_workspace(tmp_path, decks=1)
    presentation_id = next(iter(server._documents))
    server._documents[presentation_id]["document"]["slides"] = "not a list of slides"

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert report.decks_pulled == []
    assert any(presentation_id in one and "validate" in one for one in report.refused)


# --------------------------------------------------------------- running again


def test_running_it_twice_changes_nothing(tmp_path, device):
    """It runs on every sign-in and every reconnect, so it has to be idempotent."""
    server = a_cloud_workspace(tmp_path, decks=2)

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        first = bootstrap.adopt(session, server, user_id=device["user_id"])
    with db_session.session_scope() as session:
        second = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert len(first.decks_pulled) == 2
    assert second.decks_pulled == []
    assert second.decks_already_held == 2

    with db_session.session_scope() as session:
        assert session.query(Presentation).count() == 2
        assert session.query(Workspace).count() == 2  # this device's own, plus the mirror


def test_a_deck_with_unsent_work_is_not_overwritten_by_a_pull(tmp_path, device):
    """The local copy wins, and that is not laziness.

    A deck already here may carry edits that have not been uploaded, and replacing
    it with the server's would discard exactly the work the outbox exists to
    protect. Bringing a changed deck up to date is a merge (D5.3), not a pull.
    """
    server = a_cloud_workspace(tmp_path, decks=1)

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])
        presentation_id = report.decks_pulled[0]

        loaded = store.load_presentation(session, presentation_id)
        document = copy.deepcopy(loaded.document)
        document["metadata"]["title"] = "Only on this device"
        store.commit_transaction(
            session,
            presentation_id=presentation_id,
            operations=[{"op": "replace", "path": "/metadata/title", "value": "Only on this device"}],
            inverse_operations=[
                {"op": "replace", "path": "/metadata/title", "value": loaded.title}
            ],
            document=document,
            parent_version_id=loaded.version_id,
            expected_version_id=loaded.version_id,
            intent="Retitle",
            source="user",
            created_by=device["user_id"],
        )

    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    with db_session.session_scope() as session:
        assert (
            store.load_presentation(session, presentation_id).document["metadata"]["title"]
            == "Only on this device"
        )
        # Still owed, too — a pull must not quietly clear the queue.
        assert [row.kind for row in sync.pending_for(session, presentation_id)] == ["change"]


# ---------------------------------------------------------------- losing access


def test_a_workspace_the_server_stops_listing_is_revoked_at_once(tmp_path, device):
    """The other half of D5.4's cache policy.

    A freshness window is for a device that *cannot* ask. This is a device that
    just asked and was told the membership is gone, so it stops now rather than
    running down a thirty-day clock.
    """
    server = a_cloud_workspace(tmp_path, decks=1)
    workspace_id = server.account()["workspaces"][0]["id"]

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])
        assert auth.membership_status(
            session, device["user_id"], workspace_id
        ).authorizes

    # Removed upstream: the account no longer lists it.
    server._account = {**server.account(), "workspaces": []}

    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert report.revoked == [workspace_id]
    with db_session.session_scope() as session:
        status = auth.membership_status(session, device["user_id"], workspace_id)
        assert status.state == "revoked"
        assert status.role is None


def test_losing_access_does_not_revoke_this_machines_own_workspace(tmp_path, device):
    """A server has no say over a workspace it does not own."""
    server = a_cloud_workspace(tmp_path, decks=1)

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    server._account = {**server.account(), "workspaces": []}
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert device["workspace_id"] not in report.revoked
    with db_session.session_scope() as session:
        assert auth.membership_status(
            session, device["user_id"], device["workspace_id"]
        ).state == "authoritative"


def test_losing_access_leaves_the_decks_on_disk(tmp_path, device):
    """Bytes already on a device are already on the device.

    Quietly destroying someone's local copy of work they may have authored is a
    bigger decision than a reconnect should make on its own — so access stops and
    the files stay, which is what D5.4 said and this is where it becomes visible.
    """
    server = a_cloud_workspace(tmp_path, decks=1)

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])
        presentation_id = report.decks_pulled[0]

    server._account = {**server.account(), "workspaces": []}
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    with db_session.session_scope() as session:
        assert session.get(Presentation, presentation_id) is not None


def test_being_added_back_works(tmp_path, device):
    """A membership revoked and granted again is an ordinary membership."""
    server = a_cloud_workspace(tmp_path, decks=1)
    workspace_id = server.account()["workspaces"][0]["id"]
    full_account = server.account()

    use_store(tmp_path, "device")
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    server._account = {**full_account, "workspaces": []}
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    server._account = full_account
    with db_session.session_scope() as session:
        bootstrap.adopt(session, server, user_id=device["user_id"])

    with db_session.session_scope() as session:
        status = auth.membership_status(session, device["user_id"], workspace_id)
        assert status.state == "confirmed"
        assert status.authorizes


def test_a_refused_project_takes_no_decks(tmp_path, device):
    """Found by review, 2026-09-17.

    `_adopt_project` refuses a project that already belongs to another workspace
    on this device — and the loop pulled its decks anyway, because the refusal was
    appended to the report and the return value was never read. So a server naming
    an id this machine already uses would have had its decks imported straight
    into a **local** project: exactly the takeover the workspace guard exists to
    prevent, one level down and through the door beside it.
    """
    server = a_cloud_workspace(tmp_path, decks=2)

    use_store(tmp_path, "device")
    # The server names a project id this device already has, in its own local
    # workspace.
    claimed = server.account()
    remote_project = claimed["workspaces"][0]["projects"][0]
    summaries = server.presentations(remote_project["id"])
    remote_project["id"] = device["project_id"]
    server._account = claimed
    server._presentations = {device["project_id"]: summaries}

    with db_session.session_scope() as session:
        report = bootstrap.adopt(session, server, user_id=device["user_id"])

    assert any("another workspace" in one for one in report.refused)
    assert report.decks_pulled == []

    with db_session.session_scope() as session:
        # The local project is untouched: still local, still empty of the
        # server's decks.
        project = session.get(Project, device["project_id"])
        assert project.workspace_id == device["workspace_id"]
        assert session.query(Presentation).count() == 0
        # And nothing asked for a document, so it did not even reach across.
        assert server.asked_for == []
