"""What not to index (doc 05 §20).

The ignore list is the first real decision in the pipeline and the one with the
largest effect on everything after it. A repository is mostly not source: it is
lockfiles, vendored dependencies, build output, minified bundles and images. Index
those and the retrieval returns `node_modules/.../index.min.js` for every query,
the embedding budget goes on machine-generated text, and the deck cites a file
nobody wrote.

Three rules, in the order they are applied, because each is cheaper than the next:

1. **Path patterns** — a directory nobody wants indexed, decided without reading.
2. **Extension** — a binary or a lockfile, decided without reading.
3. **Content** — a file that turned out to be minified or generated, which can
   only be decided after reading it.

Nothing here executes anything. Doc 05 §20 is explicit that repository code is
never run during indexing, and this module is why that is easy to keep true: the
pipeline only ever reads bytes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Directory names that are never source, wherever they appear.
IGNORED_DIRECTORIES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "bower_components",
        "vendor",
        "third_party",
        "venv",
        ".venv",
        "env",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tox",
        "dist",
        "build",
        "out",
        "target",
        "bin",
        "obj",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".cache",
        "coverage",
        ".nyc_output",
        ".gradle",
        ".idea",
        ".vscode",
        ".terraform",
        "Pods",
        "DerivedData",
    }
)

#: Extensions that carry no readable text worth indexing.
BINARY_EXTENSIONS = frozenset(
    {
        # images and media
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".avif",
        ".mp4", ".mov", ".avi", ".webm", ".mkv", ".mp3", ".wav", ".flac", ".ogg",
        # documents and archives
        ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
        # compiled artefacts
        ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".class", ".pyc", ".pyo",
        ".wasm", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
        # fonts and design
        ".woff", ".woff2", ".ttf", ".otf", ".eot", ".psd", ".ai", ".sketch", ".fig",
        # models and notebooks output
        ".pt", ".pth", ".onnx", ".h5", ".pkl", ".npy", ".npz",
    }
)

#: Files that are real text but say nothing a human wrote.
GENERATED_FILENAMES = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "poetry.lock",
        "Pipfile.lock",
        "Gemfile.lock",
        "composer.lock",
        "Cargo.lock",
        "go.sum",
        "mix.lock",
        "flake.lock",
    }
)

#: Filenames that suggest a secret. Never indexed, and their *absence* from the
#: index is the point: an embedding of a private key is a private key in a
#: database, and a retrieved chunk of one ends up in a prompt.
SECRET_PATTERNS = (
    re.compile(r"(^|/)\.env(\.|$)"),
    re.compile(r"(^|/)\.npmrc$"),
    re.compile(r"(^|/)\.netrc$"),
    re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)$"),
    re.compile(r"\.(pem|key|p12|pfx|keystore|jks)$"),
    re.compile(r"(^|/)credentials(\.json|\.yaml|\.yml)?$"),
    re.compile(r"(^|/)secrets?\.(json|ya?ml|toml|env)$"),
    re.compile(r"(^|/)service-account.*\.json$"),
)

#: A file this large is not being read by a person either. 512KB is generous for
#: hand-written source and cheap to enforce before any content arrives.
MAX_FILE_BYTES = 512 * 1024

#: A repository past this many indexable files is truncated by importance rather
#: than refused, because a partial index of a large repository is still useful and
#: a refusal is not (doc 05 §20's quota, made concrete).
MAX_INDEXED_FILES = 1_200


@dataclass(frozen=True)
class Decision:
    indexed: bool
    #: Why, in the words the UI shows. "ignored" alone tells a user nothing.
    reason: str = ""


def _segments(path: str) -> list[str]:
    return [segment for segment in path.replace("\\", "/").split("/") if segment]


def extension_of(path: str) -> str:
    name = _segments(path)[-1] if _segments(path) else path
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


def looks_like_secret(path: str) -> bool:
    normalised = path.replace("\\", "/")
    return any(pattern.search(normalised) for pattern in SECRET_PATTERNS)


def should_index_path(path: str, size_bytes: int | None = None) -> Decision:
    """Decide from the path alone, before anything is read.

    Cheap on purpose: a repository has tens of thousands of paths and a few
    hundred worth reading, and deciding by path first is what keeps the fetch
    count proportional to the second number.
    """
    segments = _segments(path)
    if not segments:
        return Decision(False, "Empty path.")

    for segment in segments[:-1]:
        if segment in IGNORED_DIRECTORIES:
            return Decision(False, f"Inside {segment}/, which is not source.")

    name = segments[-1]

    if looks_like_secret(path):
        # Never indexed, and the reason is stated so a user is not left wondering
        # why their config file is missing.
        return Decision(False, "Looks like it holds a secret.")

    if name in GENERATED_FILENAMES:
        return Decision(False, "Generated lockfile.")

    extension = extension_of(name)
    if extension in BINARY_EXTENSIONS:
        return Decision(False, f"{extension} files carry no indexable text.")

    if ".min." in name or name.endswith(".map"):
        return Decision(False, "Minified or a source map.")

    if size_bytes is not None and size_bytes > MAX_FILE_BYTES:
        return Decision(False, f"{size_bytes // 1024}KB is larger than the {MAX_FILE_BYTES // 1024}KB limit.")

    return Decision(True)


def should_index_content(text: str) -> Decision:
    """Decide from the content, for what the path could not rule out.

    Two cases the path misses: a generated file that does not say so in its name,
    and a "text" file that is actually one enormous line — a bundle, a data blob,
    a base64 payload. Both are real text and neither is worth an embedding.
    """
    if not text.strip():
        return Decision(False, "Empty.")

    head = text[:2_000].lower()
    if "do not edit" in head and ("generated" in head or "auto" in head):
        return Decision(False, "Says it is generated and should not be edited.")

    lines = text.count("\n") + 1
    if lines < 5 and len(text) > 4_000:
        # 4KB across four lines is a bundle or a blob, not something a person
        # wrote and not something a reader would ever open.
        return Decision(False, "One very long line; looks generated.")

    # A high proportion of non-printable bytes means the extension lied.
    printable = sum(1 for char in text[:4_000] if char.isprintable() or char in "\n\r\t")
    if printable / max(1, min(len(text), 4_000)) < 0.85:
        return Decision(False, "Mostly non-text bytes.")

    return Decision(True)
