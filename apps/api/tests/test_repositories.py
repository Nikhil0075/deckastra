"""Journey B: repository to deck (doc 05 §19-§20, doc 02 §30).

The exit criterion for this phase is "connect a real repository, generate a
grounded deck, click any slide and see its sources". These cover the whole of
that path, and the boundaries around it — a repository is scoped to a workspace,
a webhook must be signed, and access withdrawn means content deleted.

They index a real directory: a small tree written to a temp path, and in one case
this repository itself. A fixture repository would only ever contain the shapes
the test author thought of.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402

WEBHOOK_SECRET = "test-webhook-secret"


@pytest.fixture()
def sample_repo(tmp_path) -> Path:
    """A small but realistic repository."""
    root = tmp_path / "ledger-recon"
    (root / "src" / "ledger").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "node_modules" / "junk").mkdir(parents=True)

    (root / "README.md").write_text(
        "# ledger-recon\n\n"
        "Reconciles payment ledgers against processor settlements.\n\n"
        "## Retries\n\n"
        "Failed settlements are retried with exponential backoff.\n",
        encoding="utf-8",
    )
    (root / "pyproject.toml").write_text(
        '[project]\nname = "ledger-recon"\ndependencies = ["fastapi>=0.115", "sqlalchemy>=2"]\n',
        encoding="utf-8",
    )
    (root / "src" / "ledger" / "main.py").write_text(
        "def main():\n    reconcile()\n\n\ndef reconcile():\n    return 'done'\n",
        encoding="utf-8",
    )
    (root / "src" / "ledger" / "retry.py").write_text(
        "BACKOFF_SECONDS = [1, 2, 4, 8]\n\n\n"
        "def with_backoff(attempt):\n"
        "    return BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]\n",
        encoding="utf-8",
    )
    (root / "docs" / "architecture.md").write_text(
        "# Architecture\n\nThe settlement worker reads from Postgres.\n", encoding="utf-8"
    )
    # Must never be indexed.
    (root / ".env").write_text("SECRET_KEY=hunter2\n", encoding="utf-8")
    (root / "node_modules" / "junk" / "index.js").write_text("module.exports={}\n", encoding="utf-8")

    return root


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'repos.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_ALLOW_LOCAL_REPOS", "1")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setenv(
        "GITHUB_APP_PRIVATE_KEY",
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode(),
    )

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "repo@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def indexed(client, auth, sample_repo):
    connected = client.post(
        "/v1/repositories/local",
        headers=auth,
        json={"path": str(sample_repo), "label": "acme/ledger-recon"},
    )
    assert connected.status_code == 200, connected.text

    repository_id = connected.json()["id"]
    result = client.post(f"/v1/repositories/{repository_id}/index", headers=auth)
    assert result.status_code == 200, result.text
    return result.json()


# ---------------------------------------------------------------- indexing


def test_indexing_reads_source_and_skips_what_it_should(indexed):
    index = indexed["index"]

    assert index["files_indexed"] >= 4
    assert indexed["index_status"] == "ready"
    assert indexed["chunk_count"] > 0

    profile = indexed["profile"]
    assert "Python" in profile["languages"]
    # Read from the manifest, not guessed from prose.
    assert "FastAPI" in profile["frameworks"]
    assert "SQLAlchemy" in profile["frameworks"]
    assert any(path.endswith("main.py") for path in profile["entry_points"])


def test_secrets_and_vendored_code_are_never_indexed(client, auth, indexed):
    """The rule that matters most.

    An indexed `.env` is a secret in a database and a retrieved chunk of one ends
    up in a prompt.
    """
    response = client.post(
        "/v1/repositories/search",
        headers=auth,
        json={"query": "SECRET_KEY hunter2 module exports", "limit": 20},
    )
    paths = {hit["path"] for hit in response.json()["hits"]}

    assert not any(path.endswith(".env") for path in paths)
    assert not any("node_modules" in path for path in paths)


def test_search_finds_the_right_file_and_says_why(client, auth, indexed):
    response = client.post(
        "/v1/repositories/search", headers=auth, json={"query": "exponential backoff retry"}
    )
    assert response.status_code == 200
    body = response.json()

    assert body["hits"], "expected a match for a term that is in the repository"
    top = body["hits"][0]
    assert "retry" in top["path"] or "README" in top["path"]
    # Doc 03 §8: the agent must be able to explain why a file was selected.
    assert top["why_selected"]
    # Doc 02 §30: a citation a reader cannot open is not a citation.
    assert top["reference"] == f"{top['path']}:{top['start_line']}-{top['end_line']}"


def test_a_query_about_something_absent_returns_nothing(client, auth, indexed):
    """An empty answer beats a bad one.

    Otherwise the agent cites the least irrelevant file it could find, and the
    slide gets a citation that does not support it.
    """
    response = client.post(
        "/v1/repositories/search",
        headers=auth,
        json={"query": "kubernetes helm chart ingress annotations"},
    )
    assert response.json()["hits"] == []


def test_the_index_says_it_is_lexical_when_it_is(client, auth, indexed):
    # A user comparing two decks needs to know one was searched lexically.
    assert indexed["embedding_semantic"] is False
    assert indexed["embedding_model"] == "bm25"


def test_reindexing_is_incremental(client, auth, sample_repo, indexed):
    """A push changes a few files; re-embedding everything for that is waste."""
    from deckastra_api import repository_service
    from deckastra_api.db.models import Repository

    (sample_repo / "src" / "ledger" / "retry.py").write_text(
        "BACKOFF_SECONDS = [1, 2, 4, 8, 16]\n", encoding="utf-8"
    )

    with db_session.session_scope() as session:
        repository = session.query(Repository).one()
        result = repository_service.reindex(
            session, repository, changed_paths=["src/ledger/retry.py"]
        )

    assert result.chunks_reused > 0
    assert result.files_indexed >= 1


# --------------------------------------------------------------- staleness


def test_a_directory_without_a_commit_reports_unknown_not_fresh(indexed):
    """"Unknown" is not "up to date".

    A source whose version cannot be read is exactly the case where a deck
    silently drifts, so it must not look identical to a current one.
    """
    assert indexed["staleness"]["state"] == "unknown"
    assert "cannot tell" in indexed["staleness"]["message"]


def test_a_push_marks_the_index_stale(client, auth, indexed):
    from deckastra_api.db.models import Repository

    repository_id = indexed["id"]

    with db_session.session_scope() as session:
        repository = session.get(Repository, repository_id)
        repository.indexed_sha = "aaaaaaa"
        repository.head_sha = "aaaaaaa"

    body = json.dumps(
        {
            "repository": {"full_name": "acme/ledger-recon"},
            "after": "bbbbbbb",
            "commits": [{"added": [], "modified": ["README.md"], "removed": []}],
        }
    ).encode()

    response = client.post(
        "/v1/github/webhook",
        content=body,
        headers={
            "X-GitHub-Event": "push",
            "X-Hub-Signature-256": "sha256="
            + hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest(),
        },
    )
    assert response.status_code == 200

    listed = client.get("/v1/repositories", headers=auth).json()["repositories"][0]
    assert listed["staleness"]["state"] == "stale"


# ---------------------------------------------------------------- webhooks


def test_an_unsigned_webhook_is_rejected(client):
    response = client.post(
        "/v1/github/webhook", content=b"{}", headers={"X-GitHub-Event": "push"}
    )
    assert response.status_code == 401
    # Nothing useful in the body: a detailed error is an oracle for guessing the
    # secret.
    assert response.json()["detail"] == "Rejected."


def test_a_badly_signed_webhook_is_rejected(client):
    response = client.post(
        "/v1/github/webhook",
        content=b"{}",
        headers={"X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=deadbeef"},
    )
    assert response.status_code == 401


def test_losing_access_deletes_what_was_indexed(client, auth, indexed):
    """Access withdrawn means content deleted.

    An index that outlives its permission is data we are no longer allowed to
    hold.
    """
    from deckastra_api.db.models import Repository, RepositoryChunk

    repository_id = indexed["id"]

    with db_session.session_scope() as session:
        assert (
            session.query(RepositoryChunk)
            .filter(RepositoryChunk.repository_id == repository_id)
            .count()
            > 0
        )

    body = json.dumps(
        {"action": "deleted", "repository": {"full_name": "acme/ledger-recon"}}
    ).encode()

    response = client.post(
        "/v1/github/webhook",
        content=body,
        headers={
            "X-GitHub-Event": "repository",
            "X-Hub-Signature-256": "sha256="
            + hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest(),
        },
    )
    assert response.status_code == 200

    with db_session.session_scope() as session:
        assert (
            session.query(RepositoryChunk)
            .filter(RepositoryChunk.repository_id == repository_id)
            .count()
            == 0
        )
        assert session.get(Repository, repository_id).index_status == "revoked"


# -------------------------------------------------------------- boundaries


def test_a_stranger_cannot_see_another_workspaces_repository(client, auth, indexed):
    other = client.post("/v1/dev/session", json={"email": "stranger@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}

    assert client.get("/v1/repositories", headers=stranger).json()["repositories"] == []

    # 404, not 403: a 403 on something you cannot see confirms it exists.
    response = client.post(f"/v1/repositories/{indexed['id']}/index", headers=stranger)
    assert response.status_code == 404


def test_search_never_crosses_a_workspace(client, auth, indexed):
    other = client.post("/v1/dev/session", json={"email": "stranger2@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}

    response = client.post(
        "/v1/repositories/search",
        headers=stranger,
        # Naming the id explicitly: resolution is scoped, so it is dropped.
        json={"query": "backoff", "repository_ids": [indexed["id"]]},
    )
    assert response.json()["hits"] == []


def test_local_repositories_are_off_unless_enabled(client, auth, sample_repo, monkeypatch):
    """A server that indexes arbitrary host paths is a file-read primitive."""
    monkeypatch.delenv("DECKASTRA_ALLOW_LOCAL_REPOS", raising=False)

    response = client.post(
        "/v1/repositories/local", headers=auth, json={"path": str(sample_repo)}
    )
    assert response.status_code == 400
    assert "disabled" in response.json()["detail"]["message"]


def test_disconnecting_removes_the_content(client, auth, indexed):
    from deckastra_api.db.models import RepositoryChunk

    response = client.delete(f"/v1/repositories/{indexed['id']}", headers=auth)
    assert response.status_code == 200

    with db_session.session_scope() as session:
        assert (
            session.query(RepositoryChunk)
            .filter(RepositoryChunk.repository_id == indexed["id"])
            .count()
            == 0
        )


def test_a_hit_names_the_repository_it_actually_came_from(client, auth, indexed, tmp_path):
    """Two repositories, two files with the same name, two distinct citations.

    Every hit used to be attributed to the *first* connected repository, and the
    deduplication keyed on `path:lines` alone — so a second repository's
    `README.md` was either mis-attributed or dropped as a duplicate. A citation
    naming the wrong repository is worse than no citation: it is a claim a reader
    will check and find is not there.
    """
    second = tmp_path / "billing-core"
    (second / "src").mkdir(parents=True)
    (second / "README.md").write_text(
        "# billing-core\n\n"
        "## Retries\n\n"
        "Failed settlements are retried with exponential backoff here too.\n",
        encoding="utf-8",
    )
    (second / "src" / "retry.py").write_text(
        "BACKOFF_SECONDS = [1, 2, 4, 8]\n", encoding="utf-8"
    )

    # The free plan connects one repository, and one repository is exactly the
    # condition under which this bug is invisible.
    from deckastra_api.db.models import WorkspaceQuota

    with db_session.session_scope() as session:
        session.query(WorkspaceQuota).update({WorkspaceQuota.max_repositories: 5})

    connected = client.post(
        "/v1/repositories/local",
        headers=auth,
        json={"path": str(second), "label": "acme/billing-core"},
    )
    assert connected.status_code == 200, connected.text
    assert client.post(
        f"/v1/repositories/{connected.json()['id']}/index", headers=auth
    ).status_code == 200

    hits = client.post(
        "/v1/repositories/search", headers=auth, json={"query": "backoff retries"}
    ).json()["hits"]

    names = {hit["repository"] for hit in hits}
    assert names == {"acme/ledger-recon", "acme/billing-core"}, hits

    # Each citation is whole, and the two same-named files are two citations.
    for hit in hits:
        assert hit["source_id"] == f"{hit['repository']}#{hit['reference']}"

    readmes = {hit["source_id"] for hit in hits if hit["path"] == "README.md"}
    assert len(readmes) == len({hit["repository"] for hit in hits if hit["path"] == "README.md"})


# ------------------------------------------------------- grounded generation


def test_a_grounded_deck_records_where_its_claims_came_from(client, auth, indexed):
    """The phase's exit criterion, end to end."""
    generated = client.post(
        "/v1/generate",
        headers=auth,
        json={
            "instruction": "Explain how ledger-recon reconciles settlements",
            "slide_count": 4,
            "repository_ids": [indexed["id"]],
        },
    )
    assert generated.status_code == 200, generated.text
    body = generated.json()

    runs = client.get(f"/v1/presentations/{body['presentation_id']}/runs", headers=auth)
    assert runs.json()[0]["status"] == "completed"

    # Provenance lives in the document, not a side table (doc 02 §30), so it
    # survives export and duplication.
    document = body["document"]
    records = document.get("provenance") or []
    assert records, "a deck generated from a repository must record where it came from"

    # `owner/repo#path:start-end` — the exact form doc 02 §30 specifies, because
    # a citation a reader cannot open is not a citation.
    for record in records:
        repository, _, rest = record["sourceReference"].partition("#")
        assert repository == "acme/ledger-recon"
        path, _, lines = rest.partition(":")
        assert path and re.fullmatch(r"\d+-\d+", lines), record["sourceReference"]

    # The exit criterion: click a slide, see its sources.
    cited = {record["targetId"] for record in records}
    slide_id = next(
        slide["id"]
        for slide in document["slides"]
        if any(element["id"] in cited for element in slide["elements"])
    )

    sources = client.get(
        f"/v1/presentations/{body['presentation_id']}/slides/{slide_id}/sources",
        headers=auth,
    )
    assert sources.status_code == 200
    listed = sources.json()["sources"]
    assert listed

    for source in listed:
        assert source["excerpt"]
        # A local checkout has no branch and no public URL, so no link is offered
        # rather than one that 404s.
        assert source["url"] is None


def test_a_deck_grounded_in_nothing_claims_nothing(client, auth):
    """The absence of provenance is itself information.

    A deck with no repository must not carry citations — an empty or invented
    record would assert a source that does not exist, which is worse than saying
    nothing.
    """
    generated = client.post(
        "/v1/generate",
        headers=auth,
        json={"instruction": "A deck about tea", "slide_count": 3},
    )
    assert not generated.json()["document"].get("provenance")


def test_a_repository_from_another_workspace_is_not_a_source(client, auth, indexed):
    other = client.post("/v1/dev/session", json={"email": "stranger3@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}

    generated = client.post(
        "/v1/generate",
        headers=stranger,
        json={
            "instruction": "Explain their private codebase",
            "slide_count": 3,
            "repository_ids": [indexed["id"]],
        },
    )
    # Generation succeeds; the repository is simply not used. Silently dropping
    # is right here — the id may be stale — but it must never become a source.
    assert generated.status_code == 200
    assert not generated.json()["document"].get("provenance")
