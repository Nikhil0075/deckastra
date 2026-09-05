"""Which files matter, and how to cut them up (doc 05 §20 steps 5-7, doc 03 §8).

Two problems, both about attention.

**Ranking.** A repository has thousands of files and a deck cites a handful. The
ranking decides which ones get read, embedded and offered to an agent, and it has
to do that from the tree alone — before anything is fetched, because fetching is
the expensive part. Doc 03 §8 adds a requirement that shapes the design: *the
agent should be able to explain why a file was selected*. So a score is not a
number, it is a number with reasons attached.

**Chunking.** An embedding of a whole file is an average of everything in it and
matches nothing well. An embedding of three lines has no context. Chunks are
sized for the middle, split on structure where the language has any, and always
carry their line range — because a citation without a line range is a citation
nobody can check.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------- ranking

#: Files that describe the project rather than implement it. Weighted heavily
#: because they are what a human reads first, and what a deck is usually about.
DOCUMENT_NAMES = {
    "readme": 100,
    "architecture": 90,
    "design": 70,
    "contributing": 40,
    "changelog": 35,
    "roadmap": 40,
    "adr": 60,
    "rfc": 60,
    "docs": 30,
    "overview": 60,
}

#: Entry points. Finding these is how the pipeline answers "where does it start".
ENTRY_POINT_NAMES = {
    "main", "index", "app", "server", "cli", "__main__", "program", "startup", "bootstrap",
}

#: Manifests: what the project is built with, which is most of "frameworks".
MANIFEST_NAMES = {
    "package.json": 80,
    "pyproject.toml": 80,
    "setup.py": 60,
    "requirements.txt": 55,
    "go.mod": 80,
    "cargo.toml": 80,
    "pom.xml": 70,
    "build.gradle": 70,
    "gemfile": 70,
    "composer.json": 70,
    "dockerfile": 65,
    "docker-compose.yml": 65,
    "makefile": 50,
}

#: Extension → language. Used for the language mix and to pick a chunker.
LANGUAGE_BY_EXTENSION = {
    ".py": "Python", ".pyi": "Python",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".scala": "Scala",
    ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".swift": "Swift",
    ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
    ".sql": "SQL", ".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell",
    ".md": "Markdown", ".mdx": "Markdown", ".rst": "reStructuredText",
    ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".json": "JSON",
    ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte",
}

#: Manifest key → framework. Deliberately a lookup rather than a heuristic: a
#: guess about a framework is a wrong claim on a slide.
FRAMEWORK_MARKERS = {
    "react": "React", "next": "Next.js", "vue": "Vue", "svelte": "Svelte", "angular": "Angular",
    "express": "Express", "fastify": "Fastify", "nestjs": "NestJS",
    "django": "Django", "flask": "Flask", "fastapi": "FastAPI", "sqlalchemy": "SQLAlchemy",
    "alembic": "Alembic", "pydantic": "Pydantic", "langgraph": "LangGraph",
    "rails": "Rails", "spring": "Spring", "gin-gonic": "Gin", "actix": "Actix",
    "tailwindcss": "Tailwind", "prisma": "Prisma", "pytest": "pytest", "vitest": "Vitest",
}


@dataclass
class RankedFile:
    path: str
    score: float
    #: Why this file scored what it did, in words a user can read. Doc 03 §8
    #: requires the agent to explain its selection; this is where the explanation
    #: comes from.
    reasons: list[str] = field(default_factory=list)
    language: str = ""
    size_bytes: int = 0

    @property
    def why(self) -> str:
        return "; ".join(self.reasons) if self.reasons else "General source file."


def language_of(path: str) -> str:
    dot = path.rfind(".")
    return LANGUAGE_BY_EXTENSION.get(path[dot:].lower(), "") if dot > 0 else ""


def rank_file(path: str, size_bytes: int = 0) -> RankedFile:
    """Score one file from its path.

    Path-only on purpose: the ranking runs over the whole tree, and reading every
    file to decide whether to read it is the thing this exists to avoid.
    """
    normalised = path.replace("\\", "/")
    segments = normalised.split("/")
    name = segments[-1].lower()
    stem = name.rsplit(".", 1)[0] if "." in name else name
    depth = len(segments) - 1

    ranked = RankedFile(path=path, score=10.0, language=language_of(name), size_bytes=size_bytes)

    if name in MANIFEST_NAMES:
        ranked.score += MANIFEST_NAMES[name]
        ranked.reasons.append("Project manifest")

    for keyword, weight in DOCUMENT_NAMES.items():
        if keyword in stem:
            ranked.score += weight
            ranked.reasons.append(f"Documentation ({keyword})")
            break

    if stem in ENTRY_POINT_NAMES and ranked.language:
        ranked.score += 55
        ranked.reasons.append("Looks like an entry point")

    if "docs/" in normalised or normalised.startswith("doc/"):
        ranked.score += 25
        ranked.reasons.append("In the docs directory")

    # Shallow files are the ones a reader meets first, and usually the ones that
    # organise everything below them.
    ranked.score += max(0, 30 - depth * 8)
    if depth == 0:
        ranked.reasons.append("At the repository root")

    is_test = (
        "/test" in normalised
        or normalised.startswith("test")
        or name.startswith("test_")
        or name.endswith(("_test.py", "_test.go", "_spec.rb"))
        # The dotted convention — `store.test.ts`, `store.spec.ts` — which a
        # `/test` directory check misses entirely.
        or ".test." in name
        or ".spec." in name
        or "spec" in name
    )
    if is_test:
        # Not excluded — tests document intent, and a deck about a codebase often
        # wants them — but they should not outrank the thing they test.
        ranked.score -= 25
        ranked.reasons.append("Test file")

    if "/migrations/" in normalised or "/generated/" in normalised:
        ranked.score -= 30
        ranked.reasons.append("Generated or migration code")

    if ranked.language in {"Markdown", "reStructuredText"}:
        ranked.score += 20
        ranked.reasons.append("Prose")

    # A very large source file is usually a grab bag, and its embedding is an
    # average of too many things.
    if size_bytes > 80_000:
        ranked.score -= 15
        ranked.reasons.append("Unusually large")

    return ranked


def rank_tree(entries: list[tuple[str, int]], limit: int | None = None) -> list[RankedFile]:
    """Rank a whole tree, highest first, ties broken by path for determinism."""
    ranked = [rank_file(path, size) for path, size in entries]
    ranked.sort(key=lambda file: (-file.score, file.path))
    return ranked[:limit] if limit else ranked


def detect_frameworks(manifests: dict[str, str]) -> list[str]:
    """Frameworks, from manifest contents.

    A lookup against declared dependencies rather than a guess from imports: a
    framework named on a slide is a claim, and "it imports something called
    `react`" is not the same claim as "it is a React project".
    """
    found: set[str] = set()

    for content in manifests.values():
        lowered = content.lower()
        for marker, framework in FRAMEWORK_MARKERS.items():
            # A whole token, not a substring: `react` must not match
            # `preact-compat`, and `fastapi>=0.115` must match. `-` is excluded
            # from the boundary on both sides so a hyphenated package name reads
            # as one token rather than two.
            if re.search(rf"(?<![\w-]){re.escape(marker)}(?![\w-])", lowered):
                found.add(framework)

    return sorted(found)


# -------------------------------------------------------------------- chunking

#: Characters. Roughly 250 tokens — long enough to carry a function with its
#: signature, short enough that an embedding still means something specific.
TARGET_CHUNK_CHARS = 1_100
#: Overlap so a definition split across a boundary is retrievable from either side.
CHUNK_OVERLAP_LINES = 3
MIN_CHUNK_CHARS = 80

#: Lines that start a new top-level thing, per language family. A structural split
#: beats a fixed-size one: a chunk that starts mid-function retrieves badly and
#: reads worse when it is quoted back as evidence.
_BOUNDARY = re.compile(
    r"^(?:"
    r"\s{0,3}#{1,3}\s"                       # markdown heading
    r"|(?:export\s+)?(?:async\s+)?function\s"
    r"|(?:export\s+)?(?:abstract\s+)?class\s"
    r"|(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\("
    r"|(?:export\s+)?interface\s|(?:export\s+)?type\s+\w+\s*="
    r"|def\s|async\s+def\s|class\s"
    r"|func\s|impl\s|pub\s+fn\s|fn\s"
    r"|(?:public|private|protected)\s+.*\("
    r")"
)


@dataclass(frozen=True)
class Chunk:
    path: str
    text: str
    #: 1-based and inclusive, matching how an editor and a GitHub link count.
    start_line: int
    end_line: int
    language: str = ""

    @property
    def reference(self) -> str:
        """`path:start-end` — the form a provenance record carries (doc 02 §30)."""
        return f"{self.path}:{self.start_line}-{self.end_line}"


def chunk_text(path: str, text: str, *, target_chars: int = TARGET_CHUNK_CHARS) -> list[Chunk]:
    """Split a file into retrievable pieces.

    Greedy accumulation with a preference for structural boundaries: lines are
    added until the chunk is big enough, and then it is closed at the next
    boundary rather than mid-definition — unless waiting for one would make the
    chunk far too large, in which case size wins.
    """
    language = language_of(path)
    lines = text.splitlines()
    if not lines:
        return []

    chunks: list[Chunk] = []
    start = 0
    size = 0

    for index, line in enumerate(lines):
        size += len(line) + 1
        at_boundary = index > start and bool(_BOUNDARY.match(line))

        # Close on a boundary once big enough, or on size alone once well past it.
        if (size >= target_chars and at_boundary) or size >= target_chars * 2:
            end = index if at_boundary else index + 1
            chunks.append(_make(path, lines, start, end, language))
            start = max(start, end - CHUNK_OVERLAP_LINES) if at_boundary else end
            size = sum(len(lines[i]) + 1 for i in range(start, end)) if at_boundary else 0

    if start < len(lines):
        chunks.append(_make(path, lines, start, len(lines), language))

    return [chunk for chunk in chunks if len(chunk.text.strip()) >= MIN_CHUNK_CHARS]


def _make(path: str, lines: list[str], start: int, end: int, language: str) -> Chunk:
    return Chunk(
        path=path,
        text="\n".join(lines[start:end]),
        start_line=start + 1,
        end_line=end,
        language=language,
    )
