"""Deckastra's API service.

`agents/` is a sibling package rather than a subpackage of
this one: doc 05 §4 keeps them in their own top-level directories, and doc 05 §17
says agent implementations should not know database details. Keeping them in
separate trees is what makes that rule checkable rather than aspirational — an
agent that imported `deckastra_api` would be an obvious mistake in the diff.

The cost is that it has to be reachable on the path. It is added here,
once, rather than by every entry point: a `PYTHONPATH` that has to be set
correctly by uvicorn, by pytest, by Alembic and by anyone running a script is a
`PYTHONPATH` that is wrong somewhere.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]

for _sibling in ("agents",):
    _path = _ROOT / _sibling
    if _path.is_dir() and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
