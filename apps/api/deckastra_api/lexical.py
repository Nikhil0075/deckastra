"""BM25, for when there is no semantic embedder.

The first version of this used the hashing embedder for both indexing and search
and it did not work. Feature hashing needs a wide space — 2^18 buckets is
typical — and a pgvector column is 1024 wide, so nearly every bucket held a
collision and a one-word query matched noise. Searching this repository for
"pgvector" returned renderer tests.

The lesson is worth writing down: **a weak semantic search is worse than an
honest lexical one.** A lexical index cannot find "how do we handle retries" from
the word "backoff", and it says so. A degraded vector search returns confident
nonsense, which is the failure mode that puts an invented citation on a slide.

So the no-key path is BM25 over an inverted index rather than an embedding. It is
deterministic, offline, free, and genuinely good at what a codebase is mostly
made of: identifiers, filenames and exact terms.

Written out rather than pulled in because it is forty lines and the ranking
function is the part worth being able to read.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Iterable

#: Term frequency saturation. 1.2 is the standard choice: past a few occurrences
#: another mention of a word says very little more.
K1 = 1.2
#: Length normalisation. 0.75 is standard — full normalisation (1.0) over-punishes
#: long files, which in a codebase are often the important ones.
B = 0.75

_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")


def tokenize(text: str) -> list[str]:
    """Words, identifiers, and the parts identifiers are made of.

    `SNAPSHOT_EVERY` yields `snapshot_every`, `snapshot` and `every`, so a query
    written in prose finds code written in identifiers. That is most of what
    makes lexical search usable on a codebase rather than merely present.
    """
    out: list[str] = []

    for match in _TOKEN.findall(text.lower()):
        out.append(match)
        parts = re.split(r"[_\-.]+", match)
        for part in parts:
            for piece in re.findall(r"[a-z]+|\d+", part):
                if piece and piece != match:
                    out.append(piece)

    return out


@dataclass
class Posting:
    doc_id: str
    frequency: int


class BM25Index:
    """An in-memory inverted index.

    Built per search from the candidate rows rather than persisted. At this scale
    that costs milliseconds and avoids a second index to keep in sync with the
    chunks table — a stale search index is a worse problem than a rebuilt one.
    """

    def __init__(self) -> None:
        self._postings: dict[str, list[Posting]] = {}
        self._lengths: dict[str, int] = {}
        self._average_length = 0.0

    def add(self, doc_id: str, text: str) -> None:
        tokens = tokenize(text)
        self._lengths[doc_id] = len(tokens)

        for term, frequency in Counter(tokens).items():
            self._postings.setdefault(term, []).append(Posting(doc_id, frequency))

    def finalise(self) -> None:
        total = sum(self._lengths.values())
        self._average_length = total / len(self._lengths) if self._lengths else 0.0

    def search(self, query: str, limit: int = 20) -> list[tuple[str, float]]:
        if not self._lengths:
            return []
        if self._average_length == 0.0:
            self.finalise()

        terms = tokenize(query)
        if not terms:
            return []

        corpus_size = len(self._lengths)
        scores: dict[str, float] = {}

        # A term repeated in the query counts once. "retry retry retry" is not a
        # stronger query than "retry", and treating it as one lets a padded query
        # dominate.
        for term in set(terms):
            postings = self._postings.get(term)
            if not postings:
                continue

            document_frequency = len(postings)
            # Robertson/Sparck Jones IDF with the +1 that keeps it positive: the
            # raw form goes negative for a term in more than half the corpus,
            # which would make a common word actively penalise a match.
            idf = math.log(1 + (corpus_size - document_frequency + 0.5) / (document_frequency + 0.5))

            for posting in postings:
                length = self._lengths[posting.doc_id]
                normalisation = 1 - B + B * (length / self._average_length if self._average_length else 1)
                saturated = (posting.frequency * (K1 + 1)) / (
                    posting.frequency + K1 * normalisation
                )
                scores[posting.doc_id] = scores.get(posting.doc_id, 0.0) + idf * saturated

        ranked = sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))
        return ranked[:limit]


def build(documents: Iterable[tuple[str, str]]) -> BM25Index:
    index = BM25Index()
    for doc_id, text in documents:
        index.add(doc_id, text)
    index.finalise()
    return index


def normalise_scores(ranked: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Scale BM25 scores into 0..1 so they can share a threshold with cosine.

    BM25 is unbounded and corpus-dependent — a score of 8 means nothing on its
    own. Dividing by the top score makes the *ordering* comparable across
    backends, which is all the caller needs. It is deliberately not a probability
    and is not presented as one.
    """
    if not ranked:
        return []
    top = ranked[0][1] or 1.0
    return [(doc_id, score / top) for doc_id, score in ranked]
