"""Tests for deterministic ``StoryPlan`` composition."""

from __future__ import annotations

import json
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.compose import compose_document, compose_slide  # noqa: E402
from deckastra_api.assistant_design import check as design_check  # noqa: E402
from deckastra_api.ids import new_id, new_ulid  # noqa: E402
from deckastra_api.models import (  # noqa: E402
    Metric,
    SlideLayout,
    SlidePlan,
    StoryPlan,
)
from deckastra_api import presets  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402


def fixed_plan(count: int = 7) -> StoryPlan:
    layouts = list(SlideLayout)
    slides = []
    for index in range(count):
        layout = layouts[index % len(layouts)]
        slides.append(
            SlidePlan(
                layout=layout,
                purpose=f"Purpose {index + 1}",
                key_message=f"Message {index + 1}",
                headline=f"Headline {index + 1}",
                body="A concise supporting paragraph.",
                bullets=["One", "Two", "Three"],
                metrics=[Metric(value="3x", label="Faster"), Metric(value="40%", label="Less")],
                quote="A useful quotation.",
                attribution="Source",
                code="SELECT 1;",
                language="sql",
            )
        )
    return StoryPlan(
        title="Fixed composition fixture",
        audience="Reviewers",
        objective="Verify deterministic output",
        narrative_arc="Open, explain, and close.",
        slides=slides,
    )


# ------------------------------------------------------------------------ ids


def test_ulids_are_unique_and_ordered_within_one_millisecond():
    # A deck composed in a single pass mints hundreds of ids inside the same
    # millisecond. A non-monotonic ULID would collide or sort out of order.
    ids = [new_ulid() for _ in range(2000)]
    assert len(set(ids)) == len(ids)
    assert ids == sorted(ids)


def test_ids_match_the_schema_grammar():
    import re

    pattern = re.compile(r"^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$")
    for prefix in ("doc", "sld", "el", "blk", "thm"):
        assert pattern.match(new_id(prefix)), prefix


def test_ulid_alphabet_excludes_ambiguous_letters():
    # Crockford base32: no I, L, O or U, so an id cannot be misread aloud into a
    # different valid id.
    joined = "".join(new_ulid() for _ in range(200))
    assert not set(joined) & set("ILOU")


# -------------------------------------------------------------------- compose


@pytest.mark.parametrize("layout", list(SlideLayout))
def test_every_layout_composes_a_valid_document(layout):
    plan = StoryPlan(
        title="Test",
        audience="Engineers",
        objective="Prove every layout composes",
        narrative_arc="One slide.",
        slides=[
            SlidePlan(
                layout=layout,
                purpose="Exercise this layout",
                key_message="It composes",
                headline="A headline that is a claim, not a label",
                eyebrow="EYEBROW",
                subtitle="A supporting line",
                body="A short paragraph of body copy for the split layout.",
                bullets=["First point", "Second point", "Third point"],
                metrics=[Metric(value="250ms", label="First paint")],
                quote="A quotation worth remembering",
                attribution="Someone",
                code='{"op": "replace"}',
                language="json",
                caption="A caption",
            )
        ],
    )

    document = compose_document(plan)
    assert validate_document(document) == []


@pytest.mark.parametrize(
    "preset",
    presets.public_catalog()["presets"],
    ids=lambda preset: preset["id"],
)
def test_every_reviewed_preset_composes_a_valid_document(preset):
    plan = presets.story_plan_from_preset(preset)
    theme, theme_id = presets.resolve_theme(preset["themeKey"])
    document = compose_document(plan, theme_definition=theme, theme_id=theme_id)

    assert validate_document(document) == []
    assert len(document["slides"]) == len(preset["slides"])
    assert len(document["slides"]) == 10
    assert [slide["layout"]["styleLabel"] for slide in document["slides"]] == [
        slide["pattern"] for slide in preset["slides"]
    ]


def test_seven_motion_styles_resolve_to_bounded_semantic_plans():
    catalog = presets.public_catalog()
    assert set(catalog["motionStyles"]) == {
        "restrained",
        "dynamic",
        "cinematic",
        "editorial",
        "energetic",
        "technical",
        "playful",
    }
    for preset in catalog["presets"]:
        plan = presets.motion_plan_from_preset(preset)
        assert plan["style"] == preset["motionStyle"]
        assert len(plan["slides"]) == 10
        assert all(slide["sequence"] and slide["entrance"] and slide["pacing"] for slide in plan["slides"])


def test_every_reviewed_preset_passes_the_preset_design_gate():
    blocked_codes = {"W110", "W104", "W216", "A102"}
    for preset in presets.public_catalog()["presets"]:
        plan = presets.story_plan_from_preset(preset)
        theme, theme_id = presets.resolve_theme(preset["themeKey"])
        document = compose_document(plan, theme_definition=theme, theme_id=theme_id)
        blocked = [
            finding
            for finding in design_check(document)["findings"]
            if finding["code"] in blocked_codes
        ]
        assert blocked == [], preset["id"]


@pytest.mark.parametrize(
    ("sample_name", "text"),
    [
        ("short", "Clear result"),
        ("typical", "A practical change makes the important work easier to see"),
        (
            "forty-word paragraph",
            "A carefully bounded change gives every team enough shared context to make a confident decision "
            "while preserving the evidence ownership operating constraints review history and measurable outcomes "
            "needed to adapt the plan without creating hidden work or avoidable confusion for anyone later on.",
        ),
        ("Hindi", "स्पष्ट निर्णय टीम को सही दिशा में आगे बढ़ने और परिणाम को मिलकर समझने में मदद करता है"),
        ("Arabic", "يساعد القرار الواضح الفريق على المضي قدماً وفهم النتيجة المشتركة بثقة"),
        ("CJK", "明確な意思決定により、チームは重要な成果と次の行動を共通して理解できます"),
    ],
)
def test_every_pattern_survives_stress_content(sample_name, text):
    slides = [
        SlidePlan(
            layout=layout,
            purpose=f"Stress {sample_name}",
            key_message=text,
            headline=text,
            eyebrow=text[:20],
            subtitle=text,
            body=text,
            bullets=[text, text, text],
            metrics=[Metric(value="99.95%", label=text), Metric(value="2×", label=text)],
            quote=text,
            attribution=text,
            code="result = run(input)\nassert result.reviewed",
            language="python",
            caption=text,
        )
        for layout in SlideLayout
    ]
    document = compose_document(
        StoryPlan(title=f"{sample_name} stress", audience="", objective="", narrative_arc="", slides=slides)
    )
    blocked_codes = {"W110", "W104", "W216", "A102"}
    blocked = [
        finding
        for finding in design_check(document)["findings"]
        if finding["code"] in blocked_codes
    ]

    assert validate_document(document) == []
    assert blocked == []


def test_composition_is_deterministic_apart_from_ids():
    plan = fixed_plan(5)

    def strip_ids(node):
        if isinstance(node, dict):
            return {k: strip_ids(v) for k, v in node.items() if k not in {"id", "createdAt", "updatedAt"}}
        if isinstance(node, list):
            return [strip_ids(v) for v in node]
        return node

    first = strip_ids(compose_document(plan))
    second = strip_ids(compose_document(plan))
    assert first == second


def test_metrics_layout_emits_a_container_not_absolute_boxes():
    # The whole point of doc 02 §21.2: a container re-flows when a label runs
    # long; four absolute boxes overlap.
    plan = SlidePlan(
        layout=SlideLayout.METRICS,
        purpose="Show numbers",
        key_message="The numbers matter",
        headline="Budgets",
        metrics=[
            Metric(value="250ms", label="First paint"),
            Metric(value="16ms", label="Drag frame time at the ninety-fifth percentile"),
            Metric(value="600MB", label="Memory"),
        ],
    )

    slide = compose_slide(plan, 0)
    row = next(e for e in slide["elements"] if e.get("groupRole") == "kpiRow")

    assert row["containerLayout"]["type"] == "horizontal"
    assert row["containerLayout"]["distribute"] == "equal"
    assert row["resizeMode"] == "resizeContainer"
    assert len(row["children"]) == 3
    for card in row["children"]:
        assert card["containerLayout"]["type"] == "vertical"


def test_every_slide_carries_semantic_intent_and_key_message():
    # A slide with a keyMessage and no prominent element expressing it is a
    # hierarchy failure the Critic can detect mechanically. Without the field it
    # cannot detect anything.
    plan = fixed_plan()
    document = compose_document(plan)

    for slide in document["slides"]:
        assert slide["semanticIntent"]
        assert slide["keyMessage"]


def test_headlines_shrink_rather_than_overflow():
    plan = SlidePlan(
        layout=SlideLayout.BULLETS,
        purpose="p",
        key_message="k",
        headline="A very long headline that a model might well produce when it gets enthusiastic",
    )
    slide = compose_slide(plan, 0)
    headline = next(e for e in slide["elements"] if e.get("semanticRole") == "headline")

    assert headline["fit"] == "shrinkToFit"
    assert headline["minFontSize"] < headline["typography"]["fontSize"]


def test_no_element_starts_outside_the_safe_area():
    plan = fixed_plan()
    document = compose_document(plan)
    safe = document["viewport"]["safeArea"]

    def check(elements, offset_x=0.0, offset_y=0.0):
        for element in elements:
            t = element["transform"]
            x = t["x"] + offset_x
            y = t["y"] + offset_y
            assert x >= safe["left"] - 1, f"{element['id']} starts left of the safe area"
            assert y >= safe["top"] - 1, f"{element['id']} starts above the safe area"
            if element.get("children"):
                check(element["children"], x, y)

    for slide in document["slides"]:
        check(slide["elements"])


def test_composed_documents_carry_no_credentials_or_signed_urls():
    # A .mydeck file must be safe to email (doc 02 §29.1).
    document = compose_document(fixed_plan(5))
    blob = json.dumps(document)
    for forbidden in ("apiKey", "api_key", "Bearer ", "X-Amz-Signature", "secret"):
        assert forbidden not in blob


def test_layout_vocabulary_is_closed():
    assert {layout.value for layout in SlideLayout} == {
        "title", "statement", "bullets", "metrics", "quote", "code", "split"
    }
