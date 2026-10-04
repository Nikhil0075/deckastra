"""Transient desktop PKCE exchange. Google application secrets stay in the cloud."""
import os
import time
import threading
from collections import deque
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

router = APIRouter(prefix="/v1/auth")
_requests = deque()
_lock = threading.Lock()


class Exchange(BaseModel):
    code: str = Field(min_length=1, max_length=4096, pattern=r"^\S+$")
    code_verifier: str = Field(min_length=43, max_length=128, pattern=r"^[A-Za-z0-9._~-]+$")
    redirect_uri: str = Field(max_length=128)

    @model_validator(mode="after")
    def loopback_only(self):
        url = urlsplit(self.redirect_uri)
        if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.username or url.password or url.path != "/callback" or url.query or url.fragment:
            raise ValueError("A desktop loopback callback is required.")
        return self


@router.post("/google/exchange")
def exchange(request: Exchange):
    client_id = os.environ.get("DECKASTRA_GOOGLE_DESKTOP_CLIENT_ID")
    secret = os.environ.get("DECKASTRA_GOOGLE_DESKTOP_SECRET")
    if not client_id or not secret:
        raise HTTPException(503, "Desktop sign-in is not configured.")
    with _lock:
        now = time.monotonic()
        while _requests and _requests[0] <= now - 60:
            _requests.popleft()
        if len(_requests) >= 60:
            raise HTTPException(429, "Sign-in is busy. Try again shortly.")
        _requests.append(now)
    try:
        reply = httpx.post("https://oauth2.googleapis.com/token", timeout=30, data={
            "code": request.code, "client_id": client_id, "client_secret": secret,
            "redirect_uri": request.redirect_uri, "grant_type": "authorization_code", "code_verifier": request.code_verifier})
        if reply.status_code != 200:
            raise HTTPException(401, "Google sign-in could not complete. Start sign-in again.")
        token = reply.json().get("id_token")
        if not isinstance(token, str) or len(token) > 16000:
            raise HTTPException(502, "Google returned an invalid sign-in response.")
        # No Google access/refresh tokens, persistence, or request-body logging.
        from fastapi.responses import JSONResponse
        return JSONResponse({"id_token": token}, headers={"Cache-Control": "no-store"})
    except httpx.HTTPError:
        raise HTTPException(502, "Google sign-in is temporarily unavailable.") from None
