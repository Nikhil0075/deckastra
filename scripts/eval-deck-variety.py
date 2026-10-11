"""Structural variety, before and after the deck-design skill (2026-10-11).

Three briefs, each written twice as the StoryPlan an agent sends to
`deck_compose`: "before" is the shape the 2026-10-11 review found agents
producing (cards and lists throughout, no evidence, no language), "after" is
the same content written the way `deckastra://guides/deck-design` asks. Both
are composed by the real composer and transition planner, then measured by
`variety.report`, which is what `deck_compose` reports back to an agent.

What this measures is what the composer *can* express from each plan, and that
the metric separates the two. It does not measure a live agent following the
skill: that needs a person to run a client with the guide and score the deck
it builds with `--document <file>`.

    python scripts/eval-deck-variety.py                 # the three briefs
    python scripts/eval-deck-variety.py --write docs/design-audit/VARIETY_EVAL.md
    python scripts/eval-deck-variety.py --document deck.mydeck.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from deckastra_api import presets, template_compose, variety  # noqa: E402
from deckastra_api.compose import compose_document  # noqa: E402
from deckastra_api.models import StoryPlan  # noqa: E402


def s(layout: str, headline: str, **rest) -> dict:
    return {"layout": layout, "purpose": headline, "key_message": headline, "headline": headline, **rest}


B3 = ["First point", "Second point", "Third point"]

BRIEFS: dict[str, dict] = {
    "Rooftop solar for rural clinics (investor pitch)": {
        "language": "data-desk",
        "before": [
            s("title", "Power for rural clinics", subtitle="Seed round"),
            s("bullets", "The problem", bullets=["Grid outages", "Diesel costs", "Vaccine spoilage"]),
            s("bullets", "Our solution", bullets=["40 kW canopies", "Pay as you go", "Remote monitoring"]),
            s("metrics", "Traction", metrics=[{"value": "38", "label": "clinics"}, {"value": "₹2.1 cr", "label": "ARR"}]),
            s("bullets", "Business model", bullets=["Lease", "Service fee", "Carbon credits"]),
            s("bullets", "Go to market", bullets=["Utilities", "State health missions", "NGOs"]),
            s("split", "Roadmap", body="Next three years.", bullets=["Pilot", "Scale", "National"]),
            s("bullets", "The ask", bullets=["₹12 crore", "18 months runway", "Two states"]),
        ],
        "after": [
            s("image", "Power where it is needed most", eyebrow="Seed round", picture="Solar canopy over a rural clinic at dusk"),
            s("statement", "A third of rural clinics lose power every week"),
            s("chart", "Revenue grew every quarter", body="Repeat sites drove two thirds of growth.",
              chart={"type": "column", "categories": ["Q1", "Q2", "Q3", "Q4"], "series": [{"name": "Revenue", "values": [2.1, 3.4, 4.0, 4.7]}], "unit": "₹ cr"},
              caption="Source: company ledger, FY2026"),
            s("diagram", "How a reading becomes a payout",
              diagram={"nodes": [{"key": "m", "label": "Smart meter"}, {"key": "g", "label": "Gateway"}, {"key": "l", "label": "Ledger"}, {"key": "b", "label": "Bank"}],
                       "edges": [{"source": "m", "target": "g"}, {"source": "g", "target": "l"}, {"source": "l", "target": "b", "label": "UPI"}]}),
            s("metrics", "Unit economics hold at scale", metrics=[{"value": "3.1 yr", "label": "payback"}, {"value": "62%", "label": "gross margin"}]),
            s("chart", "North overtook South",
              chart={"type": "slope", "categories": ["2024", "2026"], "series": [{"name": "North", "values": [42, 88]}, {"name": "South", "values": [70, 51]}], "unit": "%"}),
            s("timeline", "From pilot to national", timeline=[{"when": "Q1 2027", "label": "Pilot"}, {"when": "Q3 2027", "label": "Scale"}, {"when": "2029", "label": "National"}]),
            s("statement", "₹12 crore takes us to twelve states"),
        ],
    },
    "Moving the support queue to a new system (team update)": {
        "language": "quiet-luxe",
        "before": [
            s("title", "Support migration", subtitle="Team update"),
            s("bullets", "Why we are moving", bullets=B3),
            s("bullets", "What changes", bullets=B3),
            s("bullets", "What stays the same", bullets=B3),
            s("split", "Timeline", body="Six weeks.", bullets=B3),
            s("bullets", "Risks", bullets=B3),
            s("bullets", "Next steps", bullets=B3),
        ],
        "after": [
            s("title", "One queue, one week of handover", subtitle="Support migration"),
            s("chart", "Tickets wait longest at the handoff",
              chart={"type": "bar", "categories": ["Triage", "Handoff", "Fix", "Close"], "series": [{"name": "Hours", "values": [2, 19, 6, 1]}]}),
            s("diagram", "The new path for a ticket",
              diagram={"kind": "flow", "nodes": [{"key": "a", "label": "Request"}, {"key": "b", "label": "Triage"}, {"key": "c", "label": "Owner"}, {"key": "d", "label": "Confirm"}],
                       "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "c"}, {"source": "c", "target": "d"}]}),
            s("quote", "What a customer told us", quote="I explained the same problem to three people.", attribution="Customer interview, September"),
            s("timeline", "Six weeks, three switches", timeline=[{"when": "Week 1", "label": "Shadow"}, {"when": "Week 3", "label": "Split"}, {"when": "Week 6", "label": "Switch"}]),
            s("bullets", "What we ask of you", bullets=["Tag every ticket", "Name an owner", "Flag gaps in the new queue"]),
            s("statement", "Switch-over is Monday 9 November"),
        ],
    },
    "Why our warehouse picks got slower (operations review)": {
        "language": "swiss-signal",
        "before": [
            s("title", "Pick rate review"),
            s("metrics", "Key numbers", metrics=[{"value": "112", "label": "picks/hr"}, {"value": "-14%", "label": "vs last year"}]),
            s("bullets", "Causes", bullets=B3),
            s("bullets", "Analysis", bullets=B3),
            s("bullets", "Options", bullets=B3),
            s("bullets", "Recommendation", bullets=B3),
        ],
        "after": [
            s("statement", "Picks per hour fell 14%"),
            s("chart", "The fall began with the new layout",
              chart={"type": "line", "categories": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], "series": [{"name": "Picks/hr", "values": [131, 130, 129, 118, 114, 112]}]}),
            s("chart", "Walking, not searching, ate the time",
              chart={"type": "waterfall", "categories": ["Last year", "Walking", "Searching", "Scanning"], "series": [{"name": "Seconds", "values": [27, 4.5, 0.5, -0.2]}]}),
            s("image", "Fast movers sit at the far wall", picture="Warehouse aisle with high-demand stock on the back wall"),
            s("split", "Move 40 SKUs, not the racks", body="Re-slotting is two weekends of work.", bullets=["No capital cost", "Reversible", "Measurable in a week"]),
            s("statement", "Re-slot the top 40 before peak"),
        ],
    },
}


def measure(slides: list[dict], language: str) -> dict:
    plan = StoryPlan.model_validate({"title": "Eval", "audience": "", "objective": "", "narrative_arc": "", "slides": slides})
    defaults = (presets.catalog().get("designLanguages") or {}).get(language, {}).get("defaults") or {}
    theme, _ = presets.resolve_theme(str(defaults.get("themeKey") or "neo-technical"))
    document = compose_document(plan, theme_definition=theme, language=language)
    template_compose.plan_transitions(document, plan, language, str(defaults.get("transitionStyle") or "fade"))
    return variety.report(document)


def table(rows: list[tuple[str, str, dict]]) -> str:
    out = ["| Brief | Plan | Slides | Structures | Longest run | Evidence slides | Transitions | Warnings |",
           "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for brief, label, r in rows:
        out.append(f"| {brief} | {label} | {r['slides']} | {r['structures']} | {r['longest_run']} | {r['data_slides']} | {r['transitions']} | {len(r['warnings'])} |")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", type=Path)
    parser.add_argument("--document", type=Path, help="Score one stored deck instead.")
    args = parser.parse_args()
    if args.document:
        print(json.dumps(variety.report(json.loads(args.document.read_text(encoding="utf-8"))), indent=2))
        return 0
    rows = []
    for brief, spec in BRIEFS.items():
        # "Before" is how the reviewed agents worked: neutral, no language.
        rows.append((brief, "before", measure(spec["before"], "neutral")))
        rows.append((brief, f"after ({spec['language']})", measure(spec["after"], spec["language"])))
    text = table(rows)
    print(text)
    for brief, label, r in rows:
        for warning in r["warnings"]:
            print(f"- {brief} / {label}: {warning}")
    if args.write:
        args.write.write_text(
            "# Structural variety: before and after the deck-design skill\n\n"
            "Generated by `python scripts/eval-deck-variety.py --write docs/design-audit/VARIETY_EVAL.md`. "
            "Each brief is composed by the real composer twice: the plan shape the 2026-10-11 review found "
            "agents sending, and the same content written to `deckastra://guides/deck-design`. It shows what "
            "the composer can express and that the metric separates the two; it is not a measurement of a "
            "live agent following the guide.\n\n" + text + "\n",
            encoding="utf-8", newline="\n",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
