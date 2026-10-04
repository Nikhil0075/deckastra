"""The graph (doc 03 §4, §18).

LangGraph owns the edges, the conditional routing and the checkpointer. It does
not own the agents: every node is a plain function of `(state, ctx)` that this
module adapts, so a node can be tested by calling it and the framework stays
replaceable. That is doc 03 §24's argument about model providers, applied to the
graph library — for the same reason, and with the same benefit.

Two structural decisions worth stating.

**The human checkpoint is an interrupt, not a flag.** Doc 03 §17 asks for a story
approval that can pause and resume, and doc 03 §28 makes "story checkpoint can
pause/resume" an acceptance criterion. A boolean the next node checks is not a
pause: the run has already continued. LangGraph's `interrupt_before` stops the
graph with its state checkpointed, so resuming is a real resume — the same run
id, the same thread, hours later if need be.

**Revision routing is a conditional edge, not a loop inside the Critic.** The
Critic returns a verdict; the graph decides where it goes. A Critic that called
the Story Agent itself would be a Critic that has to know how to run one.
"""

from __future__ import annotations

from typing import Any, Callable

from langgraph.graph import END, START, StateGraph

# Imported as functions rather than as modules: `nodes/__init__` exports the node
# functions under the same names as their modules, and `from .nodes import story`
# would bind the function while `story.story` would not exist.
from .nodes._common import NodeContext, NodeFailure
from .nodes.creative import creative as creative_node
from .nodes.critic import critic as critic_node
from .nodes.layout import layout as layout_node
from .nodes.motion import motion as motion_node
from .nodes.orchestrate import orchestrate as orchestrate_node
from .nodes.propose import Composer
from .nodes.propose import propose as propose_node
from .nodes.research import research as research_node
from .nodes.story import story as story_node
from .state import PresentationAgentState

#: Node names. Strings in a graph are typo-prone, so they are constants.
ORCHESTRATE = "orchestrate"
RESEARCH = "research"
STORY = "story"
STORY_CHECKPOINT = "story_checkpoint"
CREATIVE = "creative"
LAYOUT = "layout"
MOTION = "motion"
CRITIC = "critic"
PROPOSE = "propose"


def _guard(name: str, fn: Callable[..., dict[str, Any]]) -> Callable[[PresentationAgentState], dict[str, Any]]:
    """Turn a node failure into state rather than a traceback.

    Doc 03 §21: an agent must never silently ignore a failure, and every error
    must carry its stage, whether it is recoverable, and the fallback. A raised
    exception loses the run; this keeps everything the run produced up to the
    failure and records what happened, which is what the user needs to decide
    whether to retry.
    """

    def run(state: PresentationAgentState) -> dict[str, Any]:
        try:
            return fn(state)
        except NodeFailure as failure:
            return {
                "current_stage": "failed",
                "errors": [failure.as_error()],
                "warnings": [f"{name} failed: {failure}"],
            }

    return run


def build_graph(
    ctx: NodeContext,
    compose: Composer,
    *,
    checkpointer: Any | None = None,
    checkpoint_before_story_approval: bool = True,
) -> Any:
    """Compile the graph.

    `checkpointer` is the Postgres saver in production and `None` in tests. Doc 05
    §25 and doc 03 §19 disagreed about where checkpoints live; the answer is
    Postgres for durable state and Redis for ephemeral progress, which is why the
    progress emitter is a separate concern from this argument.
    """
    builder: Any = StateGraph(PresentationAgentState)

    builder.add_node(ORCHESTRATE, _guard(ORCHESTRATE, lambda s: orchestrate_node(s, ctx)))
    builder.add_node(RESEARCH, _guard(RESEARCH, lambda s: research_node(s, ctx)))
    builder.add_node(STORY, _guard(STORY, lambda s: story_node(s, ctx)))
    # A pass-through: its only job is to be the thing the graph interrupts before.
    builder.add_node(STORY_CHECKPOINT, lambda state: {"awaiting": None})
    builder.add_node(CREATIVE, _guard(CREATIVE, lambda s: creative_node(s, ctx)))
    builder.add_node(LAYOUT, _guard(LAYOUT, lambda s: layout_node(s, ctx)))
    builder.add_node(MOTION, _guard(MOTION, lambda s: motion_node(s, ctx)))
    builder.add_node(CRITIC, _guard(CRITIC, lambda s: critic_node(s, ctx)))
    builder.add_node(PROPOSE, _guard(PROPOSE, lambda s: propose_node(s, ctx, compose)))

    builder.add_edge(START, ORCHESTRATE)

    builder.add_conditional_edges(
        ORCHESTRATE,
        _after_orchestrate,
        {RESEARCH: RESEARCH, STORY: STORY, PROPOSE: PROPOSE, END: END},
    )
    builder.add_edge(RESEARCH, STORY)
    builder.add_edge(STORY, STORY_CHECKPOINT)
    builder.add_conditional_edges(
        STORY_CHECKPOINT,
        _after_checkpoint,
        {CREATIVE: CREATIVE, LAYOUT: LAYOUT, STORY: STORY, END: END},
    )
    builder.add_edge(CREATIVE, LAYOUT)
    builder.add_conditional_edges(LAYOUT, _after_layout, {MOTION: MOTION, CRITIC: CRITIC, PROPOSE: PROPOSE})
    builder.add_conditional_edges(MOTION, _after_motion, {CRITIC: CRITIC, PROPOSE: PROPOSE})
    builder.add_conditional_edges(
        CRITIC,
        _after_critic,
        {STORY: STORY, LAYOUT: LAYOUT, CREATIVE: CREATIVE, MOTION: MOTION, PROPOSE: PROPOSE},
    )
    builder.add_edge(PROPOSE, END)

    return builder.compile(
        checkpointer=checkpointer,
        # The pause the user sees. Nothing after this point runs until a human
        # says so, and the state is durable in between.
        interrupt_before=[STORY_CHECKPOINT] if checkpoint_before_story_approval else None,
    )


# ------------------------------------------------------------------- routing


def _stages(state: PresentationAgentState) -> list[str]:
    return list((state.get("orchestrator_plan") or {}).get("stages") or [])


def _after_orchestrate(state: PresentationAgentState) -> str:
    if state.get("current_stage") == "failed":
        return END
    # A clarification request ends the run with a question rather than guessing.
    if state.get("awaiting") == "clarification":
        return END

    stages = _stages(state)
    if "research" in stages or state.get("source_inputs"):
        return RESEARCH
    if "story" in stages:
        return STORY
    # No stages: a contextual edit, handled by the edit path rather than the
    # full graph. Falling through to propose keeps one exit.
    return PROPOSE


def _after_checkpoint(state: PresentationAgentState) -> str:
    if state.get("current_stage") == "failed":
        return END

    decision = state.get("human_decision") or {}
    if decision.get("action") == "reject":
        return END
    # The reviewer asked for a different outline. Back to the story stage, which
    # reads their note and clears the decision, and then to this checkpoint
    # again: a revised outline is one nobody has approved yet either.
    if decision.get("action") == "revise":
        return STORY

    stages = _stages(state)
    if "creative" in stages:
        return CREATIVE
    return LAYOUT


def _after_layout(state: PresentationAgentState) -> str:
    if state.get("current_stage") == "failed":
        return PROPOSE
    # Motion runs after layout because it sequences by role, and layout is what
    # decides which roles a slide ends up with. Before it, the Motion Agent would
    # be sequencing a slide that no longer exists.
    if "motion" in _stages(state):
        return MOTION
    return CRITIC if "critic" in _stages(state) else PROPOSE


def _after_motion(state: PresentationAgentState) -> str:
    if state.get("current_stage") == "failed":
        return PROPOSE
    return CRITIC if "critic" in _stages(state) else PROPOSE


def _after_critic(state: PresentationAgentState) -> str:
    """Where a revision goes (doc 03 §13.4).

    The routing table is the whole contract: the Critic names a stage, and the
    graph sends the work there. Note that a revision re-enters `story` *before*
    the checkpoint — a rewritten narrative is a new narrative, and asking the user
    to approve the first one and not the second would be worse than not asking.
    """
    target = state.get("revision_target")
    if target == "revise_story":
        return STORY
    if target == "revise_layout":
        return LAYOUT
    if target == "revise_creative":
        return CREATIVE
    if target == "revise_motion":
        return MOTION
    return PROPOSE
