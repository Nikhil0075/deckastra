"""The Research / Repository Agent (doc 03 §8, gap register doc 03 S3).

Doc 03 §4's graph draws "Source Analysis" and "User Context" as two nodes while
§3's agent list has one Research Agent. That inconsistency is gap S3, and it
resolves here in favour of one agent with two explicit stages — they share
retrieval, share provenance, and splitting them would mean two agents racing to
describe the same material.

The retrieval strategy is doc 03 §8's, and its first rule is the important one:
**do not send an entire repository to an LLM.** So the shape is

    profile → the model proposes questions → search each → cite the answers

The model chooses what to ask; deterministic code does the searching. That split
matters twice over: retrieval stays cheap and reproducible, and every claim that
reaches the Story Architect arrives attached to a file and a line range. A claim
without a citation is a claim the model invented, and this is the stage that
makes the difference visible.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..envelope import Source, contains_injection_attempt
from ..state import PresentationAgentState, scope_slide_ids
from ._common import NodeContext, ask_model, completed, started

AGENT_ID = "research"
STAGE = "research"

#: Enough to cover a deck, few enough to stay cheap. Each question costs one
#: embedding and one search; the answers are what the whole deck is built on.
MAX_QUESTIONS = 6
HITS_PER_QUESTION = 4

QUESTION_SYSTEM = """\
You are the Research Agent for a presentation about a codebase.

You are given a profile of the connected repositories: languages, frameworks,
entry points and the files that ranked most important. You do NOT have the code.

Your job is to decide what to look up. Write the questions whose answers a
presentation on this subject would need — the specific ones a search can answer,
not the ones only a person could.

Good: "how are database migrations applied", "what does the retry policy do",
"which service owns authentication".
Bad: "is the code good", "what should we improve", "summarise everything".

Ask about what the request is actually about. If the brief is about deployment,
do not ask about the test suite because the profile mentions one.

Return between two and six questions, ordered by how much the deck needs them.\
"""


class ResearchQuestions(BaseModel):
    questions: list[str] = Field(
        description="Two to six specific questions a code search could answer."
    )
    focus: str = Field(description="One sentence: what this deck is really about.")


def research(state: PresentationAgentState, ctx: NodeContext) -> dict[str, Any]:
    ctx.emit(started(state, STAGE, AGENT_ID, "Gathering context"))
    ctx.budget.check_clock()

    sources: list[dict[str, Any]] = []
    blocks: list[str] = []
    warnings: list[str] = []

    repository_context = _repository_stage(state, ctx, sources, blocks, warnings)
    _deck_stage(state, ctx, sources, blocks, warnings)

    ctx.emit(
        completed(
            state,
            STAGE,
            AGENT_ID,
            _summary(repository_context, sources),
            artifact_refs=[source["id"] for source in sources][:20],
        )
    )

    return {
        "current_stage": STAGE,
        "research": {
            "sources": sources,
            # Enveloped once, here, so every downstream agent reads the same
            # labelled blocks rather than re-wrapping raw text.
            "context_blocks": blocks,
            "repository": repository_context,
            "declared_sources": list((state.get("scope") or {}).get("sources") or []),
        },
        "warnings": warnings,
    }


def _summary(repository_context: dict[str, Any], sources: list[dict[str, Any]]) -> str:
    if repository_context.get("repositories"):
        names = ", ".join(repository_context["repositories"])
        return f"Read {len(sources)} source(s) from {names}"
    return f"Read {len(sources)} slide(s) for context"


# ----------------------------------------------------------- repository stage


def _repository_stage(
    state: PresentationAgentState,
    ctx: NodeContext,
    sources: list[dict[str, Any]],
    blocks: list[str],
    warnings: list[str],
) -> dict[str, Any]:
    """Ask the repository the questions this deck needs.

    Returns a `RepositoryContext` in doc 03 §8's sense: what the repository is,
    plus the findings that answer the brief, each one carrying its citation.
    """
    try:
        registry = ctx.registry.for_agent(
            AGENT_ID, ["repository.profile", "repository.search"]
        )
    except ValueError:
        # No repository tools registered: this run has no connected repository,
        # which is the ordinary case for a deck about an idea rather than a
        # codebase. Not an error, and not worth a warning.
        return {}

    try:
        profile = registry.call("repository.profile")
    except Exception as error:  # noqa: BLE001 - degrade with a stated fallback
        warnings.append(
            f"Could not read the repository profile ({error}). The deck was written "
            "without repository grounding."
        )
        return {}

    repositories = profile.get("repositories") or []
    if not repositories:
        return {}

    names = [repository.get("full_name", "") for repository in repositories]
    lexical = [
        repository.get("full_name", "")
        for repository in repositories
        if repository.get("chunk_count") and not repository.get("embedding_semantic")
    ]
    if lexical:
        # The user should know which kind of search produced their evidence.
        # A lexical index finds `psycopg`; it does not find "how do we connect
        # to the database" unless those words are in the file.
        warnings.append(
            f"{', '.join(lexical)} was indexed without a semantic embedding model, "
            "so search matches wording rather than meaning. Set VOYAGE_API_KEY for "
            "better grounding."
        )

    request = state.get("request") or {}
    plan = ask_model(
        ctx,
        stage=STAGE,
        task_type="fast",
        system=QUESTION_SYSTEM,
        user="\n\n".join(
            [
                "The brief:",
                _envelope(str(request.get("instruction", "")), Source(id="request", kind="user-brief")),
                "The repositories:",
                _describe_profile(repositories),
            ]
        ),
        model=ResearchQuestions,
        max_tokens=1_500,
    )

    findings: list[dict[str, Any]] = []
    seen_references: set[str] = set()

    for question in plan.questions[:MAX_QUESTIONS]:
        ctx.budget.check_clock()
        try:
            answer = registry.call(
                "repository.search", {"query": question, "limit": HITS_PER_QUESTION}
            )
        except Exception as error:  # noqa: BLE001 - one failed query is not a failed run
            warnings.append(f"Search for {question!r} failed: {error}")
            continue

        hits = answer.get("hits") or []
        if not hits:
            # Recorded, because "we looked and found nothing" is information the
            # Story Architect should have — it is the difference between omitting
            # a topic and inventing one.
            findings.append({"question": question, "hits": [], "note": "Nothing matched."})
            continue

        for hit in hits:
            reference = hit.get("reference", "")
            if reference in seen_references:
                continue
            seen_references.add(reference)

            source_id = f"{names[0]}#{reference}" if names else reference
            sources.append(
                {
                    "id": source_id,
                    "kind": "github",
                    "label": hit.get("path", ""),
                    "reference": reference,
                    "excerpt": (hit.get("content") or "")[:280],
                    "similarity": hit.get("similarity", 0),
                    "why_selected": hit.get("why_selected", ""),
                }
            )

            blocks.append(
                registry.untrusted(
                    "repository.search",
                    hit.get("content", ""),
                    Source(id=source_id, kind="github", label=reference),
                )
            )

            if contains_injection_attempt(hit.get("content", "")):
                warnings.append(
                    f"{hit.get('path', 'A file')} contains text addressed to an AI. "
                    "It was treated as content, not followed."
                )

        findings.append(
            {
                "question": question,
                "hits": [
                    {
                        "reference": hit.get("reference", ""),
                        "path": hit.get("path", ""),
                        "similarity": hit.get("similarity", 0),
                    }
                    for hit in hits
                ],
            }
        )

    return {
        "repositories": names,
        "focus": plan.focus,
        "languages": _merge_languages(repositories),
        "frameworks": sorted({f for r in repositories for f in (r.get("frameworks") or [])}),
        "entry_points": [e for r in repositories for e in (r.get("entry_points") or [])][:10],
        "important_files": [
            file for repository in repositories for file in (repository.get("important_files") or [])
        ][:20],
        "findings": findings,
        "semantic": all(repository.get("embedding_semantic") for repository in repositories),
    }


def _describe_profile(repositories: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for repository in repositories:
        languages = ", ".join(sorted((repository.get("languages") or {}), key=lambda k: -repository["languages"][k])[:6])
        lines.append(
            "\n".join(
                [
                    f"repository: {repository.get('full_name', '')}",
                    f"description: {repository.get('description', '') or '(none)'}",
                    f"languages: {languages or '(unknown)'}",
                    f"frameworks: {', '.join(repository.get('frameworks') or []) or '(none detected)'}",
                    f"entry_points: {', '.join(repository.get('entry_points') or []) or '(none found)'}",
                    "important files:",
                    *[
                        f"  - {file.get('path', '')} — {file.get('why', '')}"
                        for file in (repository.get("important_files") or [])[:12]
                    ],
                ]
            )
        )
    return "\n\n".join(lines)


def _merge_languages(repositories: list[dict[str, Any]]) -> dict[str, int]:
    merged: dict[str, int] = {}
    for repository in repositories:
        for language, count in (repository.get("languages") or {}).items():
            merged[language] = merged.get(language, 0) + count
    return merged


# ----------------------------------------------------------------- deck stage


def _deck_stage(
    state: PresentationAgentState,
    ctx: NodeContext,
    sources: list[dict[str, Any]],
    blocks: list[str],
    warnings: list[str],
) -> None:
    """What is already on the slides.

    No model call. This stage is retrieval and labelling, and a model in the
    middle of it would put a paraphrase between the source and the claim — which
    is exactly where a hallucination acquires a provenance record.
    """
    document = state.get("document") or {}
    wanted = set(scope_slide_ids(state))

    for index, slide in enumerate(document.get("slides") or []):
        slide_id = slide.get("id", "")
        if wanted and slide_id not in wanted:
            continue

        text = _slide_text(slide)
        if not text.strip():
            continue

        source = Source(id=slide_id, kind="slide", label=slide.get("name") or f"Slide {index + 1}")
        sources.append(
            {"id": slide_id, "kind": "slide", "label": source.label, "excerpt": text[:280]}
        )
        blocks.append(ctx.registry.wrap_untrusted("presentation.getSlide", text, source))

        if contains_injection_attempt(text):
            warnings.append(
                f"{source.label} contains text addressed to an AI. It was treated as "
                "content, not followed."
            )


def _envelope(text: str, source: Source) -> str:
    from ..envelope import envelope

    return envelope(text, source)


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
