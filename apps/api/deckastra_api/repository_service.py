"""Connecting repositories, and keeping their indexes honest.

The API-facing half of Phase 6: create a repository row, build a source adapter
for it, index it, and act on webhook events. The pipeline itself is in
`indexing.py`; this is where it meets the database and the workspace.

One rule shapes the whole module: **a repository belongs to a workspace, and
access is checked here, not by the caller.** A retrieval that reached across
workspaces would leak one customer's private code into another's deck, which is
the worst failure this feature could have — so every lookup goes through
`for_workspace`.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from deckastra_integrations.github.app import AppCredentials, InstallationTokens
from deckastra_integrations.github.client import GitHubClient, GitHubSource
from deckastra_integrations.sources import LocalDirectorySource, SourceAdapter, SourceUnavailable
from sqlalchemy.orm import Session

from .db.models import GitHubInstallation, Repository, RepositoryChunk
from .embeddings import default_embedder
from .ids import new_id
from .indexing import IndexResult, index_repository, staleness
from .retrieval import sync_pgvector_column

logger = logging.getLogger("deckastra.repositories")


class RepositoryError(RuntimeError):
    """A repository operation failed, with a reason a user can act on."""

    def __init__(self, message: str, *, code: str = "E600") -> None:
        super().__init__(message)
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ lookups


def for_workspace(session: Session, workspace_id: str, repository_id: str) -> Repository:
    """One repository, or a 404-shaped error.

    Scoped by workspace in the query rather than checked afterwards: a filter
    that has to be remembered is a filter that gets forgotten, and forgetting it
    here means cross-tenant code retrieval.
    """
    repository = (
        session.query(Repository)
        .filter(Repository.id == repository_id, Repository.workspace_id == workspace_id)
        .one_or_none()
    )
    if repository is None:
        # 404 rather than 403: a 403 on something you cannot see confirms it
        # exists (doc 05 §27).
        raise RepositoryError("No such repository.", code="E404")
    return repository


def list_for_workspace(session: Session, workspace_id: str) -> list[Repository]:
    return (
        session.query(Repository)
        .filter(Repository.workspace_id == workspace_id)
        .order_by(Repository.created_at.desc())
        .all()
    )


def resolve_many(session: Session, workspace_id: str, ids: list[str]) -> list[Repository]:
    """Several repositories, silently dropping any the workspace cannot see.

    Silent because this runs on the retrieval path with ids that may be stale —
    a deck referencing a repository that was disconnected should lose that
    source, not fail to generate.
    """
    if not ids:
        return []
    return (
        session.query(Repository)
        .filter(Repository.id.in_(ids), Repository.workspace_id == workspace_id)
        .all()
    )


# ------------------------------------------------------------- source adapters


def source_for(repository: Repository) -> SourceAdapter:
    """Build the adapter that can read this repository."""
    if repository.source == "local":
        if not repository.local_path:
            raise RepositoryError("This local repository has no path recorded.", code="E601")
        try:
            return LocalDirectorySource(
                repository.local_path,
                owner=repository.full_name.split("/")[0] if "/" in repository.full_name else "local",
                name=repository.full_name.split("/")[-1],
            )
        except SourceUnavailable as error:
            raise RepositoryError(str(error), code="E601") from error

    credentials = AppCredentials.from_environment()
    if credentials is None:
        raise RepositoryError(
            "GitHub is not configured on this server. Set GITHUB_APP_ID and "
            "GITHUB_APP_PRIVATE_KEY, or connect a local directory instead.",
            code="E602",
        )

    if repository.installation_id is None:
        raise RepositoryError("This repository has no GitHub installation.", code="E602")

    installation = repository.installation_id
    owner, _, name = repository.full_name.partition("/")

    return GitHubSource(
        GitHubClient(tokens=InstallationTokens(credentials), installation_id=installation),
        owner=owner,
        name=name,
    )


# --------------------------------------------------------------- connecting


@dataclass
class ConnectResult:
    repository: Repository
    index: IndexResult


def connect_local(
    session: Session,
    *,
    workspace_id: str,
    path: str,
    label: str | None = None,
) -> Repository:
    """Connect a directory on disk.

    Real, not a stand-in. A user pointing at a checkout they already have is a
    legitimate way to use this, it is how the feature is developed, and it is the
    only path that works before a GitHub App is registered.

    Gated by an environment flag because a server that indexes arbitrary host
    paths on request is a file-read primitive for anyone with an account.
    """
    if os.environ.get("DECKASTRA_ALLOW_LOCAL_REPOS") != "1":
        raise RepositoryError(
            "Local repositories are disabled on this server. Set "
            "DECKASTRA_ALLOW_LOCAL_REPOS=1 to enable them for development.",
            code="E603",
        )

    try:
        source = LocalDirectorySource(path)
    except SourceUnavailable as error:
        raise RepositoryError(str(error), code="E601") from error

    info = source.info()
    full_name = label or f"{info.owner}/{info.name}"

    existing = (
        session.query(Repository)
        .filter(Repository.workspace_id == workspace_id, Repository.full_name == full_name)
        .one_or_none()
    )
    if existing is not None:
        existing.local_path = str(path)
        existing.index_status = "pending"
        session.flush()
        return existing

    repository = Repository(
        id=new_id("rep"),
        workspace_id=workspace_id,
        source="local",
        full_name=full_name,
        default_branch=info.default_branch,
        description=info.description,
        local_path=str(path),
        index_status="pending",
        head_sha=info.head_sha,
    )
    session.add(repository)
    session.flush()
    return repository


def record_installation(
    session: Session,
    *,
    workspace_id: str,
    github_installation_id: str,
    account_login: str,
    installed_by: str,
) -> GitHubInstallation:
    """Record a completed App installation (doc 05 §19).

    Idempotent: GitHub redirects to the callback and may deliver the
    `installation` webhook for the same event, so both paths land here and the
    second one must not create a duplicate.
    """
    existing = (
        session.query(GitHubInstallation)
        .filter(GitHubInstallation.github_installation_id == github_installation_id)
        .one_or_none()
    )

    if existing is not None:
        existing.workspace_id = workspace_id
        existing.account_login = account_login
        existing.revoked_at = None
        session.flush()
        return existing

    installation = GitHubInstallation(
        id=new_id("ghi"),
        workspace_id=workspace_id,
        github_installation_id=github_installation_id,
        account_login=account_login,
        installed_by=installed_by,
    )
    session.add(installation)
    session.flush()
    return installation


def connect_github(
    session: Session,
    *,
    workspace_id: str,
    installation: GitHubInstallation,
    full_name: str,
    github_repository_id: str | None = None,
) -> Repository:
    existing = (
        session.query(Repository)
        .filter(Repository.workspace_id == workspace_id, Repository.full_name == full_name)
        .one_or_none()
    )
    if existing is not None:
        existing.installation_id = installation.id
        existing.index_status = "pending"
        session.flush()
        return existing

    repository = Repository(
        id=new_id("rep"),
        workspace_id=workspace_id,
        installation_id=installation.id,
        source="github",
        full_name=full_name,
        github_repository_id=github_repository_id,
        index_status="pending",
    )
    session.add(repository)
    session.flush()
    return repository


# ----------------------------------------------------------------- indexing


def reindex(
    session: Session,
    repository: Repository,
    *,
    changed_paths: list[str] | None = None,
) -> IndexResult:
    """Index or re-index, then make the vectors searchable."""
    result = index_repository(
        session,
        repository,
        source_for(repository),
        embedder=default_embedder(),
        changed_paths=changed_paths,
    )
    sync_pgvector_column(session, repository.id)
    return result


def disconnect(session: Session, repository: Repository) -> None:
    """Remove a repository and everything indexed from it.

    A hard delete, not a soft one. The rows hold copies of a customer's source
    code; keeping them after they disconnected would be keeping content they
    asked us to stop holding.
    """
    session.query(RepositoryChunk).filter(
        RepositoryChunk.repository_id == repository.id
    ).delete(synchronize_session=False)
    session.delete(repository)
    session.flush()


# ----------------------------------------------------------------- webhooks


def apply_webhook(session: Session, event: Any) -> dict[str, Any]:
    """Act on a verified webhook (gap register doc 05 S2).

    Marks rather than indexes. Re-indexing inside a webhook handler means GitHub
    waits for an embedding run and times out; marking the repository stale is
    immediate, honest, and leaves the work to whoever asks next.
    """
    outcome: dict[str, Any] = {"kind": event.kind, "affected": []}

    if event.kind == "push":
        for full_name in event.repositories:
            repository = _by_full_name(session, event.installation_id, full_name)
            if repository is None:
                continue
            # The head moves; the index does not. That difference is the
            # staleness signal the UI shows.
            repository.head_sha = event.after_sha or repository.head_sha
            outcome["affected"].append(repository.id)
        session.flush()
        return outcome

    if event.kind in {"installation_deleted", "repository_deleted"}:
        # Access is gone. Content indexed from it must go too — an index that
        # outlives its permission is data we are no longer allowed to hold.
        for repository in _all_for_installation(session, event.installation_id, event.repositories):
            session.query(RepositoryChunk).filter(
                RepositoryChunk.repository_id == repository.id
            ).delete(synchronize_session=False)
            repository.index_status = "revoked"
            repository.chunk_count = 0
            repository.index_error = "Access to this repository was withdrawn."
            outcome["affected"].append(repository.id)

        if event.kind == "installation_deleted" and event.installation_id:
            installation = (
                session.query(GitHubInstallation)
                .filter(GitHubInstallation.github_installation_id == event.installation_id)
                .one_or_none()
            )
            if installation is not None:
                installation.revoked_at = _now()

        session.flush()
        return outcome

    if event.kind == "installation_repositories":
        # `changed_paths` carries the removed repositories for this event kind.
        for full_name in event.changed_paths:
            repository = _by_full_name(session, event.installation_id, full_name)
            if repository is None:
                continue
            session.query(RepositoryChunk).filter(
                RepositoryChunk.repository_id == repository.id
            ).delete(synchronize_session=False)
            repository.index_status = "revoked"
            repository.chunk_count = 0
            repository.index_error = "This repository was removed from the installation."
            outcome["affected"].append(repository.id)
        session.flush()
        return outcome

    return outcome


def _by_full_name(session: Session, installation_id: str | None, full_name: str) -> Repository | None:
    if not full_name:
        return None
    query = session.query(Repository).filter(Repository.full_name == full_name)

    if installation_id:
        installation = (
            session.query(GitHubInstallation)
            .filter(GitHubInstallation.github_installation_id == installation_id)
            .one_or_none()
        )
        if installation is not None:
            query = query.filter(Repository.installation_id == installation.id)

    return query.first()


def _all_for_installation(
    session: Session, installation_id: str | None, full_names: list[str]
) -> list[Repository]:
    if full_names and any(full_names):
        return [
            repository
            for repository in (
                _by_full_name(session, installation_id, name) for name in full_names if name
            )
            if repository is not None
        ]

    if not installation_id:
        return []

    installation = (
        session.query(GitHubInstallation)
        .filter(GitHubInstallation.github_installation_id == installation_id)
        .one_or_none()
    )
    if installation is None:
        return []

    return session.query(Repository).filter(Repository.installation_id == installation.id).all()


def describe(repository: Repository) -> dict[str, Any]:
    """A repository as the UI shows it, staleness included."""
    return {
        "id": repository.id,
        "full_name": repository.full_name,
        "source": repository.source,
        "description": repository.description or "",
        "default_branch": repository.default_branch,
        "index_status": repository.index_status,
        "file_count": repository.file_count,
        "chunk_count": repository.chunk_count,
        "embedding_model": repository.embedding_model,
        "embedding_semantic": repository.embedding_semantic,
        "last_indexed_at": repository.last_indexed_at.isoformat()
        if repository.last_indexed_at
        else None,
        "profile": repository.profile_json or {},
        "warnings": repository.warnings_json or [],
        "staleness": staleness(repository),
    }
