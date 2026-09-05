"""Repository tools (doc 03 §8, §15).

Three tools, and the shape of them is the retrieval strategy doc 03 §8 asks for:
*do not send an entire repository to an LLM.*

    repository.profile   what this repository is — languages, frameworks, entry points
    repository.search    the chunks that answer a specific question
    repository.readFile  one file, when the search results are not enough

The agent asks a question and gets evidence with line ranges attached. It never
receives a tree of ten thousand paths, and it cannot ask for one.

Every result is untrusted content. A README is text a stranger wrote, and by the
time it reaches a prompt nothing distinguishes it from the operator's own words
except the envelope — which is applied here, at the boundary, rather than by each
agent (doc 05 §18).
"""

from __future__ import annotations

from typing import Any, Callable

from ..envelope import Source
from .registry import ToolDefinition, ToolRegistry

#: What the search tool returns per hit. Line ranges are mandatory: a citation a
#: reader cannot open is not a citation (doc 02 §30).
_HIT_SCHEMA = {
    "type": "object",
    "properties": {
        "path": {"type": "string"},
        "start_line": {"type": "integer"},
        "end_line": {"type": "integer"},
        "language": {"type": "string"},
        "content": {"type": "string"},
        "similarity": {"type": "number"},
        "reference": {"type": "string"},
        "why_selected": {"type": "string"},
    },
    "required": ["path", "start_line", "end_line", "content", "reference"],
}


def register_repository_tools(
    registry: ToolRegistry,
    *,
    profile: Callable[[], list[dict[str, Any]]],
    search: Callable[[str, int], list[dict[str, Any]]],
    read_file: Callable[[str, str], dict[str, Any]],
) -> None:
    """Wire the tools to a workspace's connected repositories.

    Callables rather than a database handle: doc 05 §17 says agent
    implementations should not know database details, and this is the seam where
    that stays true.
    """

    registry.register(
        ToolDefinition(
            id="repository.profile",
            description=(
                "What the connected repositories are: languages, frameworks, entry points "
                "and the most important files. Read this before searching — it tells you "
                "what questions are worth asking."
            ),
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            output_schema={
                "type": "object",
                "properties": {"repositories": {"type": "array"}},
                "required": ["repositories"],
            },
            required_permissions=["repository.read"],
            returns_untrusted_content=True,
        ),
        lambda payload: {"repositories": profile()},
    )

    registry.register(
        ToolDefinition(
            id="repository.search",
            description=(
                "Find the parts of the repository that answer a question. Ask in plain "
                "language, one question at a time. Every result carries the file and the "
                "line range it came from — cite those, and never a claim you cannot cite."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 3, "maxLength": 400},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 12},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            output_schema={
                "type": "object",
                "properties": {
                    "hits": {"type": "array", "items": _HIT_SCHEMA},
                    "query": {"type": "string"},
                },
                "required": ["hits", "query"],
            },
            required_permissions=["repository.read"],
            returns_untrusted_content=True,
        ),
        lambda payload: {
            "query": payload["query"],
            "hits": search(payload["query"], int(payload.get("limit", 6))),
        },
    )

    registry.register(
        ToolDefinition(
            id="repository.readFile",
            description=(
                "Read one indexed file in full. Use it only when the search results are "
                "not enough — a whole file is a lot of context for one claim."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "repository_id": {"type": "string"},
                    "path": {"type": "string", "minLength": 1},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            output_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "truncated": {"type": "boolean"},
                    "found": {"type": "boolean"},
                },
                "required": ["path", "content", "found"],
            },
            required_permissions=["repository.read"],
            returns_untrusted_content=True,
        ),
        lambda payload: read_file(payload.get("repository_id", ""), payload["path"]),
    )


def chunk_source(hit: dict[str, Any], repository: str = "") -> Source:
    """The provenance identity of a retrieved chunk.

    `repo#path:lines`, which is exactly the `sourceReference` form doc 02 §30
    specifies — so a record written from this can be turned back into a link.
    """
    reference = hit.get("reference", hit.get("path", ""))
    return Source(
        id=f"{repository}#{reference}" if repository else reference,
        kind="github",
        label=hit.get("path", ""),
    )
