"""The exported .pptx opens in a real PowerPoint reader.

Every other assertion about the package is made by the code that wrote it, which
means they all share the same misunderstanding if there is one. This one is made
by `python-pptx`, an independent implementation of the same specification: it
walks the relationship graph, resolves the master and layout, and reads the shape
tree. A package it refuses is a package PowerPoint refuses.

It is in the Python suite rather than the TypeScript one because that is where
the independent reader lives. The exporter is invoked through `tsx`, so this also
covers the thing no unit test can: that the package is written correctly to a
file rather than only correct in memory.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "packages/presentation-schema/fixtures/technical-deck.mydeck.json"

pptx = pytest.importorskip("pptx", reason="python-pptx is the independent reader this test needs")

if shutil.which("npx") is None:  # pragma: no cover - environment guard
    pytest.skip("npx is needed to run the exporter", allow_module_level=True)


EMIT = """
import { writeFileSync, readFileSync } from "node:fs";
import { buildDocumentScene } from "@deckastra/renderer";
import { fontManifest } from "@deckastra/export-core";
import { buildPptx } from "@deckastra/export-pptx";

const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const scene = buildDocumentScene(doc);
const scenes = new Map(scene.slides.map((s) => [s.slideId, s]));
const { bytes, result } = buildPptx({
  document: doc,
  scenes,
  fontManifest: fontManifest(scenes.values()),
  options: { includeNotes: true },
});
writeFileSync(process.argv[3], bytes);
process.stdout.write(JSON.stringify(result.report));
"""


@pytest.fixture(scope="module")
def exported(tmp_path_factory) -> tuple[Path, dict]:
    """Run the real exporter and hand back the file plus its report."""
    # Inside the workspace, because the package imports resolve through it.
    script = ROOT / "packages/export-pptx/.emit.mts"
    script.write_text(EMIT, encoding="utf-8")
    out = tmp_path_factory.mktemp("pptx") / "deck.pptx"

    try:
        finished = subprocess.run(
            ["npx", "tsx", str(script), str(FIXTURE), str(out)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=180,
            shell=sys.platform == "win32",
        )
    finally:
        script.unlink(missing_ok=True)

    if finished.returncode != 0:
        pytest.fail(f"the exporter failed:\n{finished.stderr[-2000:]}")

    return out, json.loads(finished.stdout.strip().splitlines()[-1])


def test_a_real_powerpoint_reader_opens_it(exported):
    from pptx import Presentation

    path, report = exported
    deck = Presentation(str(path))

    # python-pptx resolves the relationship graph on open, so getting this far
    # means every part a reader needs is present and reachable.
    assert len(deck.slides) == report["slideCount"]
    # 13.333in x 7.5in in EMU (doc 04 §33.1).
    assert (deck.slide_width, deck.slide_height) == (12_192_000, 6_858_000)


def test_the_text_arrives_editable_and_in_the_right_place(exported):
    """Doc 04 §33.4: editability is the point, not pixel parity."""
    from pptx import Presentation

    path, _ = exported
    deck = Presentation(str(path))
    first = deck.slides[0]

    texts = [shape.text_frame.text for shape in first.shapes if shape.has_text_frame]
    assert any("Agents propose" in text for text in texts)

    # Positioned in EMU derived from the document's own coordinates, so a
    # recipient sees the layout the author built rather than a reflow.
    boxes = [shape for shape in first.shapes if shape.has_text_frame]
    assert all(shape.left is not None and shape.top is not None for shape in boxes)
    assert all(0 <= shape.left < deck.slide_width for shape in boxes)


def test_shape_names_are_stable_and_derived_from_element_ids(exported):
    """Doc 04 §33.3: PowerPoint's Morph pairs by name."""
    from pptx import Presentation

    path, _ = exported
    deck = Presentation(str(path))

    names = [shape.name for slide in deck.slides for shape in slide.shapes]
    assert names, "the deck exported no shapes at all"
    assert all(name.startswith("deckastra-el_") for name in names)
    # A counter would renumber whenever a slide gains an element, and every
    # morph on the deck would silently stop pairing.
    assert len(set(names)) == len(names)


def test_speaker_notes_survive(exported):
    from pptx import Presentation

    path, _ = exported
    deck = Presentation(str(path))
    # The fixture carries none, so what matters is that asking for notes did not
    # produce a package the reader chokes on.
    assert all(slide.has_notes_slide is False for slide in deck.slides)
