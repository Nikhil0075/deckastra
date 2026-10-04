"""The Creative Director (doc 03 §10).

Proposes visual intent — the mood, which role carries the emphasis, how much air
the type gets — expressed in tokens the theme already defines.

Doc 03 §10's "important boundary" is the entire point of the node: it names
*which token*, never what colour the token is. A model that emits `#4CC2FF` has
left the theme behind, and the next theme change silently stops applying to
whatever it touched. The check below is not decoration; it is what makes the
boundary real rather than requested.
"""

from __future__ import annotations

import re
from typing import Any

from ..contracts import CreativeDirection
from ..envelope import Source, envelope, user_brief
from ..state import PresentationAgentState
from ._common import NodeContext, ask_model, completed, started

AGENT_ID = "creative"
STAGE = "creative"

SYSTEM = """\
You are the Creative Director for Deckastra.

You choose the visual register of a deck. You express it entirely in the theme's
own vocabulary — token paths like `colors.accent` — and never as literal values.

You do NOT emit:
  - hex colours, rgb() values, or colour names,
  - font sizes, line heights, or spacing numbers,
  - coordinates of any kind.

Those all come from the theme and from deterministic layout. If you name a
literal, the next theme change stops applying to whatever you touched, and the
deck quietly stops being consistent.

Choose:
  mood              two or three words, e.g. "calm, technical"
  emphasis_role     the semantic role that should carry weight on most slides
  accent_token      a token path from the theme, e.g. "colors.accent"
  typography_scale  compact | balanced | generous
  rationale         one sentence a user would find useful\
"""

#: A literal colour in any of the forms a model reaches for.
_LITERAL_COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(")


def creative(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Proposing a visual direction"))
    ctx.budget.check_clock()

    request = state.get("request") or {}
    plan = state.get("story_plan") or {}

    outline = "\n".join(
        f"- {slide.get('layout', '?')}: {slide.get('headline', '')}"
        for slide in (plan.get("slides") or [])[:12]
    )

    user = "\n".join(
        [
            "Propose a visual direction for this deck.",
            "",
            user_brief(str(request.get("instruction", ""))),
            "",
            "The narrative, in outline:",
            outline or "(no slides yet)",
        ]
    )

    memory_context = ctx.memory.prompt_context() if ctx.memory else ""

    direction = ask_model(
        ctx,
        stage=STAGE,
        task_type="structured",
        system=SYSTEM,
        user=user,
        model=CreativeDirection,
        context=[memory_context] if memory_context else None,
        max_tokens=2_000,
    )

    warnings: list[str] = []
    payload = direction.model_dump(mode="json")

    # A literal that got through is dropped rather than used. The theme's own
    # accent is always a defensible answer; a hardcoded colour never is.
    if _LITERAL_COLOUR.search(direction.accent_token) or not direction.accent_token.startswith("colors."):
        warnings.append(
            f"The Creative Director proposed {direction.accent_token!r}, which is not a theme "
            "token; the theme's accent was used instead."
        )
        payload["accent_token"] = "colors.accent"

    ctx.emit(completed(state, STAGE, AGENT_ID, direction.rationale))

    return {"current_stage": STAGE, "creative_direction": payload, "warnings": warnings}
