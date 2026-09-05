"""Embeddings, when there is a model to make them with.

One provider — Voyage, when `VOYAGE_API_KEY` is set. Without a key there is no
embedder at all, and retrieval uses BM25 instead (`lexical.py`).

That is a deliberate correction. An earlier version had a hashing "embedder" for
the no-key path so that the vector search always had vectors. It did not work:
feature hashing needs roughly 2^18 buckets and a pgvector column is 1024 wide, so
a one-word query matched collision noise. The fix was not a wider column — it was
to stop pretending. A lexical index is honest about what it can do; a degraded
vector index returns confident nonsense, which is how an invented citation ends
up on a slide.

So `default_embedder()` returns `None` rather than a fallback, and every caller
has to decide what to do about that. Being forced to handle the absence is the
point.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Protocol, Sequence

#: Fixed for the pgvector column. `voyage-3` emits 1024 natively. Changing it
#: means a migration and a re-index, so it is a constant rather than a setting.
EMBEDDING_DIM = 1024

VOYAGE_MODEL = "voyage-3"


@dataclass(frozen=True)
class EmbeddingBatch:
    vectors: list[list[float]]
    model: str
    #: True when the vectors carry meaning rather than surface form. Recorded on
    #: the index and shown to the user; see the module docstring.
    semantic: bool


class Embedder(Protocol):
    model: str
    semantic: bool

    def embed(self, texts: Sequence[str], *, kind: str = "document") -> EmbeddingBatch: ...


# -------------------------------------------------------------------- voyage


class VoyageEmbedder:
    """Real embeddings, when a key is configured.

    Voyage rather than another provider because Anthropic recommends it and it is
    the one this stack can reach without adding a second vendor relationship. The
    interface is what matters: swapping it is one class.
    """

    model = VOYAGE_MODEL
    semantic = True

    #: Voyage's per-request cap. Batched rather than one call per chunk, which on
    #: a thousand-chunk repository is the difference between a minute and an hour.
    BATCH = 128

    def __init__(self, api_key: str, model: str = VOYAGE_MODEL) -> None:
        self._key = api_key
        self.model = model

    def embed(self, texts: Sequence[str], *, kind: str = "document") -> EmbeddingBatch:
        import httpx

        vectors: list[list[float]] = []

        for start in range(0, len(texts), self.BATCH):
            batch = list(texts[start : start + self.BATCH])
            response = httpx.post(
                "https://api.voyageai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {self._key}"},
                json={
                    "input": batch,
                    "model": self.model,
                    # A query and a document are embedded differently by design;
                    # using one type for both measurably degrades retrieval.
                    "input_type": "query" if kind == "query" else "document",
                    "output_dimension": EMBEDDING_DIM,
                },
                timeout=60.0,
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"Voyage returned {response.status_code}: {response.text[:200]}"
                )

            payload = response.json()
            # Sorted by index: the API does not promise input order back, and a
            # silently permuted batch attaches every embedding to the wrong chunk.
            ordered = sorted(payload["data"], key=lambda item: item["index"])
            vectors.extend(item["embedding"] for item in ordered)

        return EmbeddingBatch(vectors=vectors, model=self.model, semantic=True)


def default_embedder() -> Embedder | None:
    """The embedder, or `None` when there is no key.

    `None` rather than a fallback: see the module docstring. A caller that gets
    `None` indexes without embeddings and searches lexically, which is a real
    answer — unlike a vector index built from vectors that mean nothing.
    """
    key = os.environ.get("VOYAGE_API_KEY")
    return VoyageEmbedder(key) if key else None


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity, for the SQLite path where there is no pgvector.

    Both embedders normalise, so this is a dot product in practice — but the
    normalisation is done here too, because a vector read back from JSON storage
    has been through a float round trip and a stored vector from an older build
    may not have been normalised at all.
    """
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
