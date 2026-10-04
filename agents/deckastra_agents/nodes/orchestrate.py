"""The Orchestrator (doc 03 §7).

Reads the request, decides which stages the run needs, and fixes the scope. It
never edits anything — doc 03 §7's non-responsibilities are as load-bearing as
its responsibilities, because an orchestrator that also edits becomes the place
every future feature is added and the other agents stop mattering.

The scope decision is the important one. Doc 03 §28 requires edit scope to be
always explicit, and this is where "explicit" is created: an ambiguous request
resolves to the narrowest defensible scope, or asks. It never widens to the deck
on a guess, because the cost of guessing wide is a rewritten presentation and the
cost of guessing narrow is one more turn of conversation.
"""

from __future__ import annotations

from typing import Any

from ..contracts import Intent, OrchestratorPlan
from ..envelope import Source, envelope, user_brief
from ..state import PresentationAgentState
from ._common import NodeContext, ask_model, completed, started

AGENT_ID = "orchestrator"
STAGE = "orchestrate"

SYSTEM = """\
You are the Orchestrator for Deckastra, a presentation studio.

You do one thing: read a request and decide which specialists should run and what
the request is about. You never write copy, choose a layout, or edit a slide.

Available stages, in the order they run:

  research  Only when the request references material outside the deck itself.
  story     Narrative and copy. Needed to create a deck or rewrite its structure.
  creative  Visual direction. Needed when the request is about how it looks.
  layout    Which layout each slide uses. Needed when structure changes.
  motion    What moves and in what order. Run it when a deck is created, or when
            the request is about animation, pacing or reveals. Skip it when the
            deck should be still — a still deck is a legitimate answer.
  critic    Quality review. Run it for anything that creates or restructures.

Scope rules, which matter more than the stage list:

- If the request names or implies specific slides or elements, the scope is those.
- If the user has a selection and the request could plausibly be about it, the
  scope is that selection.
- Only choose "deck" when the request is unambiguously about the whole
  presentation, or when there is no deck yet.
- When you genuinely cannot tell, set clarification_needed to true and put the
  question in `clarification`. One more question costs a turn; guessing "deck"
  costs the user their presentation. When the request is clear, clarification_needed
  is false and `clarification` is empty — do not explain that it is clear.

A small contextual edit — change this text, fix this wording, move this — needs
no stages at all. Return an empty stage list and let the edit path handle it.\
"""


def orchestrate(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Reading the request"))
    ctx.budget.check_clock()

    request = state.get("request", {})
    scope = state.get("scope") or {}
    document = state.get("document") or {}

    selection = scope.get("element_ids") or []
    slides = document.get("slides") or []

    user = "\n".join(
        [
            "Route this request.",
            "",
            user_brief(str(request.get("instruction", ""))),
            "Attached sources below are available to research; do not ask for these sources again.",
            envelope(str([{"id": source.get("id"), "title": source.get("title"), "text": str(source.get("text", ""))[:1200]} for source in state.get("source_inputs", [])]), Source(id="attached-sources", kind="document")),
            "",
            f"The deck currently has {len(slides)} slide(s).",
            (
                f"The user has {len(selection)} element(s) selected on slide(s) "
                f"{', '.join(scope.get('slide_ids') or []) or 'unknown'}."
                if selection
                else "The user has nothing selected."
            ),
        ]
    )

    plan = ask_model(
        ctx,
        stage=STAGE,
        task_type="fast",
        system=SYSTEM,
        user=user,
        model=OrchestratorPlan,
        max_tokens=2_000,
    )

    # The model proposes a scope kind; the *facts* of the scope come from what the
    # user actually selected. A model that widens a selection to the deck would
    # be widening it silently, which is the failure this whole node exists to
    # prevent.
    resolved_scope = dict(scope)
    resolved_scope["kind"] = plan.scope_kind
    if plan.scope_kind == "elements" and not selection:
        # Nothing is selected, so "elements" is not a scope anyone can act on.
        resolved_scope["kind"] = "slide" if resolved_scope.get("slide_ids") else "deck"

    question = plan.clarification.strip()
    if plan.clarification_needed and question:
        ctx.emit(completed(state, STAGE, AGENT_ID, f"Needs a clarification: {question}"))
        return {
            "current_stage": "story_checkpoint",
            "awaiting": "clarification",
            "scope": resolved_scope,
            "warnings": [question],
            "orchestrator_plan": plan.model_dump(mode="json"),
        }

    if plan.clarification_needed:
        # It says it needs to ask and has not said what. Halting here would put a
        # blank question in front of the user, which is a dead end rather than a
        # checkpoint — there is nothing for them to answer and nothing for the
        # run to resume on. Carry on with what it routed, and say that it wanted
        # to ask, so the warning reaches the user beside the deck.
        warnings = [
            "The planner said it wanted to ask something and did not say what, "
            "so the deck was composed from the brief as written."
        ]
    else:
        warnings = []

    stages = [stage for stage in plan.stages if stage in KNOWN_STAGES]
    dropped = [stage for stage in plan.stages if stage not in KNOWN_STAGES]

    ctx.emit(completed(state, STAGE, AGENT_ID, plan.reasoning))

    return {
        "current_stage": STAGE,
        "scope": resolved_scope,
        "orchestrator_plan": {
            **plan.model_dump(mode="json"),
            "stages": stages,
        },
        # A stage the model invented is dropped rather than run, and the drop is
        # reported: silently ignoring it would make a mis-routed run look correct.
        "warnings": (
            warnings + ([f"Ignored unknown stage(s): {', '.join(dropped)}"] if dropped else [])
        ),
    }


KNOWN_STAGES = {"research", "story", "creative", "layout", "motion", "critic"}


def is_creation(plan: dict[str, Any] | None) -> bool:
    return bool(plan) and plan.get("intent") == Intent.CREATE_DECK.value
