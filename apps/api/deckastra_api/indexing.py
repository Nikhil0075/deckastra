"""The repository indexing pipeline (doc 05 §20).

Ten steps in the spec; the shape they take here, and why:

    tree → filter → rank → read (top N only) → chunk → embed → store → profile

The step the spec numbers but does not emphasise is **read only what ranked**.
A repository has thousands of files; the ranking decides which few hundred are
worth a network round trip, and doing that from the tree alone is the difference
between indexing in seconds and in an hour.

Two rules hold throughout:

- **No repository code is executed.** Doc 05 §20 says so and this module makes it
  easy to keep true: the pipeline only ever reads bytes. Even the local adapter
  reads `.git/HEAD` rather than running git.
- **Nothing is indexed that looks like a secret.** An embedding of a private key
  is a private key in a database, and a retrieved chunk of one ends up in a
  prompt.

Re-indexing is incremental. A push changes a handful of files; re-embedding a
whole repository for that would be slow and, with a paid embedder, expensive. A
file whose blob sha is unchanged keeps its chunks.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

from deckastra_integrations.ignore import MAX_INDEXED_FILES, should_index_content, should_index_path
from deckastra_integrations.ranking import (
    Chunk,
    RankedFile,
    chunk_text,
    detect_frameworks,
    rank_tree,
)
from deckastra_integrations.sources import SourceAdapter, SourceUnavailable
from sqlalchemy.orm import Session

from .db.models import Repository, RepositoryChunk
from .embeddings import Embedder, default_embedder
from .ids import new_id

logger = logging.getLogger("deckastra.indexing")

#: How many ranked files are actually read. Past this the marginal file is a test
#: helper nobody will cite, and every one costs a fetch and an embedding.
DEFAULT_FILE_BUDGET = 400

#: Manifests are read regardless of rank, because framework detection needs them
#: and there are only ever a handful.
ALWAYS_READ = {
    "package.json", "pyproject.toml", "go.mod", "cargo.toml", "requirements.txt",
    "composer.json", "gemfile", "pom.xml", "build.gradle",
}


@dataclass
class IndexResult:
    repository_id: str
    files_seen: int = 0
    files_indexed: int = 0
    files_skipped: int = 0
    chunks: int = 0
    chunks_reused: int = 0
    languages: dict[str, int] = field(default_factory=dict)
    frameworks: list[str] = field(default_factory=list)
    entry_points: list[str] = field(default_factory=list)
    important_files: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    head_sha: str | None = None
    embedding_model: str = ""
    embedding_semantic: bool = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def index_repository(
    session: Session,
    repository: Repository,
    source: SourceAdapter,
    *,
    embedder: Embedder | None = None,
    file_budget: int = DEFAULT_FILE_BUDGET,
    changed_paths: Iterable[str] | None = None,
) -> IndexResult:
    """Build or refresh a repository's index.

    `changed_paths` makes it incremental: given a set of paths from a push, only
    those are re-read and re-embedded, and every other file keeps its chunks. A
    `None` means a full index.

    `embedder` may be `None`, which means no key is configured. The chunks are
    still stored — they are what BM25 searches — and no embedding work is done,
    because an embedding nothing will query is time and money spent on nothing.
    """
    if embedder is None:
        embedder = default_embedder()
    result = IndexResult(repository_id=repository.id)

    repository.index_status = "indexing"
    repository.index_error = None
    session.flush()

    try:
        info = source.info()
        result.head_sha = info.head_sha

        entries = list(source.tree())
        result.files_seen = len(entries)

        # Step 3: filter before ranking. A path that will never be indexed should
        # not occupy a slot in the ranking.
        candidates: list[tuple[str, int]] = []
        for entry in entries:
            decision = should_index_path(entry.path, entry.size_bytes)
            if decision.indexed:
                candidates.append((entry.path, entry.size_bytes))
            else:
                result.files_skipped += 1

        if len(candidates) > MAX_INDEXED_FILES:
            result.warnings.append(
                f"This repository has {len(candidates)} indexable files; the "
                f"{MAX_INDEXED_FILES} most relevant were indexed."
            )
            candidates = candidates[:MAX_INDEXED_FILES]

        # Steps 5-6: rank, then read only the top of the list.
        ranked = rank_tree(candidates)
        shas = {entry.path: entry.sha for entry in entries}

        selected = _select(ranked, file_budget)
        changed = set(changed_paths) if changed_paths is not None else None

        existing = _existing_chunks(session, repository.id)
        keep: set[str] = set()
        fresh: list[tuple[RankedFile, Chunk]] = []
        manifests: dict[str, str] = {}

        for file in selected:
            sha = shas.get(file.path)
            previous = existing.get(file.path)

            # Incremental: unchanged sha and not named by the push means the
            # chunks we already have are still correct.
            reusable = (
                changed is not None
                and file.path not in changed
                and previous is not None
                and sha is not None
                and previous == sha
            )
            if reusable:
                keep.add(file.path)
                result.chunks_reused += 1
                continue

            try:
                text = source.read(file.path)
            except SourceUnavailable as error:
                result.warnings.append(f"Could not read {file.path}: {error}")
                continue

            content_decision = should_index_content(text)
            if not content_decision.indexed:
                result.files_skipped += 1
                continue

            if file.path.rsplit("/", 1)[-1].lower() in ALWAYS_READ:
                manifests[file.path] = text

            for chunk in chunk_text(file.path, text):
                fresh.append((file, chunk))

            result.files_indexed += 1
            if file.language:
                result.languages[file.language] = result.languages.get(file.language, 0) + 1

        # Manifests are read even when they did not make the budget: framework
        # detection depends on them and there are only ever a few.
        for path, size in candidates:
            name = path.rsplit("/", 1)[-1].lower()
            if name in ALWAYS_READ and path not in manifests:
                try:
                    manifests[path] = source.read(path)
                except SourceUnavailable:
                    continue

        result.frameworks = detect_frameworks(manifests)
        result.entry_points = [
            file.path for file in selected if "entry point" in file.why.lower()
        ][:10]
        result.important_files = [
            {"path": file.path, "score": round(file.score, 1), "why": file.why, "language": file.language}
            for file in selected[:25]
        ]

        _replace_chunks(session, repository.id, keep_paths=keep)

        if fresh:
            if embedder is not None:
                batch = embedder.embed([chunk.text for _, chunk in fresh])
                vectors: list[list[float] | None] = list(batch.vectors)
                result.embedding_model = batch.model
                result.embedding_semantic = batch.semantic
            else:
                # No key: the chunks are stored for BM25 and nothing is embedded.
                vectors = [None] * len(fresh)
                result.embedding_model = "bm25"
                result.embedding_semantic = False

            for (file, chunk), vector in zip(fresh, vectors):
                session.add(
                    RepositoryChunk(
                        id=new_id("chk"),
                        repository_id=repository.id,
                        path=chunk.path,
                        start_line=chunk.start_line,
                        end_line=chunk.end_line,
                        language=chunk.language or None,
                        content=chunk.text,
                        file_sha=shas.get(chunk.path),
                        importance=file.score,
                        selection_reason=file.why,
                        embedding_json=vector,
                    )
                )
        else:
            result.embedding_model = embedder.model if embedder else "bm25"
            result.embedding_semantic = bool(embedder and embedder.semantic)

        session.flush()
        result.chunks = _count_chunks(session, repository.id)

        repository.index_status = "ready"
        repository.indexed_sha = info.head_sha
        repository.head_sha = info.head_sha
        repository.last_indexed_at = _now()
        repository.file_count = result.files_indexed
        repository.chunk_count = result.chunks
        repository.embedding_model = result.embedding_model
        repository.embedding_semantic = result.embedding_semantic
        repository.default_branch = info.default_branch
        repository.description = info.description or repository.description
        repository.profile_json = {
            "languages": result.languages,
            "frameworks": result.frameworks,
            "entry_points": result.entry_points,
            "important_files": result.important_files,
        }
        repository.warnings_json = result.warnings

        if info.head_sha is None:
            # A working directory has no commit, so staleness cannot be judged.
            # Saying so beats reporting it as permanently fresh.
            result.warnings.append(
                "This source has no commit id, so Deckastra cannot tell when it "
                "falls out of date."
            )
            repository.warnings_json = result.warnings

        session.flush()
        return result

    except Exception as error:  # noqa: BLE001 - recorded on the row, not swallowed
        logger.exception("Indexing failed for %s", repository.full_name)
        repository.index_status = "failed"
        repository.index_error = str(error)[:1000]
        session.flush()
        raise


def _select(ranked: list[RankedFile], budget: int) -> list[RankedFile]:
    """The files worth reading.

    Ranked order, capped — with the guarantee that documentation is never crowded
    out by a large source tree. A deck about a repository is usually about what
    the README says it is, and losing it to five hundred `.ts` files would be the
    pipeline defeating its own purpose.
    """
    docs = [file for file in ranked if file.language in {"Markdown", "reStructuredText"}]
    rest = [file for file in ranked if file not in docs]

    reserved = min(len(docs), max(20, budget // 5))
    chosen = docs[:reserved] + rest[: max(0, budget - reserved)]
    chosen.sort(key=lambda file: (-file.score, file.path))
    return chosen


def _existing_chunks(session: Session, repository_id: str) -> dict[str, str | None]:
    rows = (
        session.query(RepositoryChunk.path, RepositoryChunk.file_sha)
        .filter(RepositoryChunk.repository_id == repository_id)
        .distinct()
        .all()
    )
    return {path: sha for path, sha in rows}


def _replace_chunks(session: Session, repository_id: str, *, keep_paths: set[str]) -> None:
    query = session.query(RepositoryChunk).filter(RepositoryChunk.repository_id == repository_id)
    if keep_paths:
        query = query.filter(RepositoryChunk.path.notin_(list(keep_paths)))
    query.delete(synchronize_session=False)
    session.flush()


def _count_chunks(session: Session, repository_id: str) -> int:
    return (
        session.query(RepositoryChunk)
        .filter(RepositoryChunk.repository_id == repository_id)
        .count()
    )


def staleness(repository: Repository) -> dict[str, Any]:
    """What to tell the user about how current the index is.

    Three states, and the third is the one that matters: "unknown" is not
    "fresh". A local directory and a repository whose head we cannot read both
    land there, and pretending otherwise is how a deck silently drifts.
    """
    if repository.index_status == "revoked":
        return {"state": "revoked", "message": "Access to this repository was withdrawn."}

    if repository.index_status in {"pending", "indexing"}:
        return {"state": repository.index_status, "message": "Indexing…"}

    if repository.index_status == "failed":
        return {"state": "failed", "message": repository.index_error or "Indexing failed."}

    if repository.head_sha is None or repository.indexed_sha is None:
        return {
            "state": "unknown",
            "message": "This source has no commit id, so Deckastra cannot tell if it has changed.",
        }

    if repository.head_sha != repository.indexed_sha:
        return {
            "state": "stale",
            "message": "This repository has changed since it was indexed.",
            "indexed_sha": repository.indexed_sha[:7],
            "head_sha": repository.head_sha[:7],
        }

    return {
        "state": "fresh",
        "message": "Up to date.",
        "indexed_sha": repository.indexed_sha[:7],
    }
