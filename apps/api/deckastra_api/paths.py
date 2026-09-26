"""Where this install's data files are.

A checkout and a packaged binary answer differently, and three things read files
by path rather than importing them: Alembic's migrations, the generated JSON
Schema every document is validated against, and the agent prompts. None of them
is an import, so nothing bundles them automatically and nothing would fail until
the first launch of a build nobody tested.

One function, so the answer cannot be right in two places and wrong in a third.
"""

from __future__ import annotations

import hashlib
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


def migrations_dir() -> Path:
    """Alembic's migration scripts, wherever this install keeps them."""
    return resource_root() / "infrastructure" / "database" / "migrations"


def tree_digest(directory: Path) -> str | None:
    """One hash for a directory: every file's path and content, in a fixed order.

    The desktop's build manifest computes this same number for the migrations it
    bundles (`apps/desktop/scripts/manifest.mjs`, item 07), so a window paired
    with a service built from different migrations can be told apart from one
    paired with its own. Two implementations of one definition, deliberately —
    the alternative is the app trusting a version string the service never
    checked — and `test_build_identity.py` holds them to the same answer.

    Relative posix paths so a tree hashes the same wherever it sits: a checkout,
    a frozen bundle's unpacked directory, a copy somewhere else.
    """
    if not directory.is_dir():
        return None
    entries: list[tuple[str, Path]] = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix == ".pyc" or "__pycache__" in path.parts:
            continue
        entries.append((path.relative_to(directory).as_posix(), path))
    entries.sort(key=lambda entry: entry[0])

    digest = hashlib.sha256()
    for name, path in entries:
        digest.update(f"{name}\0{hashlib.sha256(path.read_bytes()).hexdigest()}\n".encode())
    return digest.hexdigest()


def migrations_digest() -> str | None:
    """What this service's migrations hash to, for the pairing check above."""
    return tree_digest(migrations_dir())
