"""GitHub App authentication (doc 05 §19).

A GitHub App, not a user token. The difference is the whole security posture:

- A user token carries everything that user can reach, forever, in one string. An
  installation token carries only the repositories the installer selected, only
  the permissions the App declares, and expires in an hour.
- A user leaving the company takes their token's access with them mid-deck. An
  installation belongs to the organisation.
- An App's permissions are visible on the installation screen before anyone
  agrees to them. A user token's scope is a checkbox nobody reads.

The exchange is two steps, and both matter:

    private key ──JWT (10 min, app identity)──▶ /app/installations/{id}/access_tokens
                                                          │
                                          installation token (1 hour, repo-scoped)

The private key never leaves the server and never reaches an agent (doc 03 §25).
Tokens are cached until shortly before they expire and then re-minted, so a long
indexing run does not fail halfway through on an expiry it could have seen coming.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from typing import Any

#: Requested from GitHub. Read-only, and only what indexing needs.
#:
#: `contents: read` is the whole capability — reading files. `metadata: read` is
#: mandatory for every App. Nothing here can write, comment, or trigger a
#: workflow, so a compromised installation token cannot change a repository.
REQUIRED_PERMISSIONS = {"contents": "read", "metadata": "read"}

#: GitHub rejects a JWT valid for more than 10 minutes. 9 leaves room for clock
#: skew, which is the usual cause of a "not yet valid" rejection.
JWT_LIFETIME_SECONDS = 9 * 60

#: Installation tokens last an hour. Re-minted with 5 minutes to spare so a long
#: run does not expire mid-fetch.
TOKEN_REFRESH_MARGIN_SECONDS = 5 * 60


class GitHubAuthError(RuntimeError):
    """Authentication failed, with a reason an operator can act on."""


@dataclass(frozen=True)
class AppCredentials:
    app_id: str
    #: PEM. Read from the environment or a secret manager, never from the client.
    private_key: str
    webhook_secret: str = ""
    client_id: str = ""

    @classmethod
    def from_environment(cls) -> "AppCredentials | None":
        """Credentials from the environment, or `None` when the App is not set up.

        `None` rather than an exception: the product runs without GitHub, and a
        server that refuses to start because an optional integration is
        unconfigured is a worse failure than the missing feature.
        """
        app_id = os.environ.get("GITHUB_APP_ID")
        key = os.environ.get("GITHUB_APP_PRIVATE_KEY")

        if not app_id or not key:
            return None

        # Accepts a base64 blob as well as raw PEM: a multi-line private key in an
        # environment variable is mangled by enough deployment systems that
        # supporting the encoded form is cheaper than debugging it each time.
        if "BEGIN" not in key:
            try:
                key = base64.b64decode(key).decode("utf-8")
            except Exception as error:  # noqa: BLE001 - reported as configuration
                raise GitHubAuthError(
                    "GITHUB_APP_PRIVATE_KEY is neither PEM nor valid base64."
                ) from error

        return cls(
            app_id=app_id,
            private_key=key,
            webhook_secret=os.environ.get("GITHUB_WEBHOOK_SECRET", ""),
            client_id=os.environ.get("GITHUB_APP_CLIENT_ID", ""),
        )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def build_app_jwt(credentials: AppCredentials, *, now: int | None = None) -> str:
    """Sign a JWT proving this is the App.

    RS256, because that is what GitHub accepts. Signed here rather than with a
    library so the dependency list stays short for one signature — but the
    cryptography itself is `cryptography`'s, not hand-rolled.
    """
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
    except ImportError as error:  # pragma: no cover - a declared dependency
        raise GitHubAuthError(
            "The `cryptography` package is required to authenticate as a GitHub App."
        ) from error

    issued = int(now if now is not None else time.time())
    # Backdated by a minute: GitHub rejects a token whose `iat` is in its future,
    # and a server clock a few seconds fast is common.
    payload = {
        "iat": issued - 60,
        "exp": issued + JWT_LIFETIME_SECONDS,
        "iss": credentials.app_id,
    }

    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()

    key = serialization.load_pem_private_key(credentials.private_key.encode(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise GitHubAuthError("The GitHub App private key must be an RSA key.")

    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{body}.{_b64url(signature)}"


@dataclass
class InstallationToken:
    token: str
    expires_at: float
    repositories: list[str]

    def is_usable(self, *, now: float | None = None) -> bool:
        return (now or time.time()) < self.expires_at - TOKEN_REFRESH_MARGIN_SECONDS


class InstallationTokens:
    """Mints and caches installation tokens.

    Cached per installation because minting is a network round trip and an
    indexing run makes hundreds of requests. Re-minted before expiry rather than
    on failure: recovering from a 401 halfway through a run means re-fetching
    whatever was in flight, and the margin costs nothing.
    """

    def __init__(self, credentials: AppCredentials, transport: Any | None = None) -> None:
        self._credentials = credentials
        self._transport = transport
        self._cache: dict[str, InstallationToken] = {}

    def _post(self, url: str, *, jwt: str) -> dict[str, Any]:
        if self._transport is not None:
            return self._transport.post(url, jwt=jwt)

        import httpx

        response = httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {jwt}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=20.0,
        )
        if response.status_code >= 400:
            raise GitHubAuthError(
                f"GitHub refused the installation token request ({response.status_code}): "
                f"{response.text[:300]}"
            )
        return response.json()

    def get(self, installation_id: str, *, force: bool = False) -> InstallationToken:
        cached = self._cache.get(installation_id)
        if cached is not None and not force and cached.is_usable():
            return cached

        payload = self._post(
            f"https://api.github.com/app/installations/{installation_id}/access_tokens",
            jwt=build_app_jwt(self._credentials),
        )

        expires = payload.get("expires_at", "")
        token = InstallationToken(
            token=payload["token"],
            expires_at=_parse_expiry(expires),
            repositories=[
                repository["full_name"] for repository in payload.get("repositories", [])
            ],
        )
        self._cache[installation_id] = token
        return token

    def forget(self, installation_id: str) -> None:
        """Drop a cached token — after a revocation, or an installation change."""
        self._cache.pop(installation_id, None)


def _parse_expiry(value: str) -> float:
    from datetime import datetime, timezone

    if not value:
        # Treat an unparseable expiry as already stale rather than as forever: the
        # cost is one extra mint, and the alternative is a token that is used long
        # after GitHub stopped honouring it.
        return time.time()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def installation_url(app_slug: str, *, state: str = "") -> str:
    """Where a user goes to install the App.

    `state` is echoed back to the callback and is how an installation is tied to
    the workspace that asked for it. Without it, a callback arrives with a GitHub
    installation id and no idea whose it is.
    """
    base = f"https://github.com/apps/{app_slug}/installations/new"
    return f"{base}?state={state}" if state else base
