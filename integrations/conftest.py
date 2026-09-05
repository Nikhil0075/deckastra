"""Make `deckastra_integrations` importable however pytest was invoked.

Same reason as `agents/conftest.py`: this is a top-level package directory rather
than an installed distribution (doc 05 §4), so it is only importable when this
directory is on the path — and that has to hold whether pytest runs from here or
from the repository root.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = str(Path(__file__).resolve().parent)

if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
