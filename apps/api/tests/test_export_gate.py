"""The image-led export gate, read back by readers that are not us (item 8, 2026-10-14).

One deck carries every image-led capability at once (`export_gate_deck.py`):
layers whose depth and reading order disagree, a transparent cut-out, masked
and treated pictures, picture-filled text, a bubble map, a scatter, an
isometric diagram, Hindi and Arabic. It goes through the real exporter CLI
(`apps/worker/src/cli.ts`), the path an export job takes, to PDF and to
PowerPoint. `pypdf` and `python-pptx` then read the files. They are
independent implementations of the formats, so a file they read is a file a
PDF viewer and PowerPoint read.

What each check is for is listed in `docs/design-audit/EXPORT_A11Y_GATE.md`,
which `test_gate_map_names_real_tests` holds to this file.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_gate_deck as gate  # noqa: E402

ROOT = gate.ROOT
CLI = ROOT / "apps/worker/src/cli.ts"
GATE_MAP = ROOT / "docs/design-audit/EXPORT_A11Y_GATE.md"

pptx = pytest.importorskip("pptx", reason="python-pptx is the independent reader this test needs")
pypdf = pytest.importorskip("pypdf", reason="pypdf is the independent reader this test needs")
Image = pytest.importorskip("PIL.Image", reason="Pillow reads the embedded pictures back")

needs_exporter = pytest.mark.skipif(shutil.which("npx") is None, reason="npx is needed to run the exporter")

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
DECORATIVE = "http://schemas.microsoft.com/office/drawing/2017/decorative"


def _export(tmp: Path, kind: str) -> tuple[Path, dict]:
    (tmp / "deck.json").write_text(json.dumps(gate.deck()), encoding="utf-8")
    (tmp / "assets.json").write_text(json.dumps(gate.assets()), encoding="utf-8")
    output = tmp / f"gate.{kind}"
    invocation = {
        "kind": kind,
        "output": str(output),
        "documentPath": str(tmp / "deck.json"),
        "assetsPath": str(tmp / "assets.json"),
        "options": {},
    }
    finished = subprocess.run(
        ["npx", "tsx", str(CLI)],
        input=json.dumps(invocation),
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=300,
        shell=sys.platform == "win32",  # npx is a .cmd on Windows; a list with shell=True on Linux runs only "npx"
    )
    lines = finished.stdout.strip().splitlines()
    assert lines, f"the exporter printed nothing: {finished.stderr[-2000:]}"
    answer = json.loads(lines[-1])
    assert answer.get("ok"), answer
    return output, answer["report"]


@pytest.fixture(scope="module")
def exported(tmp_path_factory) -> dict:
    tmp = tmp_path_factory.mktemp("gate")
    pdf, pdf_report = _export(tmp, "pdf")
    deck, pptx_report = _export(tmp, "pptx")
    return {"pdf": pdf, "pdf_report": pdf_report, "pptx": deck, "pptx_report": pptx_report}


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


# ----------------------------------------------------------------- the PDF


def _tags(reader, page_index: int) -> tuple[list[str], list[str]]:
    """The words of one page in its tag tree's order, and every figure's description.

    The content stream is in paint order; the tag tree is what a screen reader
    follows, so reading order is a claim about the tree.
    """
    from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NumberObject

    page = reader.pages[page_index]
    page_ref = page.indirect_reference.idnum
    texts: dict[int, str] = {}
    current: list[int | None] = [None]

    def before(operator, args, *_):
        if operator == b"BDC" and len(args) > 1 and isinstance(args[1], DictionaryObject) and "/MCID" in args[1]:
            current[0] = int(args[1]["/MCID"])
        elif operator == b"EMC":
            current[0] = None

    def text(value, *_):
        if current[0] is not None and value:
            texts[current[0]] = texts.get(current[0], "") + value

    page.extract_text(visitor_operand_before=before, visitor_text=text)

    order: list[int] = []
    figures: list[str] = []

    def walk(node, owner=None):
        node = node.get_object() if isinstance(node, IndirectObject) else node
        if isinstance(node, (int, NumberObject)):
            if owner == page_ref:
                order.append(int(node))
        elif isinstance(node, ArrayObject):
            for kid in node:
                walk(kid, owner)
        elif isinstance(node, DictionaryObject):
            if "/Pg" in node:
                owner = node.raw_get("/Pg").idnum
            if node.get("/Type") == "/MCR":
                if owner == page_ref:
                    order.append(int(node["/MCID"]))
                return
            if "/Alt" in node and owner in (None, page_ref):
                figures.append(str(node["/Alt"]))
            if "/K" in node:
                walk(node["/K"], owner)

    walk(reader.trailer["/Root"]["/StructTreeRoot"])
    return [texts[m].strip() for m in order if texts.get(m, "").strip()], figures


@needs_exporter
@pytest.mark.slow
def test_pdf_pages_text_and_scripts(exported):
    reader = pypdf.PdfReader(exported["pdf"])
    assert len(reader.pages) == 5
    for page in reader.pages:
        assert (round(float(page.mediabox.width)), round(float(page.mediabox.height))) == (1440, 810)
    text = "".join(page.extract_text() for page in reader.pages)
    for words in (gate.HEADLINE, gate.NOTE, gate.FILLED):
        assert _squash(words) in _squash(text), words
    # Hindi comes back whole; Arabic word by word, because a PDF stores it in
    # visual order and the extractor reads it left to right.
    assert _squash(gate.HINDI).replace(",", "") in _squash(text).replace(",", "")
    for word in gate.ARABIC.split():
        assert word in text, word
    assert exported["pdf_report"]["metricsEstimated"] is False


@needs_exporter
@pytest.mark.slow
def test_pdf_reads_in_story_order_not_depth(exported):
    reader = pypdf.PdfReader(exported["pdf"])
    painted = reader.pages[0].extract_text()
    # The caption is painted under the headline, so a reader of the content
    # stream meets it first. That is the depth this deck is built to have.
    assert painted.index(gate.NOTE) < painted.index(gate.HEADLINE)
    words, _ = _tags(reader, 0)
    said = [w for w in words if w in (gate.HEADLINE, gate.NOTE)]
    assert said == [gate.HEADLINE, gate.NOTE]


@needs_exporter
@pytest.mark.slow
def test_pdf_keeps_every_description(exported):
    reader = pypdf.PdfReader(exported["pdf"])
    figures = [figure for index in range(len(reader.pages)) for figure in _tags(reader, index)[1]]
    expected = [
        gate.ALT["subject"], gate.ALT["scene"], gate.ALT["diamond"], gate.ALT["ridge"], gate.ALT["mistyped"],
        "Revenue by city: London 42, Tokyo 47, Lagos 18",
        "Size against growth for four teams",
        "The web app calls the API, which writes to the database.",
    ]
    assert sorted(set(figures)) == sorted(expected)
    # Once each: a picture named twice is announced twice.
    assert len(figures) == len(set(figures))
    # The decoration has no figure: it is announced as nothing.
    assert "Yellow ring" not in figures


# ----------------------------------------------------------- the PowerPoint


def _shape(slide, element: int):
    name = f"deckastra-{gate._id('el', element)}"
    for shape in slide.shapes:
        if shape.name == name:
            return shape
    raise AssertionError(f"no shape named {name}")


def _descr(shape) -> str | None:
    return shape._element.find(".//p:cNvPr", NS).get("descr")


def _warnings(report: dict, feature: str) -> list[dict]:
    return [w for w in report["warnings"] if w["feature"] == feature]


@needs_exporter
@pytest.mark.slow
def test_pptx_reopens_with_its_slides(exported):
    deck = pptx.Presentation(str(exported["pptx"]))
    assert len(deck.slides) == 5
    assert (deck.slide_width, deck.slide_height) == (12192000, 6858000)


@needs_exporter
@pytest.mark.slow
def test_pptx_cut_out_keeps_its_transparency_and_alt(exported):
    slide = pptx.Presentation(str(exported["pptx"])).slides[0]
    cutout = _shape(slide, 3)
    assert cutout.image.content_type == "image/png"
    picture = Image.open(io.BytesIO(cutout.image.blob))
    assert picture.mode in ("RGBA", "LA") or "transparency" in picture.info
    assert picture.convert("RGBA").getpixel((0, 0))[3] == 0, "the cut-out's background is no longer clear"
    assert _descr(cutout) == gate.ALT["subject"]
    assert _descr(_shape(slide, 1)) == gate.ALT["scene"]


@needs_exporter
@pytest.mark.slow
def test_pptx_marks_decoration_and_says_how_it_reads(exported):
    slide = pptx.Presentation(str(exported["pptx"])).slides[0]
    ring = _shape(slide, 2)
    assert ring._element.find(f".//{{{DECORATIVE}}}decorative") is not None
    for element in (1, 3, 4, 5):
        assert _shape(slide, element)._element.find(f".//{{{DECORATIVE}}}decorative") is None
    # PowerPoint reads in layer order, and this slide's layers are not its
    # story: the headline is read first and layered last, and the note names it.
    notes = [w for w in _warnings(exported["pptx_report"], "reading order") if w["slideId"] == gate._id("sld", 1)]
    assert [w["elementId"] for w in notes] == [gate._id("el", 4)]


@needs_exporter
@pytest.mark.slow
def test_pptx_masks_crop_natively_or_capture_with_alt(exported):
    slide = pptx.Presentation(str(exported["pptx"])).slides[1]
    arch = _shape(slide, 14)
    geometry = arch._element.find(".//a:custGeom", NS)
    assert geometry is not None, "an arch with no treatment is a native crop"
    path = geometry.find(".//a:path", NS)
    assert int(path.get("w")) > 0 and int(path.get("h")) > 0
    assert len(path) > 3
    assert _descr(arch) == gate.ALT["ridge"]

    treated = _shape(slide, 6)
    assert treated.image.content_type == "image/png"
    assert _descr(treated) == gate.ALT["diamond"]
    report = exported["pptx_report"]
    assert any(w["elementId"] == gate._id("el", 6) for w in _warnings(report, "image treatment"))
    assert any(w["elementId"] == gate._id("el", 6) and w["action"] == "dropped" for w in _warnings(report, "blendMode"))


@needs_exporter
@pytest.mark.slow
def test_pptx_picture_filled_text_is_still_text(exported):
    slide = pptx.Presentation(str(exported["pptx"])).slides[1]
    words = _shape(slide, 7)
    assert words.has_text_frame and words.text_frame.text == gate.FILLED
    run = words._element.find(".//a:r/a:rPr", NS)
    assert run.find("a:blipFill", NS) is not None, "the picture should fill the letters"


@needs_exporter
@pytest.mark.slow
def test_pptx_stores_a_mistyped_picture_as_what_it_is(exported):
    with zipfile.ZipFile(exported["pptx"]) as archive:
        media = [name for name in archive.namelist() if name.startswith("ppt/media/")]
    assert media and all(name.endswith(".png") for name in media), media
    badge = _shape(pptx.Presentation(str(exported["pptx"])).slides[1], 8)
    assert badge.image.content_type == "image/png"
    assert Image.open(io.BytesIO(badge.image.blob)).convert("RGBA").getpixel((0, 0))[3] == 0
    retyped = _warnings(exported["pptx_report"], "image type")
    assert [w["elementId"] for w in retyped] == [gate._id("el", 8)]


@needs_exporter
@pytest.mark.slow
def test_pptx_charts_and_diagrams_carry_their_descriptions(exported):
    deck = pptx.Presentation(str(exported["pptx"]))
    assert _descr(_shape(deck.slides[2], 9)) == "Revenue by city: London 42, Tokyo 47, Lagos 18"
    assert _descr(_shape(deck.slides[2], 10)) == "Size against growth for four teams"
    assert _descr(_shape(deck.slides[3], 11)) == "The web app calls the API, which writes to the database."
    labels = " ".join(shape.text_frame.text for shape in _shape(deck.slides[2], 9).shapes if shape.has_text_frame)
    for city in ("London", "Tokyo", "Lagos"):
        assert city in labels


@needs_exporter
@pytest.mark.slow
def test_pptx_hindi_and_arabic(exported):
    slide = pptx.Presentation(str(exported["pptx"])).slides[4]
    hindi, arabic = _shape(slide, 12), _shape(slide, 13)
    assert hindi.text_frame.text == gate.HINDI
    assert arabic.text_frame.text == gate.ARABIC
    assert hindi._element.find(".//a:cs", NS).get("typeface") == "Noto Sans Devanagari"
    assert arabic._element.find(".//a:cs", NS).get("typeface") == "Noto Sans Arabic"
    # An Arabic paragraph has to start at the right-hand edge.
    assert arabic._element.find(".//a:pPr", NS).get("rtl") == "1"
    assert hindi._element.find(".//a:pPr", NS).get("rtl") is None


@needs_exporter
@pytest.mark.slow
def test_pptx_text_takes_the_theme_colour(exported):
    theme = gate.deck()["theme"]["colors"]["foreground"]
    slide = pptx.Presentation(str(exported["pptx"])).slides[0]
    colour = _shape(slide, 4)._element.find(".//a:rPr/a:solidFill/a:srgbClr", NS).get("val")
    assert colour.upper() == theme.lstrip("#").upper()[:6]


# ------------------------------------------------------------ the gate map


def test_gate_map_names_real_tests():
    """Every test the gate document cites exists, so the map cannot rot quietly."""
    text = GATE_MAP.read_text(encoding="utf-8")
    cited = re.findall(r"`([\w./-]+\.(?:py|ts|tsx))::([\w ,'.:-]+?)`", text)
    assert cited, "the gate map cites no tests"
    for path, name in cited:
        source = (ROOT / path).read_text(encoding="utf-8")
        assert name in source, f"{path} has no test called {name!r}"
