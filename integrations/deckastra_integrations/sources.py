"""Where repository content comes from.

One protocol, two implementations, and everything downstream — the ignore rules,
the ranking, the chunker, the embedder, the retriever, the provenance — depends
only on the protocol. That is what makes the indexing pipeline testable without a
GitHub App, and what will make a GitLab or a Bitbucket adapter a new file rather
than a second pipeline.

The local adapter is not a test double. Indexing a checkout on disk is how this
gets developed, and it is a real answer for a user pointing at a repository they
already have. Its limits are stated where they matter: no commit sha means no
staleness, so it says so rather than reporting a sha it invented.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Protocol

from .ignore import MAX_FILE_BYTES, should_index_path


@dataclass(frozen=True)
class TreeEntry:
    path: str
    size_bytes: int
    #: A version stamp for the file's content — a blob sha where the source has
    #: one, otherwise whatever the source can produce cheaply. Used for
    #: incremental re-indexing: an unchanged stamp means the chunks we already
    #: have are still correct, so the file is not re-read or re-embedded. Only
    #: ever compared for equality against the previous stamp from the same
    #: source, never parsed.
    sha: str | None = None


@dataclass(frozen=True)
class RepositoryInfo:
    """What the pipeline needs to know about a repository before reading it."""

    owner: str
    name: str
    default_branch: str
    #: The commit the index is taken at. `None` for a working directory, where
    #: there is no such thing — see the module docstring.
    head_sha: str | None = None
    description: str = ""
    private: bool = True
    #: Languages as the host reports them, when it does. Never trusted alone; the
    #: pipeline detects languages from the tree as well.
    languages: dict[str, int] = field(default_factory=dict)

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"


class SourceUnavailable(RuntimeError):
    """The repository could not be read, with a reason a user can act on."""


class SourceAdapter(Protocol):
    """The whole surface the indexer needs.

    Deliberately three methods. A wider protocol would let the pipeline reach for
    host-specific features and stop being portable; a narrower one would push
    per-host branching into the pipeline.
    """

    def info(self) -> RepositoryInfo: ...

    def tree(self) -> Iterator[TreeEntry]: ...

    def read(self, path: str) -> str: ...


# ------------------------------------------------------------------ local


class LocalDirectorySource:
    """A checkout on disk.

    Used for development and for a user who points at a local path. It walks the
    directory rather than asking git, so it works on a folder that was never a
    repository — and reports `head_sha=None`, which the staleness logic reads as
    "cannot tell", not as "up to date".
    """

    def __init__(self, root: str | Path, *, owner: str = "local", name: str | None = None) -> None:
        self._root = Path(root).resolve()
        if not self._root.is_dir():
            raise SourceUnavailable(f"{self._root} is not a directory.")
        self._owner = owner
        self._name = name or self._root.name

    def info(self) -> RepositoryInfo:
        return RepositoryInfo(
            owner=self._owner,
            name=self._name,
            default_branch="(working directory)",
            head_sha=self._read_git_head(),
            description=f"Local checkout at {self._root}",
        )

    def _read_git_head(self) -> str | None:
        """The current commit, read from `.git` without running git.

        Reading the file rather than shelling out keeps the "no repository code is
        executed" rule from becoming "no repository code *except* git", and works
        when git is not installed.
        """
        head = self._root / ".git" / "HEAD"
        if not head.is_file():
            return None

        try:
            content = head.read_text(encoding="utf-8").strip()
        except OSError:
            return None

        if content.startswith("ref: "):
            ref = self._root / ".git" / content[5:].strip()
            if ref.is_file():
                try:
                    return ref.read_text(encoding="utf-8").strip() or None
                except OSError:
                    return None
            return None

        return content or None

    def tree(self) -> Iterator[TreeEntry]:
        for directory, subdirectories, filenames in os.walk(self._root):
            # Pruned in place: descending into node_modules to then discard every
            # file is the difference between seconds and minutes.
            subdirectories[:] = [
                name
                for name in subdirectories
                if should_index_path(f"{name}/placeholder").indexed
            ]

            for filename in filenames:
                absolute = Path(directory) / filename
                relative = absolute.relative_to(self._root).as_posix()

                try:
                    stat = absolute.stat()
                except OSError:
                    continue

                yield TreeEntry(
                    path=relative,
                    size_bytes=stat.st_size,
                    # Not a blob sha — a directory has none — but the same job:
                    # a cheap version stamp so an incremental re-index can skip a
                    # file that has not changed. Size and modification time come
                    # from the `stat` already being made, so this costs nothing,
                    # where hashing the content would mean reading every file to
                    # decide whether to read it.
                    sha=f"stat:{stat.st_size}:{stat.st_mtime_ns}",
                )

    def read(self, path: str) -> str:
        target = (self._root / path).resolve()

        # A path from a tree should already be inside the root, but a traversal
        # here would read arbitrary files off the host.
        if not str(target).startswith(str(self._root)):
            raise SourceUnavailable(f"{path} is outside the repository.")

        try:
            if target.stat().st_size > MAX_FILE_BYTES:
                raise SourceUnavailable(f"{path} is too large to index.")
            return target.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            raise SourceUnavailable(f"Could not read {path}: {error}") from error
