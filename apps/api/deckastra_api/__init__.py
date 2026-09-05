"""Deckastra's API service.

`agents/` is a sibling package rather than a subpackage of this one: doc 05 §4
keeps the agent system in its own top-level directory, and doc 05 §17 says agent
implementations should not know database details. Keeping them in separate trees
is what makes that rule checkable rather than aspirational — an agent that
imported `deckastra_api` would be an obvious mistake in the diff.

The cost is that `agents/` has to be reachable on the path. It is added here,
once, rather than by every entry point: a `PYTHONPATH` that has to be set
correctly by uvicorn, by pytest, by Alembic and by anyone running a script is a
`PYTHONPATH` that is wrong somewhere.
"""

from __future__ import annotations

import sys
from pathlib import Path

_AGENTS = Path(__file__).resolve().parents[3] / "agents"

if _AGENTS.is_dir() and str(_AGENTS) not in sys.path:
    sys.path.insert(0, str(_AGENTS))
