"""Every reviewed template, composed and rendered: the gallery's quality report.

UI audit 2026-10-10, unit 2. The gallery now draws each template as itself, so
it shows honestly what the catalog is -- including how alike many templates
compose today. This measures that, so the design-language work (units 5 and 7)
has a baseline to beat and a gate to turn on:

- **Render-time findings**, from the renderer's own semantic pass over every
  slide (`scene-check.ts`): clipped text (W103), contrast and the rest.
- **Missing covers**: a template whose first slide did not render.
- **Near-duplicate covers**: covers whose difference hash differs by at most
  `--duplicate-bits` bits. A gallery of near-identical covers is a catalogue,
  not a choice.
- **Language distances** (unit 5): each named language's covers against the
  nearest neutral cover and the nearest other language, by hash and by
  grammar (headline size, alignment and position, and the shapes drawn). A
  language cover with a neutral cover's grammar is a recolour, and a finding.

It renders through the export worker (`export_service.render_slide_png`), the
same path a preview and an export take, and writes `report.json`, the cover PNGs
and an `index.html` contact sheet to `--out`.

It reports by default. `--strict` exits 1 on any finding; unit 7 turns that on
in CI once the catalog is meant to pass it.

    python packages/deck-presets/scripts/preview-sheet.py --out .artifacts/preview-sheet
"""

from __future__ import annotations

import argparse
import html
import io
import json
import os
import subprocess
import sys
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from PIL import Image  # noqa: E402

from deckastra_api import export_service, presets, template_compose  # noqa: E402


def difference_hash(png: bytes, size: int = 16) -> int:
    """A 256-bit dHash: robust to scale, sensitive to layout and contrast."""
    image = Image.open(io.BytesIO(png)).convert("L").resize((size + 1, size), Image.LANCZOS)
    pixels = list(image.getdata())
    bits = 0
    for row in range(size):
        for column in range(size):
            left = pixels[row * (size + 1) + column]
            right = pixels[row * (size + 1) + column + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def scene_findings(directory: Path) -> dict[str, list[dict]]:
    script = ROOT / "packages" / "renderer" / "scripts" / "scene-check.ts"
    command = ["npx", "tsx", str(script), str(directory)]
    completed = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=os.name == "nt",
        check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(f"scene-check failed:\n{completed.stderr}")
    return json.loads(completed.stdout)


def cover_signature(document: dict) -> dict:
    """The cover's grammar rather than its colour: headline size and alignment, and its shapes."""
    def walk(elements):
        for element in elements:
            yield element
            yield from walk(element.get("children") or [])

    elements = list(walk((document.get("slides") or [{}])[0].get("elements") or []))
    headline = next((one for one in elements if one.get("semanticRole") == "headline"), None) or {}
    return {
        "headline_size": round((headline.get("typography") or {}).get("fontSize") or 0),
        "headline_align": (headline.get("paragraph") or {}).get("align") or "left",
        "headline_x": round((headline.get("transform") or {}).get("x") or 0),
        "shapes": sorted(one.get("name", "") for one in elements if one.get("type") == "shape"),
    }


def language_distances(rendered: dict[str, dict]) -> list[dict]:
    """How far each named language's covers sit from neutral's, and from each other's (UI audit unit 5).

    The nearest neutral cover is the honest comparison: a language that is a
    recolour of one neutral template would hide in an average.
    """
    by_language: dict[str, list[tuple[str, dict]]] = {}
    for name, one in rendered.items():
        by_language.setdefault(one["language"], []).append((name, one))
    neutral = by_language.get("neutral", [])
    rows = []
    for language, members in sorted(by_language.items()):
        if language == "neutral":
            continue
        for name, one in sorted(members):
            nearest = min(
                ((bin(one["hash"] ^ other["hash"]).count("1"), other_name, other) for other_name, other in neutral),
                default=None,
                key=lambda row: row[0],
            )
            rows.append({
                "template": name,
                "language": language,
                "signature": one["signature"],
                "nearest_neutral": nearest[1] if nearest else None,
                "nearest_neutral_bits": nearest[0] if nearest else None,
                "same_grammar_as_a_neutral_cover": any(other["signature"] == one["signature"] for _, other in neutral),
                "nearest_other_language_bits": min(
                    (bin(one["hash"] ^ other["hash"]).count("1")
                     for other_language, others in by_language.items() if other_language not in (language, "neutral")
                     for _, other in others),
                    default=None,
                ),
            })
    return rows


#: One outline, composed in every language for the gate. Fixed, so a run's
#: answer changes only when a language does.
GATE_OUTLINE = [
    {"layout": "title", "headline": "Focus wins the quarter", "eyebrow": "Quarterly review", "subtitle": "What changed, and what we do next"},
    {"layout": "statement", "headline": "One handoff slowed everything", "eyebrow": "The problem", "body": "Work waited on a review nobody owned."},
    {"layout": "bullets", "headline": "Three moves for next quarter", "eyebrow": "The plan", "bullets": ["Name an owner", "Measure the handoff", "Review weekly"]},
    {"layout": "metrics", "headline": "The change is already visible", "eyebrow": "Evidence", "metrics": [{"value": "42%", "label": "less rework"}, {"value": "3x", "label": "faster review"}, {"value": "2 wks", "label": "to value"}]},
    {"layout": "quote", "headline": "In their words", "eyebrow": "Customer", "quote": "We stopped rebuilding the same story.", "attribution": "Pilot customer"},
    {"layout": "split", "headline": "Focus beats breadth", "eyebrow": "Trade-off", "body": "A narrow first scope teaches faster.", "bullets": ["Faster learning", "Clear ownership"]},
]


def language_gate(out: Path, min_bits: int) -> dict:
    """Compose the fixed outline in every language with templates, and judge it (UI audit unit 7b).

    The languages must look unlike each other, on three counts: every pair of
    covers differs by more than `min_bits` of the 256-bit difference hash; no
    two title slides share a grammar (headline size, alignment, position and the
    shapes drawn); and nothing in any language's outline clips (W103) or puts
    one object on another (W110).
    """
    from deckastra_api import languages as language_geometry
    from deckastra_api.compose import compose_document
    from deckastra_api.models import SlidePlan, StoryPlan

    catalog = presets.catalog()
    used = sorted({preset["designLanguage"] for preset in presets.public_catalog()["presets"]})
    documents = out / "language-documents"
    covers = out / "language-covers"
    documents.mkdir(parents=True, exist_ok=True)
    covers.mkdir(parents=True, exist_ok=True)
    plan = StoryPlan(
        title="Language gate", audience="", objective="", narrative_arc="",
        slides=[SlidePlan(purpose=slide["eyebrow"], key_message=slide["headline"], **slide) for slide in GATE_OUTLINE],
    )
    rendered: dict[str, dict] = {}
    for language in used:
        theme, theme_id = presets.resolve_theme(catalog["designLanguages"][language]["defaults"]["themeKey"])
        story, _ = language_geometry.apply_density(plan, language)
        document = compose_document(story, instruction=f"Language gate: {language}", theme_definition=theme, theme_id=theme_id,
                                    language=language, language_version=presets.language_version(language))
        (documents / f"{language}.json").write_text(json.dumps(document), encoding="utf-8")
        picture = export_service.render_slide_png(document, document["slides"][0]["id"])
        (covers / f"{language}.png").write_bytes(picture["bytes"])
        rendered[language] = {"hash": difference_hash(picture["bytes"]), "signature": cover_signature(document)}
        print(f"gate {language}", file=sys.stderr)

    close = []
    for (left, a), (right, b) in combinations(sorted(rendered.items()), 2):
        distance = bin(a["hash"] ^ b["hash"]).count("1")
        if distance <= min_bits:
            close.append({"languages": [left, right], "distance": distance})
    shared = [
        {"languages": [left, right]}
        for (left, a), (right, b) in combinations(sorted(rendered.items()), 2)
        if a["signature"] == b["signature"]
    ]
    findings = scene_findings(documents)
    broken = {name: [one for one in issues if one["code"] in {"W103", "W110"}] for name, issues in findings.items()}
    broken = {name: issues for name, issues in broken.items() if issues}
    distances = {
        f"{left}|{right}": bin(a["hash"] ^ b["hash"]).count("1")
        for (left, a), (right, b) in combinations(sorted(rendered.items()), 2)
    }
    return {
        "languages": used,
        "min_bits": min_bits,
        "closest_pair": min(distances.items(), key=lambda item: item[1]) if distances else None,
        "too_close": close,
        "shared_grammar": shared,
        "clipped_or_overlapping": broken,
        "passed": not (close or shared or broken),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / ".artifacts" / "preview-sheet")
    parser.add_argument("--duplicate-bits", type=int, default=24, help="covers this close (of 256 bits) are near-duplicates")
    parser.add_argument("--strict", action="store_true", help="exit 1 on any finding")
    parser.add_argument("--languages", action="store_true", help="run only the design-language gate (unit 7b)")
    parser.add_argument("--language-bits", type=int, default=40, help="language covers must differ by more than this")
    args = parser.parse_args()

    if args.languages:
        args.out.mkdir(parents=True, exist_ok=True)
        gate = language_gate(args.out, args.language_bits)
        (args.out / "language-gate.json").write_text(json.dumps(gate, indent=2), encoding="utf-8")
        print(
            f"{len(gate['languages'])} languages; closest pair {gate['closest_pair']}; "
            f"{len(gate['too_close'])} pairs within {args.language_bits} bits; {len(gate['shared_grammar'])} shared grammars; "
            f"{sum(len(v) for v in gate['clipped_or_overlapping'].values())} clipped or overlapping objects. "
            f"{'PASSED' if gate['passed'] else 'FAILED'}"
        )
        return 0 if gate["passed"] or not args.strict else 1

    out: Path = args.out
    documents = out / "documents"
    covers = out / "covers"
    documents.mkdir(parents=True, exist_ok=True)
    covers.mkdir(parents=True, exist_ok=True)

    catalog = presets.public_catalog()
    rendered: dict[str, dict] = {}
    missing: list[dict] = []
    for preset in catalog["presets"]:
        template_id = preset["id"]
        document = template_compose.compose_template(template_id)
        (documents / f"{template_id}.json").write_text(json.dumps(document), encoding="utf-8")
        first = (document.get("slides") or [{}])[0].get("id")
        try:
            picture = export_service.render_slide_png(document, first)
        except Exception as error:  # noqa: BLE001 - every failure is a finding
            missing.append({"template": template_id, "reason": str(error)[:300]})
            continue
        (covers / f"{template_id}.png").write_bytes(picture["bytes"])
        rendered[template_id] = {
            "theme": preset["themeKey"],
            "language": preset.get("designLanguage") or "neutral",
            "signature": cover_signature(document),
            "hash": difference_hash(picture["bytes"]),
            "warnings": picture["warnings"],
        }
        print(f"rendered {template_id}", file=sys.stderr)

    duplicates = []
    for (left, a), (right, b) in combinations(sorted(rendered.items()), 2):
        distance = bin(a["hash"] ^ b["hash"]).count("1")
        if distance <= args.duplicate_bits:
            duplicates.append({"templates": [left, right], "distance": distance})
    duplicates.sort(key=lambda pair: pair["distance"])

    languages = language_distances(rendered)

    findings = scene_findings(documents)
    clipped = {name: [one for one in issues if one["code"] == "W103"] for name, issues in findings.items()}
    clipped = {name: issues for name, issues in clipped.items() if issues}

    report = {
        "catalog_revision": template_compose.catalog_revision(),
        "templates": len(catalog["presets"]),
        "rendered": len(rendered),
        "missing_covers": missing,
        "near_duplicate_covers": duplicates,
        "language_distances": languages,
        "duplicate_threshold_bits": args.duplicate_bits,
        "clipped_text": clipped,
        "render_warnings": {name: one["warnings"] for name, one in rendered.items() if one["warnings"]},
        "scene_findings": {name: issues for name, issues in findings.items() if issues},
    }
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    cards = "\n".join(
        f'<figure><img src="covers/{html.escape(name)}.png" width="384"><figcaption>{html.escape(name)}'
        f' · {html.escape(one["theme"])}</figcaption></figure>'
        for name, one in sorted(rendered.items())
    )
    (out / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Template covers</title>"
        "<style>body{font:13px system-ui;display:flex;flex-wrap:wrap;gap:12px;padding:16px}"
        "figure{margin:0}img{display:block;border:1px solid #ccc}</style>" + cards,
        encoding="utf-8",
    )

    print(
        f"{report['rendered']}/{report['templates']} covers rendered; "
        f"{len(missing)} missing; {len(duplicates)} near-duplicate pairs (<= {args.duplicate_bits} bits); "
        f"{sum(len(issues) for issues in clipped.values())} clipped text boxes in {len(clipped)} templates; "
        f"{sum(1 for row in languages if row['same_grammar_as_a_neutral_cover'])} language covers share a neutral cover's grammar. "
        f"Report: {out / 'report.json'}"
    )
    failing = missing or duplicates or clipped or any(row["same_grammar_as_a_neutral_cover"] for row in languages)
    return 1 if args.strict and failing else 0


if __name__ == "__main__":
    raise SystemExit(main())
