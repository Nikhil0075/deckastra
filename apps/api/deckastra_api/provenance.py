"""Writing provenance into the document (doc 02 §30).

The exit criterion for this phase is "click any slide and see its sources". This
is where that becomes possible: the Story Architect cites source ids per slide,
the composer produces elements, and this ties the two together as
`ProvenanceRecord`s on the document.

Three decisions worth stating.

**It lives in the document, not a side table.** Doc 02 §30 is explicit, and the
reasons are practical: a user can click a claim and see which file produced it,
that has to survive export and duplication, and when a repository changes the
system needs to identify which slides depended on the changed files.

**The reference is `repo#path:lines`.** Not a file name, not a URL — the exact
form doc 02 §30 specifies, because a citation a reader cannot open is not a
citation. `path:12-48` turns into a GitHub link mechanically.

**An excerpt may be private.** Provenance inherits the document's access controls
and exports strip it by default, so the excerpt is short and the hash is there
for anyone who needs to check a claim without reading the code.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from .ids import new_id

#: Long enough to recognise the claim, short enough that provenance does not
#: become a second copy of the repository inside the deck.
EXCERPT_CHARS = 400


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def _source_type(source: dict[str, Any]) -> str:
    kind = source.get("kind", "")
    if kind in {"github", "web", "file", "user", "model", "mcp"}:
        return kind
    if kind == "slide":
        # Something already in the deck. "user" is the honest classification —
        # whoever put it there is the source, and claiming "model" would assert
        # something we do not know.
        return "user"
    return "user"


def records_for_document(
    document: dict[str, Any],
    story_plan: dict[str, Any],
    sources: list[dict[str, Any]],
    *,
    agent_id: str = "research",
) -> list[dict[str, Any]]:
    """Provenance for a composed deck.

    Attached to the *headline* of each slide rather than to the slide, because
    doc 02 §30 targets an element and the headline is what carries the claim. A
    user clicking a slide sees its records through the element it belongs to.

    A slide that cites nothing gets nothing. An empty provenance record asserting
    a source that does not exist would be worse than the absence — the absence is
    itself information: this slide is not grounded in anything.
    """
    by_id = {source.get("id", ""): source for source in sources}
    slides = story_plan.get("slides") or []
    records: list[dict[str, Any]] = []

    for index, slide_plan in enumerate(slides):
        cited = [source_id for source_id in (slide_plan.get("source_ids") or []) if source_id in by_id]
        if not cited:
            continue

        slide = (document.get("slides") or [])[index] if index < len(document.get("slides") or []) else None
        if slide is None:
            continue

        target = _claim_element(slide)
        if target is None:
            continue

        for source_id in cited:
            source = by_id[source_id]
            excerpt = (source.get("excerpt") or "")[:EXCERPT_CHARS]

            records.append(
                {
                    "id": new_id("prv"),
                    "targetId": target,
                    "sourceType": _source_type(source),
                    # `repo#path:lines` — see the module docstring.
                    "sourceReference": source.get("id", source_id),
                    **({"excerpt": excerpt} if excerpt else {}),
                    **({"excerptHash": _hash(excerpt)} if excerpt else {}),
                    **(
                        {"confidence": round(float(source["similarity"]), 2)}
                        if isinstance(source.get("similarity"), (int, float))
                        else {}
                    ),
                    "agentId": agent_id,
                    "createdAt": _now(),
                }
            )

    return records


def _claim_element(slide: dict[str, Any]) -> str | None:
    """The element a slide's claim belongs to.

    The headline, or the first text element. Falling back to the slide id would
    produce a record whose `targetId` names something the schema expects to be an
    element, and the editor would have nothing to attach it to.
    """
    elements = slide.get("elements") or []

    for element in elements:
        if element.get("semanticRole") == "headline":
            return element.get("id")

    for element in elements:
        if element.get("type") == "text":
            return element.get("id")

    return elements[0].get("id") if elements else None


def attach(document: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    """Add records to a document, replacing any for the same targets.

    Replacing rather than appending: a regenerated slide's old citations describe
    text that is no longer there, and keeping them would let a deck cite a source
    for a claim it no longer makes.
    """
    if not records:
        return document

    targets = {record["targetId"] for record in records}
    existing = [
        record for record in (document.get("provenance") or []) if record.get("targetId") not in targets
    ]

    return {**document, "provenance": [*existing, *records]}


def for_target(document: dict[str, Any], target_id: str) -> list[dict[str, Any]]:
    """Every record for one element — what the sources panel shows."""
    return [
        record
        for record in (document.get("provenance") or [])
        if record.get("targetId") == target_id
    ]


def for_slide(document: dict[str, Any], slide_id: str) -> list[dict[str, Any]]:
    """Every record for anything on a slide.

    The slide-level view: a user clicks a slide, not an element id.
    """
    slide = next(
        (candidate for candidate in (document.get("slides") or []) if candidate.get("id") == slide_id),
        None,
    )
    if slide is None:
        return []

    ids: set[str] = set()

    def walk(elements: list[dict[str, Any]]) -> None:
        for element in elements:
            ids.add(element.get("id", ""))
            if element.get("type") == "group":
                walk(element.get("children") or [])

    walk(slide.get("elements") or [])

    return [
        record
        for record in (document.get("provenance") or [])
        if record.get("targetId") in ids
    ]


def to_link(reference: str, *, default_branch: str = "main") -> str | None:
    """Turn `owner/repo#path:12-48` into a GitHub URL.

    The whole reason the reference format is specified. A citation the user
    cannot open is a citation they have to take on trust, which is the opposite
    of what provenance is for.
    """
    if "#" not in reference:
        return None

    repository, _, rest = reference.partition("#")
    if "/" not in repository:
        return None

    path, _, lines = rest.partition(":")
    if not path:
        return None

    url = f"https://github.com/{repository}/blob/{default_branch}/{path}"

    if lines:
        start, _, end = lines.partition("-")
        if start.isdigit():
            url += f"#L{start}" + (f"-L{end}" if end.isdigit() else "")

    return url
