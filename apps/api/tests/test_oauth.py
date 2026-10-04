import sys
from pathlib import Path
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import oauth_routes as oauth


@pytest.mark.parametrize("url", ["https://example.com/callback", "http://localhost:1234/callback", "http://127.0.0.1/callback", "http://127.0.0.1:1234/other", "http://evil@127.0.0.1:1234/callback", "http://127.0.0.1:1234/callback?code=x"])
def test_exchange_only_accepts_native_loopback(url):
    with pytest.raises(ValidationError): oauth.Exchange(code="test", code_verifier="v"*64, redirect_uri=url)


def test_exchange_discards_google_access_and_refresh_tokens(monkeypatch):
    monkeypatch.setenv("DECKASTRA_GOOGLE_DESKTOP_CLIENT_ID", "public-id")
    monkeypatch.setenv("DECKASTRA_GOOGLE_DESKTOP_SECRET", "server-only-secret")
    class Reply:
        status_code=200
        def json(self): return {"id_token": "identity-token", "access_token": "private-access", "refresh_token": "private-refresh"}
    def post(url, *, timeout, data):
        assert url == "https://oauth2.googleapis.com/token"
        assert data["client_secret"] == "server-only-secret" and data["code_verifier"] == "v"*64
        return Reply()
    monkeypatch.setattr(oauth.httpx,"post",post)
    response=oauth.exchange(oauth.Exchange(code="test",code_verifier="v"*64,redirect_uri="http://127.0.0.1:1234/callback"))
    assert response.body == b'{"id_token":"identity-token"}'
    assert response.headers["cache-control"] == "no-store"
