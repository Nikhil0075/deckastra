"""The GitHub REST calls indexing needs, and nothing else.

Four operations: repository metadata, languages, the git tree, and a blob. That
is the entire surface, and keeping it that small is deliberate — every method
here is a permission the App has to justify on its installation screen.

`GitHubSource` adapts them to the `SourceAdapter` protocol, so the indexing
pipeline never knows whether it is reading GitHub or a directory on disk.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Iterator

from ..ignore import MAX_FILE_BYTES, should_index_path
from ..sources import RepositoryInfo, SourceUnavailable, TreeEntry
from .app import InstallationTokens

API = "https://api.github.com"


class GitHubError(RuntimeError):
    """A GitHub request failed, with the status and enough of the body to act on."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"GitHub returned {status}: {message}")
        self.status = status


@dataclass
class GitHubClient:
    tokens: InstallationTokens
    installation_id: str
    #: Injected in tests. Production uses httpx.
    transport: Any | None = None

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        token = self.tokens.get(self.installation_id)

        if self.transport is not None:
            return self.transport.get(path, params=params, token=token.token)

        import httpx

        response = httpx.get(
            f"{API}{path}",
            params=params,
            headers={
                "Authorization": f"Bearer {token.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=30.0,
        )

        if response.status_code == 401:
            # The cached token was revoked or rotated early. One forced re-mint,
            # then give up — retrying a genuine permission failure forever is how
            # an integration hammers an API it is not allowed to use.
            self.tokens.forget(self.installation_id)
            token = self.tokens.get(self.installation_id, force=True)
            response = httpx.get(
                f"{API}{path}",
                params=params,
                headers={
                    "Authorization": f"Bearer {token.token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                timeout=30.0,
            )

        if response.status_code >= 400:
            raise GitHubError(response.status_code, response.text[:300])
        return response.json()

    # ------------------------------------------------------------- surface

    def repository(self, owner: str, name: str) -> dict[str, Any]:
        return self._get(f"/repos/{owner}/{name}")

    def languages(self, owner: str, name: str) -> dict[str, int]:
        return self._get(f"/repos/{owner}/{name}/languages")

    def tree(self, owner: str, name: str, ref: str) -> dict[str, Any]:
        # One recursive call rather than a walk: a walk is one round trip per
        # directory, which on a large repository is thousands.
        return self._get(f"/repos/{owner}/{name}/git/trees/{ref}", params={"recursive": "1"})

    def blob(self, owner: str, name: str, sha: str) -> str:
        payload = self._get(f"/repos/{owner}/{name}/git/blobs/{sha}")

        if payload.get("encoding") != "base64":
            raise SourceUnavailable(f"Unexpected blob encoding {payload.get('encoding')!r}.")

        raw = base64.b64decode(payload.get("content", ""))
        # `replace` rather than `strict`: a file with one bad byte is still worth
        # indexing, and failing the whole run over it is not a trade worth making.
        return raw.decode("utf-8", errors="replace")


class GitHubSource:
    """A repository on GitHub, as a `SourceAdapter`.

    The tree is fetched once and held, because `read` needs each file's blob sha
    and re-fetching the tree per file would be one round trip per read.
    """

    def __init__(self, client: GitHubClient, owner: str, name: str, ref: str | None = None) -> None:
        self._client = client
        self._owner = owner
        self._name = name
        self._ref = ref
        self._info: RepositoryInfo | None = None
        self._shas: dict[str, str] = {}
        self._truncated = False

    def info(self) -> RepositoryInfo:
        if self._info is not None:
            return self._info

        repository = self._client.repository(self._owner, self._name)
        branch = self._ref or repository.get("default_branch", "main")

        self._info = RepositoryInfo(
            owner=self._owner,
            name=self._name,
            default_branch=branch,
            head_sha=self._head_sha(branch),
            description=repository.get("description") or "",
            private=bool(repository.get("private", True)),
            languages=self._client.languages(self._owner, self._name),
        )
        return self._info

    def _head_sha(self, branch: str) -> str | None:
        try:
            payload = self._client._get(f"/repos/{self._owner}/{self._name}/commits/{branch}")
        except GitHubError:
            # Without a head sha, staleness cannot be judged. Reporting `None`
            # means "cannot tell", which the staleness logic handles; inventing
            # one would mean reporting a repository as fresh forever.
            return None
        return payload.get("sha")

    @property
    def truncated(self) -> bool:
        """True when GitHub could not return the whole tree.

        Surfaced rather than swallowed: an index built from a truncated tree is
        missing files, and a user should know that before a deck cites what is
        there as though it were everything.
        """
        return self._truncated

    def tree(self) -> Iterator[TreeEntry]:
        info = self.info()
        payload = self._client.tree(self._owner, self._name, info.head_sha or info.default_branch)
        self._truncated = bool(payload.get("truncated"))

        for entry in payload.get("tree", []):
            if entry.get("type") != "blob":
                continue

            path = entry.get("path", "")
            size = int(entry.get("size", 0) or 0)

            # Filtered here as well as in the pipeline: the sha map should not
            # carry entries for files nobody will ever read.
            if not should_index_path(path, size).indexed:
                continue

            sha = entry.get("sha")
            if sha:
                self._shas[path] = sha

            yield TreeEntry(path=path, size_bytes=size, sha=sha)

    def read(self, path: str) -> str:
        sha = self._shas.get(path)
        if sha is None:
            raise SourceUnavailable(f"{path} was not in the tree; fetch the tree first.")
        return self._client.blob(self._owner, self._name, sha)


def size_guard(entries: Iterator[TreeEntry], *, max_bytes: int = 64 * 1024 * 1024) -> Iterator[TreeEntry]:
    """Stop reading a repository that is larger than the quota (doc 05 §19).

    Truncates rather than refuses. A partial index of a huge monorepo still
    answers questions about the parts it covered; a refusal answers nothing. The
    caller reports what was skipped.
    """
    total = 0
    for entry in entries:
        total += entry.size_bytes
        if total > max_bytes:
            return
        if entry.size_bytes <= MAX_FILE_BYTES:
            yield entry
