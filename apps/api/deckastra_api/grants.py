"""What a credential may do, in one table (D2 closure audit, 2026-09-12).

The desktop hands an MCP client a credential. Until this existed, that credential
was the *launch secret* — the app's own — so "an agent cannot approve its own
proposal" and "an agent cannot mint a share link" were true only because the
adapter did not register those tools. An adapter's omissions are a choice made in
one file; anything else holding the same secret could do the lot.

So the authority decides instead. A grant (`local_mode.mint_grant`) carries a set
of capabilities, and this module says which capability a request needs. Two
properties worth the indirection:

- **One table, not a decorator per route.** A check spread across forty routes is
  a check the forty-first forgets. Here a new route inherits the default for its
  method — `write` for anything that changes something — so forgetting fails
  closed rather than open.
- **It is a second gate, never a replacement.** Membership and role still decide
  what the *person* may do (`resolve_*`); this decides what the *credential* may
  do on their behalf. A viewer's token with a `write` scope still cannot write.

Outside local mode every principal carries `FULL_SCOPES`, so nothing about the
deployed product changes.
"""

from __future__ import annotations

import re

from fastapi import Request
from fastapi.responses import JSONResponse

from . import local_mode

#: Methods that change something. Anything here needs `write` unless a rule below
#: names something narrower.
CHANGING = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: Narrower capabilities, matched first. Each exists because handing it to an
#: agent is a decision someone should make deliberately:
#:
#: - **approve** is the human's half of proposal-before-apply. An agent that holds
#:   it can wave through its own work.
#: - **share** mints a bearer credential to a document. A link cannot be recalled
#:   from whoever already read it.
#: - **export** writes a file and can be large and slow; worth being able to hand
#:   over separately from ordinary editing.
#: - **administer** is the app's own: granting and revoking agent access. No
#:   grant carries it, which is what stops an agent from managing its own leash.
RULES: tuple[tuple[re.Pattern[str], frozenset[str], str], ...] = (
    # Only the app itself. A grant that could revoke grants could revoke someone
    # else's access, or turn its own refusals into a thing it decides about.
    (re.compile(r"^/v1/local/agent-access(/|$)"), CHANGING, "administer"),
    (
        re.compile(r"^/v1/presentations/[^/]+/proposals/[^/]+/(approve|reject)$"),
        frozenset({"POST"}),
        "approve",
    ),
    (re.compile(r"^/v1/presentations/[^/]+/shares$"), CHANGING, "share"),
    (re.compile(r"^/v1/shares(/|$)"), CHANGING, "share"),
    (re.compile(r"^/v1/presentations/[^/]+/exports$"), frozenset({"POST"}), "export"),
    (re.compile(r"^/v1/exports/[^/]+/(cancel|retry)$"), frozenset({"POST"}), "export"),
)


def required_scope(method: str, path: str) -> str:
    """The capability this request needs. Unknown routes default to their method."""
    for pattern, methods, scope in RULES:
        if method in methods and pattern.match(path):
            return scope
    return "write" if method in CHANGING else "read"


async def scope_middleware(request: Request, call_next):
    """Refuse a request the caller's credential is not allowed to make.

    Only in local mode, and only for tokens this process recognises: an
    unrecognised one falls through to the route's own authentication, which
    answers 401. Answering 403 here would tell an unauthenticated caller which
    capability it was missing, which is a fact about the product it has not
    earned.
    """
    try:
        if not local_mode.enabled():
            return await call_next(request)
    except local_mode.LocalModeMisconfigured:
        # The route's dependency raises this into a proper answer; middleware
        # deciding it would produce a 500 with no explanation.
        return await call_next(request)

    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return await call_next(request)

    granted = local_mode.scopes_for(header[7:].strip())
    if granted is None:
        return await call_next(request)

    needed = required_scope(request.method, request.url.path)
    if needed in granted:
        return await call_next(request)

    return JSONResponse(
        status_code=403,
        content={
            "detail": {
                "message": (
                    f"This credential may not {needed}. It was granted: "
                    f"{', '.join(sorted(granted)) or 'nothing'}."
                ),
                "code": "E403",
                "required_scope": needed,
            }
        },
    )
