"""Query-specific retrieval (doc 03 §8, gap register doc 03 S2 / doc 05 S2).

"Do not send an entire repository to an LLM." This is the part that makes that
possible: a question goes in, a handful of chunks come out, each carrying the
path and line range that lets a reader check it.

Two kinds of search, chosen by what the index actually is:

- **Semantic**, when the repository was embedded with a real model. Vector
  nearest-neighbour, through pgvector on PostgreSQL and brute-force cosine
  elsewhere — the second exists so local development does not require
  PostgreSQL, the same reason the store is testable on SQLite.
- **Lexical (BM25)**, when it was not. Not a degraded vector search: an actual
  inverted index, which is very good at what a codebase is mostly made of —
  identifiers, filenames, exact terms.

That split is a correction. The first version used the hashing embedder for both
and it did not work: feature hashing needs ~2^18 buckets and a pgvector column is
1024 wide, so a one-word query matched collision noise. Searching this repository
for "pgvector" returned renderer tests.

**A weak semantic search is worse than an honest lexical one.** BM25 cannot find
"how do we handle retries" from the word "backoff", and the UI says so. A
degraded vector search returns confident nonsense, which is how an invented
citation ends up on a slide.

Ranking is not similarity alone. A chunk from the README and a chunk from a test
helper can be equally similar to a query and are not equally worth citing, so the
file's importance score contributes. Doc 03 §8 also requires that the agent can
explain why a file was selected — which is why the reason travels with the chunk
rather than being recomputed later.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session

from . import lexical
from .db.models import Repository, RepositoryChunk
from .embeddings import EMBEDDING_DIM, Embedder, cosine, default_embedder

logger = logging.getLogger("deckastra.retrieval")

#: How much the file's importance counts against raw similarity. Tuned by hand
#: against this repository: high enough that a README beats a same-similarity
#: test helper, low enough that it cannot promote an irrelevant file.
IMPORTANCE_WEIGHT = 0.25

#: Importance scores run to roughly 200; normalised so the weight above means
#: what it says.
IMPORTANCE_SCALE = 200.0


@dataclass
class RetrievedChunk:
    chunk_id: str
    #: Which repository this came from. Carried on the hit rather than inferred
    #: by the caller: a search spans every connected repository, and a citation
    #: that names the wrong one is worse than no citation at all.
    repository_id: str
    repository_full_name: str
    path: str
    start_line: int
    end_line: int
    language: str
    content: str
    similarity: float
    score: float
    #: Why the file was selected at index time. Carried, not recomputed.
    selection_reason: str

    @property
    def reference(self) -> str:
        """`path:start-end`, the form a provenance record carries (doc 02 §30)."""
        return f"{self.path}:{self.start_line}-{self.end_line}"

    @property
    def source_id(self) -> str:
        """`owner/repo#path:start-end` — the whole citation (doc 02 §30)."""
        return f"{self.repository_full_name}#{self.reference}"


def _pgvector_available(session: Session) -> bool:
    """Whether this database can do the fast path.

    Checked rather than assumed: the compose image ships pgvector, but a managed
    PostgreSQL may not have the extension enabled, and discovering that inside a
    query means a failed retrieval rather than a slower one.
    """
    if session.bind is None or session.bind.dialect.name != "postgresql":
        return False
    try:
        return bool(
            session.execute(
                sql_text("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
            ).first()
        )
    except Exception:  # noqa: BLE001 - any failure means "use the other path"
        return False


def search(
    session: Session,
    repository_ids: list[str],
    query: str,
    *,
    limit: int = 8,
    embedder: Embedder | None = None,
    min_similarity: float = 0.02,
) -> list[RetrievedChunk]:
    """The chunks most worth showing an agent for this question.

    `min_similarity` exists because an empty answer is more useful than a bad
    one: a query about something the repository does not contain should return
    nothing, so the agent says it found nothing rather than citing the least
    irrelevant file it could find.
    """
    if not repository_ids:
        return []

    embedder = embedder or default_embedder()

    if embedder is not None and embedder.semantic and _index_is_semantic(session, repository_ids):
        vector = embedder.embed([query], kind="query").vectors[0]
        rows = (
            _search_pgvector(session, repository_ids, vector, limit * 3)
            if _pgvector_available(session)
            else _search_python(session, repository_ids, vector, limit * 3)
        )
    else:
        # Either there is no semantic embedder, or the index was built without
        # one. Searching a lexical index with a vector query would compare two
        # different things and return noise, so the *index* decides the method.
        rows = _search_lexical(session, repository_ids, query, limit * 3)

    # One lookup for the names, rather than one per hit. The rows carry an id;
    # a citation has to carry `owner/repo`.
    names = dict(
        session.query(Repository.id, Repository.full_name)
        .filter(Repository.id.in_(repository_ids))
        .all()
    )

    ranked = [
        RetrievedChunk(
            chunk_id=chunk.id,
            repository_id=chunk.repository_id,
            repository_full_name=names.get(chunk.repository_id, ""),
            path=chunk.path,
            start_line=chunk.start_line,
            end_line=chunk.end_line,
            language=chunk.language or "",
            content=chunk.content,
            similarity=round(similarity, 4),
            score=round(
                similarity
                + IMPORTANCE_WEIGHT * min(1.0, (chunk.importance or 0) / IMPORTANCE_SCALE),
                4,
            ),
            selection_reason=chunk.selection_reason or "",
        )
        for chunk, similarity in rows
        if similarity >= min_similarity
    ]

    ranked.sort(
        key=lambda chunk: (-chunk.score, chunk.repository_full_name, chunk.path, chunk.start_line)
    )

    # At most two chunks per file. Three chunks of one long file crowd out three
    # different files, and a deck grounded in one file is a deck about one file.
    #
    # Keyed by repository *and* path: two repositories both containing a
    # `README.md` are two files, and keying on the path alone would let the first
    # one silently cap the second.
    seen: dict[tuple[str, str], int] = {}
    chosen: list[RetrievedChunk] = []
    for chunk in ranked:
        key = (chunk.repository_id, chunk.path)
        count = seen.get(key, 0)
        if count >= 2:
            continue
        seen[key] = count + 1
        chosen.append(chunk)
        if len(chosen) >= limit:
            break

    return chosen


def _index_is_semantic(session: Session, repository_ids: list[str]) -> bool:
    """Whether these repositories were embedded with a real model.

    Read from the repositories rather than assumed from the current
    configuration: adding a key does not retroactively re-embed an index, and
    querying a lexical index semantically is exactly the mismatch this exists to
    prevent.
    """
    rows = (
        session.query(Repository.embedding_semantic)
        .filter(Repository.id.in_(repository_ids))
        .all()
    )
    return bool(rows) and all(row[0] for row in rows)


def _search_lexical(
    session: Session, repository_ids: list[str], query: str, limit: int
) -> list[tuple[RepositoryChunk, float]]:
    """BM25 over the chunks.

    The index is built per search rather than persisted. At the scale a single
    repository reaches that costs milliseconds, and it avoids a second index to
    keep in sync with the chunks table — a stale search index is a worse problem
    than a rebuilt one. A persisted index is the obvious change when a workspace
    has a hundred repositories.
    """
    chunks = (
        session.query(RepositoryChunk)
        .filter(RepositoryChunk.repository_id.in_(repository_ids))
        .all()
    )
    if not chunks:
        return []

    by_id = {chunk.id: chunk for chunk in chunks}
    index = lexical.build(
        # The path is part of the text on purpose: "where is the patch applier"
        # should match `apply.ts` even when the file never says the word.
        (chunk.id, f"{chunk.path}\n{chunk.content}")
        for chunk in chunks
    )

    ranked = lexical.normalise_scores(index.search(query, limit=limit))
    return [(by_id[doc_id], score) for doc_id, score in ranked if doc_id in by_id]


def _search_python(
    session: Session, repository_ids: list[str], vector: list[float], limit: int
) -> list[tuple[RepositoryChunk, float]]:
    chunks = (
        session.query(RepositoryChunk)
        .filter(RepositoryChunk.repository_id.in_(repository_ids))
        .all()
    )

    scored = [
        (chunk, cosine(vector, chunk.embedding_json))
        for chunk in chunks
        if chunk.embedding_json
    ]
    scored.sort(key=lambda pair: -pair[1])
    return scored[:limit]


def _search_pgvector(
    session: Session, repository_ids: list[str], vector: list[float], limit: int
) -> list[tuple[RepositoryChunk, float]]:
    """Nearest neighbours through the vector index.

    Falls back to the Python path on any failure. A slower retrieval is a much
    better outcome than a failed one, and the reason is logged so a misconfigured
    extension does not stay invisible.
    """
    literal = "[" + ",".join(f"{value:.6f}" for value in vector) + "]"

    try:
        rows = session.execute(
            sql_text(
                """
                SELECT id, 1 - (embedding <=> CAST(:vector AS vector)) AS similarity
                FROM repository_chunks
                WHERE repository_id = ANY(:repository_ids)
                  AND embedding IS NOT NULL
                ORDER BY embedding <=> CAST(:vector AS vector)
                LIMIT :limit
                """
            ),
            {"vector": literal, "repository_ids": repository_ids, "limit": limit},
        ).all()
    except Exception as error:  # noqa: BLE001 - degrade, and say why
        logger.warning("pgvector search failed, falling back to in-process cosine: %s", error)
        return _search_python(session, repository_ids, vector, limit)

    if not rows:
        return []

    by_id = {
        chunk.id: chunk
        for chunk in session.query(RepositoryChunk)
        .filter(RepositoryChunk.id.in_([row[0] for row in rows]))
        .all()
    }
    return [(by_id[row[0]], float(row[1])) for row in rows if row[0] in by_id]


def sync_pgvector_column(session: Session, repository_id: str) -> int:
    """Copy JSON embeddings into the `vector` column so the index can use them.

    The JSON column is the portable source of truth — it works on SQLite and
    survives an extension being unavailable. The `vector` column is a derived
    index. Keeping both is a small cost for a schema that runs in both places;
    keeping only the vector would mean local development needed PostgreSQL.
    """
    if not _pgvector_available(session):
        return 0

    try:
        # A savepoint, not the outer transaction. PostgreSQL aborts a whole
        # transaction on any statement error, so catching one here without a
        # savepoint would poison every later statement and silently discard the
        # index this was called to finish — which is exactly what happened before
        # this was nested.
        with session.begin_nested():
            result = session.execute(
                sql_text(
                    """
                    UPDATE repository_chunks
                    SET embedding = CAST(embedding_json::text AS vector)
                    WHERE repository_id = :repository_id
                      -- A JSON `null` is not a SQL NULL. Every chunk carries the
                      -- column, and on the lexical path its value is JSON null,
                      -- which casts to `vector` as the literal text "null" and
                      -- fails. Only an array is an embedding.
                      AND jsonb_typeof(embedding_json::jsonb) = 'array'
                    """
                ),
                {"repository_id": repository_id},
            )
        session.flush()
        return result.rowcount or 0
    except Exception as error:  # noqa: BLE001 - the JSON path still works
        logger.warning("Could not populate the pgvector column: %s", error)
        return 0


def repository_summary(repository: Repository) -> dict[str, Any]:
    """The profile an agent is handed before it asks anything.

    Small on purpose (doc 03 §23): languages, frameworks, entry points and the
    top files. Enough to know what the repository *is*, and to ask a good
    question — not enough to be a substitute for asking one.
    """
    profile = repository.profile_json or {}
    return {
        "repository_id": repository.id,
        "full_name": repository.full_name,
        "description": repository.description or "",
        "default_branch": repository.default_branch,
        "languages": profile.get("languages", {}),
        "frameworks": profile.get("frameworks", []),
        "entry_points": profile.get("entry_points", []),
        "important_files": profile.get("important_files", [])[:12],
        "chunk_count": repository.chunk_count,
        "embedding_model": repository.embedding_model,
        "embedding_semantic": repository.embedding_semantic,
    }


__all__ = [
    "EMBEDDING_DIM",
    "RetrievedChunk",
    "repository_summary",
    "search",
    "sync_pgvector_column",
]
