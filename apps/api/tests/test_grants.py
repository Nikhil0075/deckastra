"""Scoped grants: what a bridge credential may do (D2 closure audit, 2026-09-12).

The desktop hands an MCP client a credential. It used to hand over the *launch
secret* — the app's own — which meant "an agent cannot approve its own proposal"
was true only because that adapter did not register an approve tool. Anything
else holding the file could do everything, and an adapter's omissions are not a
security boundary.

A grant is signed with the launch secret, carries a set of capabilities and an
expiry, and is refused by the authority when it reaches past them. These tests
are about the refusals, because that is the whole feature.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import grants, local_mode  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402

SECRET = "a-launch-secret-that-is-long-enough-to-pass"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DECKASTRA_LOCAL_MODE", "1")
    monkeypatch.setenv("DECKASTRA_LOCAL_SECRET", SECRET)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'grants.db'}")
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def deck(client):
    created = client.post("/v1/presentations", headers=bearer(SECRET), json={"title": "Grants"})
    assert created.status_code == 201, created.text
    return created.json()


def retitle(client, token: str, deck, title: str):
    return client.post(
        f"/v1/presentations/{deck['presentation_id']}/transactions",
        headers=bearer(token),
        json={
            "operations": [{"op": "replace", "path": "/metadata/title", "value": title}],
            "intent": "Retitle",
            "expected_version_id": deck["version_id"],
            "client_id": "mcp:test",
        },
    )


# ------------------------------------------------------------------- the shape


def test_a_grant_carries_less_than_the_secret_that_signed_it(client):
    read_only = local_mode.mint_grant({"read"}, ttl_seconds=60)
    assert local_mode.scopes_for(read_only) == frozenset({"read"})
    # The app's own secret is the app: it can do everything.
    assert local_mode.scopes_for(SECRET) == local_mode.FULL_SCOPES
    # And a grant cannot widen itself by naming something this build lacks.
    with pytest.raises(local_mode.LocalModeMisconfigured):
        local_mode.mint_grant({"read", "administer-everything"}, ttl_seconds=60)


def test_a_tampered_or_expired_grant_is_not_a_credential(client):
    grant = local_mode.mint_grant({"read", "write"}, ttl_seconds=60)
    prefix, payload, signature = grant.split(".")

    # Same payload, someone else's signature.
    assert local_mode.scopes_for(f"{prefix}.{payload}.{signature[:-2]}xx") is None
    # A payload claiming more, signed for less.
    wider = local_mode.mint_grant({"read"}, ttl_seconds=60).split(".")[1]
    assert local_mode.scopes_for(f"{prefix}.{wider}.{signature}") is None
    # And time is part of it.
    expired = local_mode.mint_grant({"read"}, ttl_seconds=-1)
    assert local_mode.scopes_for(expired) is None

    refused = client.get("/v1/account", headers=bearer(expired))
    assert refused.status_code == 401


# -------------------------------------------------------------- the refusals


def test_a_read_only_grant_can_read_and_cannot_write(client, deck):
    token = local_mode.mint_grant({"read"}, ttl_seconds=60)

    assert client.get("/v1/account", headers=bearer(token)).status_code == 200
    assert (
        client.get(f"/v1/presentations/{deck['presentation_id']}", headers=bearer(token)).status_code
        == 200
    )

    refused = retitle(client, token, deck, "By a reader")
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["required_scope"] == "write"

    # Nothing happened: a refusal that still wrote would be worse than no refusal.
    document = client.get(
        f"/v1/presentations/{deck['presentation_id']}", headers=bearer(SECRET)
    ).json()["document"]
    assert document["metadata"]["title"] != "By a reader"


def test_a_writing_grant_still_cannot_approve_or_share(client, deck):
    """The two capabilities an agent's credential is deliberately not given.

    Approval is the human's half of proposal-before-apply, and a share link is a
    bearer credential to the document that cannot be recalled from whoever read
    it. This is what makes those refusals a property of the credential rather than
    of which tools an adapter happened to register.
    """
    token = local_mode.mint_grant({"read", "write", "export"}, ttl_seconds=60)

    assert retitle(client, token, deck, "By an agent").status_code == 200

    approved = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals/txn_whatever/approve",
        headers=bearer(token),
    )
    assert approved.status_code == 403, approved.text
    assert approved.json()["detail"]["required_scope"] == "approve"

    shared = client.post(
        f"/v1/presentations/{deck['presentation_id']}/shares",
        headers=bearer(token),
        json={"role": "viewer"},
    )
    assert shared.status_code == 403, shared.text
    assert shared.json()["detail"]["required_scope"] == "share"


def test_the_refusal_comes_before_the_route_decides_anything(client, deck):
    """403 for a capability, not 404 for a thing that is not there.

    The approve above names a transaction that does not exist. A credential check
    that ran after the route would have answered 404 and told an agent its
    credential was fine.
    """
    token = local_mode.mint_grant({"read", "write"}, ttl_seconds=60)
    answer = client.post(
        f"/v1/presentations/{deck['presentation_id']}/proposals/txn_missing/approve",
        headers=bearer(token),
    )
    assert answer.status_code == 403


def test_an_unknown_token_is_unauthenticated_not_unauthorised(client, deck):
    # Answering 403 would tell someone who has not authenticated at all which
    # capability they were missing.
    answer = retitle(client, "not-a-real-token-at-all", deck, "Nope")
    assert answer.status_code == 401


def test_the_launch_secret_keeps_every_capability(client, deck):
    """The app's own proxy must not be narrowed by this."""
    assert retitle(client, SECRET, deck, "By the app").status_code == 200
    # Sharing is 404 in local mode by design — the point here is that it is not
    # refused as a *capability*.
    shared = client.post(
        f"/v1/presentations/{deck['presentation_id']}/shares",
        headers=bearer(SECRET),
        json={"role": "viewer"},
    )
    assert shared.status_code != 403


def test_a_new_changing_route_needs_write_by_default(client):
    """Forgetting fails closed.

    The table names narrower capabilities; anything else that changes something
    requires `write` because of its method, so a route added tomorrow is covered
    without anyone remembering to add it here.
    """
    from deckastra_api.grants import required_scope

    assert required_scope("POST", "/v1/presentations/p1/some-future-write") == "write"
    assert required_scope("DELETE", "/v1/presentations/p1/whatever") == "write"
    assert required_scope("GET", "/v1/presentations/p1/whatever") == "read"
    assert required_scope("POST", "/v1/presentations/p1/proposals/t1/approve") == "approve"
    assert required_scope("POST", "/v1/presentations/p1/exports") == "export"


def test_expiry_is_carried_in_the_grant_itself(client):
    """No table to keep, and nothing to get out of step with the process."""
    short = local_mode.mint_grant({"read"}, ttl_seconds=1)
    assert local_mode.scopes_for(short) == frozenset({"read"})
    time.sleep(1.1)
    assert local_mode.scopes_for(short) is None


# ----------------------------------------------------------------- revocation


def test_revoking_stops_a_grant_that_was_already_handed_out(client, deck):
    """What revoking has to mean.

    A grant lasts hours. Withdrawing the attachment file only stops the *next*
    reader; whoever already holds one would keep working for the rest of the day
    after the user said stop. So revocation names a moment, and every grant
    issued up to it is refused.
    """
    token = local_mode.mint_grant({"read", "write"}, ttl_seconds=3_600)
    assert client.get("/v1/account", headers=bearer(token)).status_code == 200

    revoked = client.post("/v1/local/agent-access/revoke", headers=bearer(SECRET))
    assert revoked.status_code == 200, revoked.text

    time.sleep(1.1)  # the moment is whole seconds, as the grant's own claim is
    refused = client.get("/v1/account", headers=bearer(token))
    assert refused.status_code == 401, refused.text

    # And access can be given again without restarting anything.
    fresh = local_mode.mint_grant({"read"}, ttl_seconds=3_600)
    assert client.get("/v1/account", headers=bearer(fresh)).status_code == 200


def test_an_agent_cannot_revoke(client):
    """Otherwise a credential could manage its own leash — or someone else's."""
    token = local_mode.mint_grant({"read", "write", "export"}, ttl_seconds=60)
    refused = client.post("/v1/local/agent-access/revoke", headers=bearer(token))
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["required_scope"] == "administer"

    # And the refusal did not quietly revoke anything on the way past.
    assert client.get("/v1/account", headers=bearer(token)).status_code == 200


def test_an_agent_cannot_delete_restore_or_move_a_deck(client):
    """A deck's life is a person's decision (editor Phase 5).

    Deleting, restoring and moving a deck, and restoring an earlier version over
    the current one, each replace or remove a whole deck at once and apply
    immediately, outside the proposals that keep an agent's edits in front of a
    person. An agent's credential carries `write`, and before `manage` existed
    every one of these routes needed only that.
    """
    token = local_mode.mint_grant({"read", "write", "export"}, ttl_seconds=60)
    for method, path in (
        ("DELETE", "/v1/presentations/doc_x"),
        ("POST", "/v1/presentations/doc_x/restore"),
        ("POST", "/v1/presentations/doc_x/versions/ver_x/restore"),
        ("POST", "/v1/presentations/doc_x/move"),
    ):
        refused = client.request(method, path, headers=bearer(token), json={})
        assert refused.status_code == 403, (method, path, refused.text)
        assert refused.json()["detail"]["required_scope"] == "manage", path

    # The control: ordinary editing is still the agent's to do.
    assert grants.required_scope("POST", "/v1/presentations/doc_x/transactions") == "write"
    assert "manage" not in local_mode.scopes_for(token)
    assert "manage" in local_mode.scopes_for(SECRET)


def test_an_agent_cannot_decide_a_paused_outline(client):
    """The story checkpoint is a person's review (editor Phase 6).

    An agent may start a generation, and may read the outline it paused on —
    but answering it is the same act as approving a proposal.
    """
    token = local_mode.mint_grant({"read", "write", "export"}, ttl_seconds=60)
    refused = client.post("/v1/runs/run_x/resume", headers=bearer(token), json={"action": "approve"})
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["required_scope"] == "approve"
    # The control: starting one and reading it are ordinary work.
    assert grants.required_scope("POST", "/v1/generate/review") == "write"
    assert grants.required_scope("GET", "/v1/runs/run_x/checkpoint") == "read"


def test_a_grant_that_cannot_say_when_it_was_issued_is_refused(client):
    """The claim the desktop forgot, and nothing said so.

    `iat` is what places a grant either side of a revocation. The desktop mints
    its own grants in TypeScript against this format, and for a while it omitted
    this one — so every credential it published was refused by every request,
    while the app went on publishing and the window went on saying agents could
    work. Two implementations of one format need a test on each side.
    """
    import base64
    import hashlib
    import hmac
    import json

    payload = base64.urlsafe_b64encode(
        json.dumps({"s": ["read"], "exp": int(time.time()) + 60}, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(SECRET.encode(), payload.encode("ascii"), hashlib.sha256).digest()
        )
        .decode()
        .rstrip("=")
    )
    # Correctly signed, unexpired, and still not a credential.
    assert local_mode.scopes_for(f"dk1.{payload}.{signature}") is None


def test_no_grant_carries_administer(client):
    from deckastra_api import local_mode as mode

    for scopes in ({"read"}, {"read", "write"}, {"read", "write", "export"}):
        assert "administer" not in mode.scopes_for(mode.mint_grant(scopes, ttl_seconds=60))
    # The app's own credential has it, which is how the desktop revokes.
    assert "administer" in mode.scopes_for(SECRET)
