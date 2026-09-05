"""GitHub App auth and webhooks (doc 05 §19, gap register doc 05 S2).

The webhook signature is the only unauthenticated trust boundary in the product,
so it gets the most attention here. The App auth tests cover the shape of the
exchange without a network: what is signed, what is cached, and what happens when
a token is about to expire.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest
from deckastra_integrations.github.app import (
    AppCredentials,
    GitHubAuthError,
    InstallationToken,
    InstallationTokens,
    REQUIRED_PERMISSIONS,
    build_app_jwt,
    installation_url,
)
from deckastra_integrations.github.webhooks import (
    WebhookRejected,
    decode,
    parse_event,
    verify_signature,
)

SECRET = "s3cret"


def sign(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


# ------------------------------------------------------------- signatures


def test_a_valid_signature_passes():
    body = b'{"action":"created"}'
    verify_signature(body, sign(body), SECRET)  # does not raise


def test_a_tampered_body_is_rejected():
    body = b'{"action":"created"}'
    signature = sign(body)
    with pytest.raises(WebhookRejected):
        verify_signature(b'{"action":"deleted"}', signature, SECRET)


def test_a_signature_from_another_secret_is_rejected():
    body = b"{}"
    with pytest.raises(WebhookRejected):
        verify_signature(body, sign(body, "different"), SECRET)


def test_a_missing_signature_is_rejected():
    with pytest.raises(WebhookRejected, match="Missing or malformed"):
        verify_signature(b"{}", None, SECRET)


def test_an_sha1_signature_is_rejected():
    # GitHub still sends the legacy `X-Hub-Signature`; accepting it would accept a
    # weaker algorithm than the one we asked for.
    with pytest.raises(WebhookRejected):
        verify_signature(b"{}", "sha1=" + hashlib.sha1(b"{}").hexdigest(), SECRET)


def test_no_configured_secret_fails_closed():
    """A deployment that forgot the secret must reject, never allow."""
    body = b"{}"
    with pytest.raises(WebhookRejected, match="No webhook secret"):
        verify_signature(body, sign(body), "")


def test_the_signature_is_over_the_exact_bytes():
    # Re-serialising the JSON changes the bytes and the signature stops matching
    # for reasons nobody can debug. Verification must see the raw body.
    original = b'{"a": 1,  "b": 2}'
    signature = sign(original)
    reserialised = json.dumps(json.loads(original)).encode()

    verify_signature(original, signature, SECRET)
    with pytest.raises(WebhookRejected):
        verify_signature(reserialised, signature, SECRET)


def test_a_body_that_is_not_json_is_rejected():
    with pytest.raises(WebhookRejected):
        decode(b"not json")


# ------------------------------------------------------------------ events


def test_a_push_carries_the_changed_paths_and_the_new_head():
    event = parse_event(
        "push",
        {
            "installation": {"id": 42},
            "repository": {"full_name": "acme/ledger"},
            "after": "abc123",
            "ref": "refs/heads/main",
            "commits": [
                {"added": ["src/new.py"], "modified": ["README.md"], "removed": []},
                {"added": [], "modified": ["README.md"], "removed": ["old.py"]},
            ],
        },
    )

    assert event.kind == "push"
    assert event.installation_id == "42"
    assert event.repositories == ["acme/ledger"]
    # Deduplicated and sorted, so an incremental re-index does each file once.
    assert event.changed_paths == ["README.md", "old.py", "src/new.py"]
    assert event.after_sha == "abc123"


def test_a_push_with_no_commit_list_means_reindex_everything():
    # GitHub omits paths for large pushes. An empty list must not be read as
    # "nothing changed" — the caller treats it as a full re-index.
    event = parse_event(
        "push", {"repository": {"full_name": "acme/ledger"}, "after": "def456"}
    )
    assert event.changed_paths == []
    assert event.after_sha == "def456"


def test_an_uninstall_is_recognised():
    event = parse_event("installation", {"action": "deleted", "installation": {"id": 7}})
    assert event.kind == "installation_deleted"
    assert event.installation_id == "7"


def test_a_suspension_is_treated_as_a_revocation():
    # A suspended installation cannot be read from. Treating it as anything
    # softer would leave indexed content we no longer have permission to hold.
    assert parse_event("installation", {"action": "suspend"}).kind == "installation_deleted"


def test_repository_removal_from_an_installation_is_captured():
    event = parse_event(
        "installation_repositories",
        {
            "installation": {"id": 7},
            "repositories_added": [{"full_name": "acme/new"}],
            "repositories_removed": [{"full_name": "acme/gone"}],
        },
    )
    assert event.repositories == ["acme/new"]
    assert event.changed_paths == ["acme/gone"]


def test_a_deleted_repository_is_recognised():
    event = parse_event(
        "repository", {"action": "deleted", "repository": {"full_name": "acme/ledger"}}
    )
    assert event.kind == "repository_deleted"


def test_an_unknown_event_is_not_an_error():
    # GitHub adds event types. A 500 on one we did not subscribe to shows up as a
    # red delivery history for no reason.
    assert parse_event("discussion", {"action": "created"}).kind == "unhandled"
    assert parse_event("ping", {}).kind == "ping"


# ------------------------------------------------------------------- app


PRIVATE_KEY_ENV = "GITHUB_APP_PRIVATE_KEY"


def rsa_key() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


def test_the_app_only_asks_for_read_permissions():
    """A compromised installation token must not be able to change a repository."""
    assert set(REQUIRED_PERMISSIONS.values()) == {"read"}
    assert "contents" in REQUIRED_PERMISSIONS


def test_the_jwt_is_signed_and_short_lived():
    credentials = AppCredentials(app_id="123", private_key=rsa_key())
    now = int(time.time())
    token = build_app_jwt(credentials, now=now)

    header, payload, signature = token.split(".")
    assert signature

    def decode_part(part: str) -> dict:
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))

    assert decode_part(header)["alg"] == "RS256"
    claims = decode_part(payload)
    assert claims["iss"] == "123"
    # Backdated, because GitHub rejects a token whose `iat` is in its future and a
    # server clock a few seconds fast is common.
    assert claims["iat"] < now
    # GitHub rejects anything over ten minutes.
    assert claims["exp"] - claims["iat"] <= 10 * 60


def test_credentials_accept_a_base64_key():
    # A multi-line PEM in an environment variable is mangled by enough deployment
    # systems that supporting the encoded form is cheaper than debugging it.
    key = rsa_key()
    encoded = base64.b64encode(key.encode()).decode()

    import os

    os.environ["GITHUB_APP_ID"] = "123"
    os.environ[PRIVATE_KEY_ENV] = encoded
    try:
        credentials = AppCredentials.from_environment()
        assert credentials is not None
        assert "BEGIN" in credentials.private_key
    finally:
        os.environ.pop("GITHUB_APP_ID", None)
        os.environ.pop(PRIVATE_KEY_ENV, None)


def test_missing_credentials_are_none_not_an_error():
    """The product runs without GitHub.

    A server that refuses to start because an optional integration is
    unconfigured is a worse failure than the missing feature.
    """
    import os

    os.environ.pop("GITHUB_APP_ID", None)
    os.environ.pop(PRIVATE_KEY_ENV, None)
    assert AppCredentials.from_environment() is None


def test_a_key_that_is_neither_pem_nor_base64_is_a_configuration_error():
    import os

    os.environ["GITHUB_APP_ID"] = "123"
    os.environ[PRIVATE_KEY_ENV] = "!!! not a key !!!"
    try:
        with pytest.raises(GitHubAuthError):
            AppCredentials.from_environment()
    finally:
        os.environ.pop("GITHUB_APP_ID", None)
        os.environ.pop(PRIVATE_KEY_ENV, None)


class FakeTransport:
    def __init__(self) -> None:
        self.calls = 0

    def post(self, url: str, *, jwt: str) -> dict:
        self.calls += 1
        from datetime import datetime, timedelta, timezone

        return {
            "token": f"ghs_token_{self.calls}",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "repositories": [{"full_name": "acme/ledger"}],
        }


def test_an_installation_token_is_cached_and_reused():
    transport = FakeTransport()
    tokens = InstallationTokens(AppCredentials(app_id="1", private_key=rsa_key()), transport)

    first = tokens.get("42")
    second = tokens.get("42")

    assert first.token == second.token
    # Minting is a network round trip and an indexing run makes hundreds of
    # requests.
    assert transport.calls == 1


def test_forgetting_a_token_forces_a_new_one():
    transport = FakeTransport()
    tokens = InstallationTokens(AppCredentials(app_id="1", private_key=rsa_key()), transport)

    tokens.get("42")
    tokens.forget("42")
    tokens.get("42")

    assert transport.calls == 2


def test_a_token_close_to_expiry_is_not_reused():
    # Recovering from a 401 halfway through a run means re-fetching whatever was
    # in flight; the margin costs nothing.
    nearly_expired = InstallationToken(
        token="x", expires_at=time.time() + 60, repositories=[]
    )
    assert not nearly_expired.is_usable()

    fresh = InstallationToken(token="x", expires_at=time.time() + 3600, repositories=[])
    assert fresh.is_usable()


def test_an_unparseable_expiry_is_treated_as_already_stale():
    # The cost is one extra mint. The alternative is a token used long after
    # GitHub stopped honouring it.
    class BadExpiry(FakeTransport):
        def post(self, url: str, *, jwt: str) -> dict:
            return {"token": "x", "expires_at": "not-a-date", "repositories": []}

    tokens = InstallationTokens(AppCredentials(app_id="1", private_key=rsa_key()), BadExpiry())
    assert not tokens.get("42").is_usable()


def test_the_install_url_carries_the_workspace():
    # Without it a callback arrives with an installation id and no idea whose.
    assert "state=wsp_1" in installation_url("deckastra", state="wsp_1")
