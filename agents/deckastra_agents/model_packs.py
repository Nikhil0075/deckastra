"""Model packs — the local intelligence a user chose to install (D3).

A local model is optional and it is large. The desktop plan's constraint is that
it is **never a mandatory multi-GB install**: manual editing, MCP and cloud
generation all work without one. So "no pack installed" has to be an ordinary
state the product can describe, not an import error or a missing file discovered
halfway through a run someone is waiting on.

A pack is a directory holding weights and a `pack.json` that describes them:

    <root>/qwen3-4b-instruct-q4/
        pack.json
        model.gguf
        LICENSE.txt

Two things about that shape are deliberate:

- **The manifest is beside the weights, not in a registry.** A pack is installed
  by putting a directory somewhere and removed by deleting it, and nothing else
  has to be told. A registry file would be a second source of truth that a
  half-finished download leaves wrong.
- **The manifest must name a license.** Redistribution is a release gate (D6),
  and the fact we have to be able to show a user — and know before shipping — is
  which terms the weights came under. A pack that cannot say is refused, because
  the alternative is finding out at release that nobody recorded it. The *file*
  is optional; a user who assembles their own pack is not required to attach a
  copy, only to say what it is.

Nothing here loads a model. Discovery is cheap and runs wherever the product
needs to say what is available — the selection in `router`, a settings screen, a
benchmark harness — and none of those should pay for a multi-gigabyte mmap to
find out a directory exists.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

#: Where packs live. Deliberately *not* inside the desktop's `workspace`
#: directory: that one is user data and a backup copies it, while a pack is
#: redownloadable bytes that would multiply the size of every backup by ten.
MODEL_DIR_ENV = "DECKASTRA_MODEL_DIR"

MANIFEST = "pack.json"


@dataclass(frozen=True)
class ModelPack:
    """One installed model, as its manifest describes it."""

    id: str
    name: str
    directory: Path
    weights: Path
    #: What the model can hold. The planner's prompts are long, and a pack whose
    #: context cannot fit one is a pack that will fail on every real deck rather
    #: than occasionally.
    context_tokens: int
    quantization: str
    license: str
    #: Advisory, and worth showing before a download rather than after: a 7B at
    #: q4 on a machine with 8GB will swap, and "slow" is how that presents.
    min_ram_mb: int | None = None
    license_file: Path | None = None
    capabilities: tuple[str, ...] = ("text", "structured")
    vision_projector: Path | None = None
    chat_template: Path | None = None
    sha256: str | None = None


@dataclass(frozen=True)
class PackProblem:
    """A directory that looks like a pack and is not usable, and why.

    Surfaced rather than skipped. Someone who has just copied a model in and
    cannot find it in the product needs the reason; silence sends them to look at
    the download instead of at the typo.
    """

    directory: Path
    reason: str


def model_root() -> Path | None:
    """Where packs are installed, or None when nothing has said."""
    configured = os.environ.get(MODEL_DIR_ENV, "").strip()
    return Path(configured) if configured else None


def _load(directory: Path) -> ModelPack | PackProblem:
    manifest = directory / MANIFEST
    try:
        declared = json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return PackProblem(directory, f"There is no {MANIFEST} in this directory.")
    except (OSError, json.JSONDecodeError) as error:
        return PackProblem(directory, f"{MANIFEST} could not be read: {error}.")

    try:
        pack_id = str(declared["id"])
        weights = directory / str(declared["weights"])
        context_tokens = int(declared["context_tokens"])
        quantization = str(declared["quantization"])
        license_name = str(declared["license"]).strip()
    except (KeyError, TypeError, ValueError) as error:
        return PackProblem(directory, f"{MANIFEST} is missing something it needs: {error}.")

    if not license_name:
        return PackProblem(
            directory,
            "This pack does not say what license its weights came under, so the "
            "product cannot tell anyone what they are running.",
        )
    if not weights.is_file():
        return PackProblem(
            directory,
            f"{MANIFEST} names weights at {weights.name}, and that file is not here. "
            "An interrupted download looks exactly like this.",
        )

    def artifact(name: str) -> Path | None:
        value = declared.get(name)
        if not value:
            return None
        path = (directory / str(value)).resolve()
        if not path.is_relative_to(directory.resolve()) or not path.is_file():
            raise ValueError(f"{name} must name an existing file inside this pack.")
        return path
    try:
        if not weights.resolve().is_relative_to(directory.resolve()):
            raise ValueError("Weights must be inside the model pack.")
        projector, template = artifact("vision_projector"), artifact("chat_template")
        capabilities = tuple(declared.get("capabilities", ["text", "structured"]))
        if "vision" in capabilities and projector is None:
            raise ValueError("A vision pack must include a vision_projector.")
        if any(c not in {"text", "structured", "vision", "tools"} for c in capabilities):
            raise ValueError("Unknown model-pack capability.")
    except ValueError as error:
        return PackProblem(directory, str(error))

    license_file = declared.get("license_file")
    resolved_license_file = directory / str(license_file) if license_file else None
    if resolved_license_file is not None and not resolved_license_file.is_file():
        resolved_license_file = None

    return ModelPack(
        id=pack_id,
        name=str(declared.get("name") or pack_id),
        directory=directory,
        weights=weights,
        context_tokens=context_tokens,
        quantization=quantization,
        license=license_name,
        min_ram_mb=int(declared["min_ram_mb"]) if declared.get("min_ram_mb") else None,
        license_file=resolved_license_file,
        capabilities=capabilities, vision_projector=projector, chat_template=template,
        sha256=declared.get("sha256"),
    )


def scan(root: "Path | str | None" = None) -> tuple[list[ModelPack], list[PackProblem]]:
    """Every pack under `root`, and every directory that meant to be one.

    Sorted by id so two machines with the same packs choose the same default, and
    so a listing does not reorder itself between calls.
    """
    where = Path(root) if root is not None else model_root()
    if where is None or not where.is_dir():
        return [], []

    packs: list[ModelPack] = []
    problems: list[PackProblem] = []
    for directory in sorted(path for path in where.iterdir() if path.is_dir()):
        loaded = _load(directory)
        if isinstance(loaded, ModelPack):
            packs.append(loaded)
        else:
            problems.append(loaded)
    return packs, problems


def installed_packs(root: Path | None = None) -> list[ModelPack]:
    return scan(root)[0]


def selected_pack(root: Path | None = None) -> ModelPack | None:
    """The pack to use: the one named by `DECKASTRA_MODEL_PACK`, else the only one.

    Choosing silently between several would make which model answered a fact
    nobody recorded, and a benchmark comparing two packs needs to say which it
    measured. So with more than one installed and none named, this returns None
    and the caller refuses with a list.
    """
    packs = installed_packs(root)
    named = os.environ.get("DECKASTRA_MODEL_PACK", "").strip()
    if named:
        return next((pack for pack in packs if pack.id == named), None)
    return packs[0] if len(packs) == 1 else None
