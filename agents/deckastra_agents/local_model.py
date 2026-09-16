"""Local intelligence: a llama.cpp server behind the one model interface (D3).

`ModelClient` is a single method, so a third provider is plumbing. What is not
plumbing is everything around it, and the shape below is chosen for those:

**A supervised server process, not in-process bindings.** `llama-cpp-python`
would put a compiled runtime — and a GPU variant of it — inside the PyInstaller
sidecar that D1 fought down to 103MB, and every user would carry it whether or
not they ever install a model. A separate process keeps "no model installed" a
coherent state rather than an import error, keeps offload flags a property of the
server rather than of our packaging, and is the pattern the desktop already has
for exactly one child process.

**The OpenAI-compatible endpoint**, not because compatibility is a goal but
because that is where llama.cpp exposes schema-constrained sampling and a `usage`
object. Both are load-bearing here.

**The schema is a hint, and our validation is the authority.** llama.cpp converts
JSON Schema to a GBNF grammar, and that converter covers a subset — patterns,
some compositions, and `$ref` past a certain depth do not survive. A grammar that
quietly dropped a constraint produces output that *parses* and is wrong, which is
worse than a refusal. `ask_model` validates every response against the Pydantic
contract and repairs, and that stays true no matter what the sampler promised.

**Tokens are reported, never estimated.** A budget that invents its own numbers
tells the user a run was cheap because nobody counted it. Note that the token
ceiling means something different here: for a cloud model it is money, and for a
local one it is the user's own hardware and their time, which the wall-clock
ceiling is the honest bound on.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .budgets import RunBudget
from .envelope import POLICY
from .model_packs import (
    MODEL_DIR_ENV,
    ModelPack,
    installed_packs,
    model_root,
    scan,
    selected_pack,
)
from .router import ModelError, ModelRequest, ModelResponse, ModelUnavailable

#: Where the server listens. It is a loopback port like the workspace service's,
#: and like that one it is configured rather than assumed.
SERVER_URL_ENV = "DECKASTRA_MODEL_SERVER"
DEFAULT_SERVER_URL = "http://127.0.0.1:8081"

#: Low, because almost everything the agents ask for is a transformation into a
#: schema rather than an invention, and a small model at a high temperature
#: wanders out of its grammar. The benchmark decides whether this is right.
TEMPERATURE = 0.3

#: Fixed, so two benchmark runs of the same pack on the same prompt are
#: comparable. Determinism is not free on a GPU, but a moving seed guarantees it
#: is absent.
SEED = 7

#: Never wait longer than this on one request even when the run's clock allows
#: it. A local model that has stopped producing tokens is not going to start.
MAX_REQUEST_SECONDS = 600.0


def server_url() -> str:
    return os.environ.get(SERVER_URL_ENV, "").strip() or DEFAULT_SERVER_URL


class LlamaServerClient:
    """A `ModelClient` over a llama.cpp server on loopback."""

    def __init__(self, pack: ModelPack, base_url: str | None = None, transport: Any = None) -> None:
        self.pack = pack
        self.base_url = (base_url or server_url()).rstrip("/")
        # Injected by tests; nothing in the product passes one.
        self._transport = transport

    def retarget(self, base_url: str) -> None:
        """Point at a runtime that has been restarted somewhere else.

        A supervised runtime picks a free port each time it starts, so a client
        that outlives an idle shutdown holds an address nothing answers on — and
        the next generation fails with "the local model server is not answering"
        on a machine where it is. The supervisor knows the new address; this is
        how it says so, rather than the wrapper reaching into an attribute it
        does not own.
        """
        self.base_url = base_url.rstrip("/")

    def _client(self, timeout: float):
        import httpx

        return httpx.Client(timeout=timeout, transport=self._transport)

    def complete(self, request: ModelRequest, budget: RunBudget) -> ModelResponse:
        import httpx

        budget.check_clock()

        system = "\n\n".join([request.system, *request.context, POLICY])
        body: dict[str, Any] = {
            "model": self.pack.id,
            "messages": [{"role": "system", "content": system}, *request.messages],
            "max_tokens": request.max_tokens,
            "temperature": TEMPERATURE,
            "seed": SEED,
            "stream": False,
        }
        if request.response_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "contract",
                    "schema": request.response_schema,
                    "strict": True,
                },
            }

        # One request can never outlive the run it belongs to. Without this a
        # local model that has wedged holds a user past the wall-clock ceiling
        # the budget exists to enforce, and the ceiling then reports a time that
        # had already passed when it was checked.
        remaining = budget.max_wall_clock_seconds - budget.elapsed_seconds
        timeout = max(1.0, min(remaining, MAX_REQUEST_SECONDS))

        try:
            with self._client(timeout) as client:
                answer = client.post(f"{self.base_url}/v1/chat/completions", json=body)
        except httpx.ConnectError as error:
            raise ModelUnavailable(
                f"The local model server is not answering at {self.base_url}. "
                f"'{self.pack.name}' is installed, so this is the server rather than "
                "the model: start Deckastra's local intelligence, or check the port."
            ) from error
        except (httpx.ReadError, httpx.RemoteProtocolError) as error:
            # The connection died mid-answer, which means the runtime did. This
            # was a raw `ReadError: [WinError 10054]` reaching the user, and on
            # this hardware it has one overwhelmingly likely cause: a context
            # large enough to push the model off the card, so the allocation that
            # fails is the one made while generating.
            raise ModelUnavailable(
                f"'{self.pack.name}' stopped while answering. The usual cause is memory — "
                "a context too large to hold beside the model, so the runtime dies partway "
                "through rather than refusing at load. Serving a smaller context is the fix."
            ) from error
        except httpx.TimeoutException as error:
            raise ModelError(
                f"'{self.pack.name}' did not answer within {timeout:.0f}s. On this machine "
                "the model may be too large to run at a usable speed."
            ) from error

        if answer.status_code == 400 and request.response_schema is not None:
            # Worth its own sentence: this is the failure that separates a local
            # model from a cloud one. llama.cpp builds a grammar from the schema,
            # its converter covers a subset, and a contract it cannot express is
            # rejected outright rather than sampled loosely.
            raise ModelError(
                f"'{self.pack.name}' could not constrain its output to this contract "
                f"({answer.text[:300]}). The schema is beyond what this runtime can "
                "turn into a grammar."
            )
        if answer.status_code >= 400:
            raise ModelError(
                f"The local model server answered {answer.status_code}: {answer.text[:300]}"
            )

        try:
            payload = answer.json()
            text = payload["choices"][0]["message"]["content"] or ""
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
            raise ModelError(
                "The local model server answered something this client does not "
                f"understand: {answer.text[:300]}"
            ) from error

        usage = payload.get("usage") or {}
        input_tokens = usage.get("prompt_tokens")
        output_tokens = usage.get("completion_tokens")
        if input_tokens is None or output_tokens is None:
            # Charged as zero and *said*. Silently estimating would make a run on
            # this pack look cheaper than one on another, and comparing packs is
            # the entire point of the D3 benchmark.
            budget.warn(
                f"'{self.pack.name}' reported no token counts, so this run's token "
                "total is missing its local model calls. The wall-clock total is complete."
            )
            input_tokens = output_tokens = 0
        budget.spend_tokens(int(input_tokens), int(output_tokens))

        return ModelResponse(
            text=text,
            input_tokens=int(input_tokens),
            output_tokens=int(output_tokens),
            model=self.pack.id,
        )


def local_client(root: Path | None = None) -> LlamaServerClient:
    """The local client, or a refusal that names what to do about it.

    **There is no path from here to a cloud model.** A user who chose local
    intelligence did so for a reason — no key, no network, or nothing of theirs
    leaving the machine — and an install that quietly answered from Anthropic
    when a pack was missing would break that silently, in the one direction that
    cannot be undone once the request has been sent. So every branch below
    raises, and none of them reads an API key.
    """
    where = root if root is not None else model_root()
    if where is None:
        raise ModelUnavailable(
            "Local intelligence is selected and no model directory is configured. Set "
            f"{MODEL_DIR_ENV} to where model packs are installed, or choose cloud generation."
        )

    packs, problems = scan(where)
    if not packs:
        detail = "".join(f"\n  - {problem.directory.name}: {problem.reason}" for problem in problems)
        raise ModelUnavailable(
            f"Local intelligence is selected and no model pack is installed in {where}."
            + (f" Directories that look like packs and are not usable:{detail}" if detail else "")
            + " Install a model pack, or choose cloud generation."
        )

    pack = selected_pack(where)
    if pack is None:
        names = ", ".join(sorted(one.id for one in installed_packs(where)))
        raise ModelUnavailable(
            "Local intelligence is selected and more than one model pack is installed "
            f"({names}). Set DECKASTRA_MODEL_PACK to the one to use — choosing for you "
            "would leave which model wrote a deck unrecorded."
        )

    return LlamaServerClient(pack)
