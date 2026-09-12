"""Where this install's data files are.

A checkout and a packaged binary answer differently, and three things read files
by path rather than importing them: Alembic's migrations, the generated JSON
Schema every document is validated against, and the agent prompts. None of them
is an import, so nothing bundles them automatically and nothing would fail until
the first launch of a build nobody tested.

One function, so the answer cannot be right in two places and wrong in a third.
"""

from __future__ import annotations

import sys
from pathlib import Path


def resource_root() -> Path:
    """The directory the repository's data files are laid out under.

    Frozen builds unpack their bundled data beside the executable (`onedir`) and
    PyInstaller points `sys._MEIPASS` at it. A checkout is four levels up from
    this file. Neither is guessable from the other, which is why this is a
    branch rather than a clever relative path.
    """
    if getattr(sys, "frozen", False):
        bundled = getattr(sys, "_MEIPASS", None)
        return Path(bundled) if bundled else Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[3]
