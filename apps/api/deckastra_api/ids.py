"""ULID identifiers, matching the grammar in doc 02 §0.2.

    "{prefix}_{ULID}"   e.g. "el_01JB8Z9K2QW4RN7F3XG5HTMD6A"

Implemented here rather than pulled from a package because it is twenty lines and
because the *monotonic* guarantee is the part that matters: a deck composed in a
single pass mints hundreds of ids inside the same millisecond, and a naive ULID
would collide or, worse, sort out of creation order and make diffs unreadable.
"""

from __future__ import annotations

import os
import time
from threading import Lock

# Crockford base32: no I, L, O or U, so an id cannot be misread aloud or mistyped
# into a different valid id.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ENCODED_TIME_LENGTH = 10
_ENCODED_RANDOM_LENGTH = 16

_lock = Lock()
_last_ms = 0
_last_randomness = 0


def _encode(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def new_ulid() -> str:
    """A monotonic ULID.

    Within one millisecond the random component is incremented rather than
    redrawn, which keeps ids strictly ascending. Sortability by creation time is
    what makes a patch log or a version diff readable without a timestamp column.
    """
    global _last_ms, _last_randomness

    with _lock:
        now_ms = int(time.time() * 1000)

        if now_ms == _last_ms:
            _last_randomness += 1
        else:
            _last_ms = now_ms
            _last_randomness = int.from_bytes(os.urandom(10), "big")

        randomness = _last_randomness

    return _encode(now_ms, _ENCODED_TIME_LENGTH) + _encode(
        randomness, _ENCODED_RANDOM_LENGTH
    )


def new_id(prefix: str) -> str:
    """Mint a prefixed id. Prefixes are advisory (doc 02 §0.2) — a validator may
    check them, but nothing parses an id for meaning beyond that."""
    return f"{prefix}_{new_ulid()}"
