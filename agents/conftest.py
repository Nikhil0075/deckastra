"""Make `deckastra_agents` importable however pytest was invoked.

`agents/` is a top-level package directory rather than an installed distribution
(doc 05 §4), so the package is only importable when this directory is on the
path. `pytest.ini` handles the case where pytest is run from here; this handles
the case where it is run from the repository root, which is what CI and anyone
running the whole suite at once does.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = str(Path(__file__).resolve().parent)

if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
