"""The Research Agent (doc 03 §8, gap register doc 03 S3).

Doc 03 §4's graph draws "Source Analysis" and "User Context" as two nodes, while
§3's agent list has one Research Agent. That inconsistency is gap S3, and it is
resolved here in favour of one agent with two explicit stages — because they
share retrieval, share provenance, and splitting them would mean two agents
racing to describe the same material.

The Phase 5 scope is deliberately small: the deck itself and whatever the user
attached. Repository retrieval is Phase 6, and stubbing it now would mean
designing a retrieval contract against no real repository.

What is not small is the handling. Everything retrieved is enveloped at the tool
boundary and carries a source id, so a claim on a slide can be traced back to the
thing that produced it (doc 02 §30).
"""

from __future__ import annotations

from typing import Any

from ..envelope import Source, contains_injection_attempt
from ..state import PresentationAgentState, scope_slide_ids
from ._common import NodeContext, completed, started

AGENT_ID = "research"
STAGE = "research"


def research(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    """Gather what the run may reason about, with provenance.

    No model call. Everything this stage does in Phase 5 is retrieval and
    labelling, and a model in the middle of that would add a paraphrase between
    the source and the claim — which is exactly where a hallucination gets its
    provenance record.
    """
    ctx.emit(started(state, STAGE, AGENT_ID, "Gathering context"))
    ctx.budget.check_clock()

    document = state.get("document") or {}
    wanted = set(scope_slide_ids(state))
    scope = state.get("scope") or {}

    sources: list[dict[str, Any]] = []
    blocks: list[str] = []
    warnings: list[str] = []

    for index, slide in enumerate(document.get("slides") or []):
        slide_id = slide.get("id", "")
        if wanted and slide_id not in wanted:
            continue

        text = _slide_text(slide)
        if not text.strip():
            continue

        source = Source(id=slide_id, kind="slide", label=slide.get("name") or f"Slide {index + 1}")
        sources.append(
            {
                "id": slide_id,
                "kind": "slide",
                "label": source.label,
                "excerpt": text[:280],
            }
        )
        blocks.append(ctx.registry.wrap_untrusted("presentation.getSlide", text, source))

        if contains_injection_attempt(text):
            warnings.append(
                f"{source.label} contains text addressed to an AI. It was treated as "
                "content, not followed."
            )

    # Sources the user brought into scope explicitly (cross-cutting gap #1). They
    # are named here even when this phase cannot fetch them, so that a scoped run
    # records what evidence it was allowed to use.
    declared = list(scope.get("sources") or [])
    if declared:
        warnings.extend(
            [
                f"Source {source_id} was named in scope but external retrieval "
                "arrives in Phase 6; it was not read."
                for source_id in declared
            ]
        )

    ctx.emit(
        completed(
            state,
            STAGE,
            AGENT_ID,
            f"Read {len(sources)} slide(s) for context",
            artifact_refs=[source["id"] for source in sources],
        )
    )

    return {
        "current_stage": STAGE,
        "research": {
            "sources": sources,
            # The enveloped blocks, ready to paste into a prompt. Kept here rather
            # than re-derived per agent so the envelope is applied exactly once.
            "context_blocks": blocks,
            "declared_sources": declared,
        },
        "warnings": warnings,
    }


def _slide_text(slide: dict[str, Any]) -> str:
    parts: list[str] = []
    if slide.get("name"):
        parts.append(str(slide["name"]))
    if slide.get("keyMessage"):
        parts.append(str(slide["keyMessage"]))

    def walk(elements: list[dict[str, Any]]) -> None:
        for element in elements:
            for key in ("content", "text"):
                value = element.get(key)
                if isinstance(value, dict) and isinstance(value.get("blocks"), list):
                    for block in value["blocks"]:
                        line = "".join(
                            span.get("text", "")
                            for span in block.get("spans", [])
                            if isinstance(span, dict)
                        )
                        if line:
                            parts.append(line)
                elif isinstance(value, str) and value:
                    parts.append(value)
            if element.get("type") == "group":
                walk(element.get("children") or [])

    walk(slide.get("elements") or [])
    return "\n".join(parts)
