"""Pulling a cloud workspace down onto this device (D5.6, the bootstrap half).

Push cannot come first, and finding out why changed the design. A `create` needs
a *remote* project id, and a device that had only ever pushed would have no
mapping for one — so the first slice of a transport is the direction that
establishes what the two sides call things.

**Ids travel; version ids do not.** That is the whole mapping, and it falls out
of what already exists rather than being invented here: `create_presentation`
takes a presentation's id from `document["id"]` (D5.0), and a workspace or project
created on the server is created *by the server*, which mints the id. So a
mirrored row holds the server's id, `origin = "cloud"` means "this row mirrors a
server row with the same id", and there is no translation table anywhere. The one
exception is the version chain, because `commit_transaction` mints its own and
takes none from a caller — which is why `Presentation.remote_version_id` exists.

The remote is a **protocol, not a client**, for the same reason `drain` takes its
sender as a callable: the behaviour worth testing is what this writes locally, and
it should be testable against a second store rather than only against a network.

Four refusals hold it together, and each is a way a bootstrap could quietly take
something it should not:

* **A local workspace is never converted into a mirror.** Otherwise a server that
  answered with an id matching one of this machine's own workspaces would take it
  over — decks and all — and the person would have handed it over by signing in.
* **Only workspaces the response says this user belongs to.** A role is what the
  server grants; a bootstrap that adopted a workspace with no membership would be
  inventing access rather than mirroring it.
* **Roles go through `confirm_membership`** (D5.4), which is the only writer of
  `confirmed_at`. A second writer would be a second way for a cache to start
  authorizing, and the value of that rule is that there is exactly one.
* **A workspace the server stops listing is revoked here**, immediately. That is
  the other half of D5.4's cache policy: the freshness window is for a device that
  *cannot* ask, and this is a device that just did.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import store
from .auth import confirm_membership, revoke_cached_membership
from .db.models import Presentation, Project, Workspace, WorkspaceMember
from .schema import validate_document


class RemoteWorkspace(Protocol):
    """What this device can ask the server for.

    Three reads, all of which the API already serves — `/v1/account`,
    `/v1/projects/{id}/presentations` and `/v1/presentations/{id}`. There is no
    new server surface in the bootstrap direction, and that is worth noticing:
    the cloud side of Deckastra is Deckastra, and a device is a second instance
    that mirrors from it.
    """

    def account(self) -> dict[str, Any]: ...

    def presentations(self, project_id: str) -> list[dict[str, Any]]: ...

    def document(self, presentation_id: str) -> dict[str, Any]: ...


@dataclass
class BootstrapReport:
    """What changed, named rather than counted where a person would want to know."""

    workspaces: list[str] = field(default_factory=list)
    projects_added: int = 0
    decks_pulled: list[str] = field(default_factory=list)
    decks_already_held: int = 0
    revoked: list[str] = field(default_factory=list)
    #: Things that were refused, in full. A bootstrap that skipped something and
    #: said nothing would leave a person wondering where a deck went.
    refused: list[str] = field(default_factory=list)


def adopt(
    session: Session, remote: RemoteWorkspace, *, user_id: str, pull_decks: bool = True
) -> BootstrapReport:
    """Mirror everything the server says this user can reach.

    Idempotent, because it runs every time someone signs in or reconnects: a
    workspace already held is refreshed rather than duplicated, and a deck already
    held is left alone. Leaving it alone is deliberate — the local copy may carry
    edits that have not been uploaded yet, and overwriting it with the server's
    would discard exactly the work the outbox exists to protect. Bringing a
    *changed* deck up to date is a merge, which is D5.3's machinery and not this
    function's business.
    """
    report = BootstrapReport()
    account = remote.account()

    remote_workspaces = {
        str(one["id"]): one
        for one in (account.get("workspaces") or [])
        # A workspace listed with no role for this user is not this user's to
        # mirror. `/v1/account` only lists memberships, so this is a guard
        # against a server answering something else rather than an expected case.
        if one.get("role")
    }

    for workspace_id, described in sorted(remote_workspaces.items()):
        problem = _adopt_workspace(session, described, user_id=user_id, report=report)
        if problem:
            report.refused.append(problem)
            continue
        report.workspaces.append(workspace_id)

        for project in described.get("projects") or []:
            problem = _adopt_project(
                session, project, workspace_id=workspace_id, report=report
            )
            if problem:
                # Refused, so nothing goes in it — and the return value is *read*
                # now. It used to be appended to the report and dropped, so a
                # project this device already had in a local workspace was
                # refused and then filled with the server's decks anyway: the
                # takeover the workspace guard exists to prevent, one level down
                # and through the door beside it (found by review, 2026-09-17).
                report.refused.append(problem)
                continue

            if pull_decks:
                _pull_decks(
                    session,
                    remote,
                    project_id=str(project["id"]),
                    user_id=user_id,
                    report=report,
                )

    _revoke_what_the_server_no_longer_lists(
        session, user_id=user_id, still_listed=set(remote_workspaces), report=report
    )
    session.flush()
    return report


def _adopt_workspace(
    session: Session, described: dict[str, Any], *, user_id: str, report: BootstrapReport
) -> str | None:
    """Create or refresh one mirrored workspace. Returns a refusal, or None."""
    workspace_id = str(described["id"])
    existing = session.get(Workspace, workspace_id)

    if existing is not None and existing.origin != "cloud":
        # The dangerous case. A server answering with an id that matches one of
        # this machine's own workspaces would otherwise take it over, decks and
        # all, and the person would have handed it over by signing in.
        return (
            f"{workspace_id} is already a workspace on this device and was not "
            "replaced by the server's."
        )

    if existing is None:
        session.add(
            Workspace(
                id=workspace_id,
                name=str(described.get("name") or "Workspace")[:200],
                # Whoever owns it there owns it there. This device records the
                # id it was told and never treats it as authorization — that is
                # membership's job (D5.4), and `owner_id` has never been the
                # authorization source.
                owner_id=user_id,
                origin="cloud",
            )
        )
        session.flush()
    else:
        existing.name = str(described.get("name") or existing.name)[:200]

    # Through `confirm_membership`, which is the only writer of `confirmed_at`
    # (D5.4) and carries the role as well as the freshness — a mirror that
    # refreshed one without the other would keep honouring an editor since
    # demoted to viewer.
    confirm_membership(
        session,
        user_id=user_id,
        workspace_id=workspace_id,
        role=str(described.get("role") or "viewer"),
    )
    return None


def _adopt_project(
    session: Session, described: dict[str, Any], *, workspace_id: str, report: BootstrapReport
) -> str | None:
    """Create or refresh one mirrored project. Returns a refusal, or None.

    A refusal rather than a report entry, because the caller has to *act* on it:
    a project that was not adopted must not then be filled with decks.
    """
    project_id = str(described["id"])
    existing = session.get(Project, project_id)

    if existing is not None:
        if existing.workspace_id != workspace_id:
            # A project cannot change workspace by being mirrored. Moving a deck
            # between workspaces is an explicit act with its own route and its own
            # refusals (D5.1); a pull is not one.
            return (
                f"project {project_id} is already in another workspace on this device, "
                "so nothing was pulled into it"
            )
        existing.name = str(described.get("name") or existing.name)[:200]
        return None

    session.add(
        Project(
            id=project_id,
            workspace_id=workspace_id,
            name=str(described.get("name") or "Project")[:200],
            description=described.get("description"),
            # The device's own account is recorded as the creator because
            # `created_by` is a local foreign key to `users`, and the person who
            # actually made it upstream may not have a row here. It is provenance
            # for display, never authorization.
            created_by=_local_user(session, workspace_id) or "",
        )
    )
    session.flush()
    report.projects_added += 1
    return None


def _local_user(session: Session, workspace_id: str) -> str | None:
    membership = session.scalar(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace_id)
    )
    return membership.user_id if membership else None


def _pull_decks(
    session: Session,
    remote: RemoteWorkspace,
    *,
    project_id: str,
    user_id: str,
    report: BootstrapReport,
) -> None:
    for summary in remote.presentations(project_id):
        presentation_id = str(summary["id"])

        if session.get(Presentation, presentation_id) is not None:
            # Already here. Not refreshed, deliberately: the local copy may carry
            # edits that have not been uploaded, and replacing it with the
            # server's would discard exactly the work the outbox exists to
            # protect. Catching a changed deck up is a merge (D5.3), not a pull.
            report.decks_already_held += 1
            continue

        answer = remote.document(presentation_id)
        document = answer.get("document")
        if not isinstance(document, dict) or document.get("id") != presentation_id:
            # The id in the document is the presentation id (D5.0). One that
            # disagrees with the row it arrived under would create a deck under
            # an id nothing else refers to.
            report.refused.append(
                f"{presentation_id} arrived with a document that names a different deck"
            )
            continue

        errors = validate_document(document)
        if errors:
            # A document this build cannot open is not made openable by storing
            # it. Refusing names the deck, so the person can see which one and
            # why rather than finding a gap in the list.
            report.refused.append(
                f"{presentation_id} did not validate against this build's schema: {errors[0]}"
            )
            continue

        store.create_presentation(
            session,
            project_id=project_id,
            document=document,
            created_by=user_id,
            source="import",
            # The whole point: a deck the server already has owes it nothing, and
            # queueing it would offer the server back what it just sent.
            from_server=True,
            remote_version_id=answer.get("version_id"),
        )
        report.decks_pulled.append(presentation_id)


def _revoke_what_the_server_no_longer_lists(
    session: Session, *, user_id: str, still_listed: set[str], report: BootstrapReport
) -> None:
    """The other half of D5.4's cache policy.

    A freshness window is for a device that *cannot* ask. This is a device that
    just asked and was told the membership is gone, so it stops now rather than
    running down a thirty-day clock. Only mirrored workspaces are considered:
    this machine's own are not the server's to revoke.
    """
    mirrored = session.scalars(
        select(WorkspaceMember)
        .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .where(WorkspaceMember.user_id == user_id, Workspace.origin == "cloud")
    ).all()

    for membership in mirrored:
        if membership.workspace_id in still_listed:
            continue
        if membership.revoked_at is not None:
            continue
        revoke_cached_membership(
            session, user_id=user_id, workspace_id=membership.workspace_id
        )
        report.revoked.append(membership.workspace_id)


class HttpRemote:
    """A cloud Deckastra, over HTTP.

    Three GETs against routes the API already serves. There is no bootstrap
    endpoint and there should not be one: a device pulling a workspace is a
    client reading the same things a browser reads, with the same bearer token
    and through the same `resolve_*` chain, so the server has no code path that
    exists only for syncing and therefore none that can drift from the one people
    use.

    **This has not been run against a live server**, because there is no deployed
    Deckastra to point it at. What is tested is `adopt` — against a real second
    store, which is where the decisions are. This class is the shape of the
    request, and the first real deployment will be the first time it is exercised.
    """

    #: One request per page. The route caps a page at 500; asking for that many
    #: keeps an ordinary workspace to a single round trip.
    PAGE = 500
    #: A ceiling on the whole walk, so a misbehaving cursor cannot loop forever.
    MAX_DECKS = 100_000

    def __init__(self, base_url: str, token: str, *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def _get(self, path: str) -> dict[str, Any]:
        import httpx

        with httpx.Client(timeout=self._timeout) as client:
            answer = client.get(
                f"{self.base_url}{path}",
                headers={"Authorization": f"Bearer {self._token}"},
            )
        if answer.status_code >= 400:
            # Raised rather than returned, so a bootstrap that could not read the
            # account stops instead of proceeding to revoke every mirrored
            # membership on the strength of an empty answer. That mistake would
            # lock a person out of their own decks because their network was
            # down, which is the opposite of what any of this is for.
            raise RemoteUnavailable(
                f"The server answered {answer.status_code} for {path}."
            )
        return answer.json()

    def account(self) -> dict[str, Any]:
        return self._get("/v1/account")

    def presentations(self, project_id: str) -> list[dict[str, Any]]:
        """Every deck in the project, not the first page of them.

        This read the route's default and stopped at 200 without saying so, so a
        project with more decks than that mirrored a prefix and looked complete
        (found by review, 2026-09-17). A bootstrap that quietly leaves decks
        behind is the worst kind of bug here: the person sees a workspace, sees
        decks in it, and has no reason to think anything is missing.

        Paged by id, which is the ordering that cannot shift under a reader —
        somebody editing a deck while this walks moves it in `updated_at` order
        and would skip or repeat it.
        """
        found: list[dict[str, Any]] = []
        after = ""
        while True:
            page = self._get(
                f"/v1/projects/{project_id}/presentations?limit={self.PAGE}&after={after}"
            )
            found.extend(page["presentations"])
            cursor = page.get("next_after")
            if not cursor:
                return found
            if len(found) > self.MAX_DECKS:
                # A cursor that never ends means the server is answering
                # something this client does not understand. Stopping with an
                # error beats looping forever or mirroring half a workspace.
                raise RemoteUnavailable(
                    f"The server kept paging past {self.MAX_DECKS} decks in one project."
                )
            after = cursor

    def document(self, presentation_id: str) -> dict[str, Any]:
        return self._get(f"/v1/presentations/{presentation_id}")


class RemoteUnavailable(Exception):
    """The server could not be read, so nothing is concluded from the silence."""
