"""Layouts and patterns that carry data rather than words (2026-10-11).

A review of agent-built decks found every one converging on cards and rows: the
schema could draw charts, diagrams and photographs, and nothing put one on a
slide. These check that each data layout composes to a valid document with the
element it promises, and that a plan without its data is refused where it is
written rather than composed into an empty frame.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from deckastra_api import presets
from deckastra_api.compose import compose_document
from deckastra_api.models import StoryPlan
from deckastra_api.schema import validate_document

DATA_PATTERNS = {
    "bar-chart": "chart",
    "trend-chart": "chart",
    "waterfall-chart": "chart",
    "slope-chart": "chart",
    "share-chart": "chart",
    "system-diagram": "diagram",
    "process-flow": "diagram",
    "milestones": None,
    "full-bleed-photo": None,
}


def _plan(*slides: dict) -> StoryPlan:
    return StoryPlan.model_validate({"title": "T", "audience": "", "objective": "", "narrative_arc": "", "slides": list(slides)})


@pytest.mark.parametrize("pattern", sorted(DATA_PATTERNS))
def test_every_data_pattern_composes_to_a_valid_slide_with_its_element(pattern):
    plan = presets.slide_plan_from_pattern(pattern)
    document = compose_document(_plan(plan.model_dump(mode="json")))
    assert validate_document(document) == []
    elements = document["slides"][0]["elements"]
    kind = DATA_PATTERNS[pattern]
    if kind:
        drawn = [e for e in elements if e["type"] == kind]
        assert len(drawn) == 1 and drawn[0]["altText"], f"{pattern} drew no {kind} with words for a screen reader"
    if pattern == "milestones":
        assert sum(1 for e in elements if e.get("name", "").startswith("Milestone ")) == 4
    if pattern == "full-bleed-photo":
        frame = next(e for e in elements if e.get("name") == "Image frame")
        assert frame["altText"] == plan.picture
        # The frame is drawn first, so a picture placed in it sits beneath the words.
        assert elements.index(frame) == 0


def test_a_chart_keeps_the_series_names_and_one_value_per_category():
    document = compose_document(_plan({
        "layout": "chart", "purpose": "p", "key_message": "k", "headline": "North overtook South",
        "chart": {"type": "slope", "categories": ["2024", "2026"], "unit": "%",
                  "series": [{"name": "North", "values": [42, 88]}, {"name": "South", "values": [70, 51]}]},
    }))
    chart = next(e for e in document["slides"][0]["elements"] if e["type"] == "chart")
    assert chart["chartType"] == "slope"
    assert chart["encoding"]["value"] == ["North", "South"]
    assert chart["data"]["rows"] == [{"category": "2024", "North": 42, "South": 70}, {"category": "2026", "North": 88, "South": 51}]
    assert "North: 2024 42 %" in chart["altText"]


def test_a_diagram_edge_names_nodes_by_the_ids_the_composer_minted():
    document = compose_document(_plan(presets.slide_plan_from_pattern("system-diagram").model_dump(mode="json")))
    diagram = next(e for e in document["slides"][0]["elements"] if e["type"] == "diagram")
    ids = {node["id"] for node in diagram["nodes"]}
    assert all(edge["from"] in ids and edge["to"] in ids for edge in diagram["edges"])
    assert all(node["id"].startswith("dn_") for node in diagram["nodes"])


@pytest.mark.parametrize("slide, reason", [
    ({"layout": "chart"}, "chart data"),
    ({"layout": "diagram"}, "diagram"),
    ({"layout": "timeline", "timeline": [{"when": "Q1", "label": "Only one"}]}, "two entries"),
    ({"layout": "chart", "chart": {"categories": ["A", "B"], "series": [{"name": "S", "values": [1]}]}}, "1 values for 2 categories"),
    ({"layout": "diagram", "diagram": {"nodes": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}],
                                        "edges": [{"source": "a", "target": "c"}]}}, "not a node"),
])
def test_a_data_layout_without_usable_data_is_refused_where_it_is_written(slide, reason):
    with pytest.raises(ValidationError, match=reason):
        _plan({"purpose": "p", "key_message": "k", "headline": "H", **slide})


def test_a_data_pattern_refuses_a_slot_of_the_wrong_shape():
    with pytest.raises(presets.PresetError, match="must be an object"):
        presets.slide_plan_from_pattern("bar-chart", {"chart": ["not", "a", "chart"]})
    with pytest.raises(presets.PresetError, match="wrong number of items"):
        presets.slide_plan_from_pattern("milestones", {"timeline": [{"when": "Q1", "label": "Only"}]})


# ---------------------------------------------------------------- point charts
# Scatter, bubble and bubble map take points rather than categories (2026-10-13).


def _point_chart(chart: dict) -> dict:
    document = compose_document(_plan({"layout": "chart", "purpose": "p", "key_message": "k", "headline": "Where it sells", "chart": chart}))
    assert validate_document(document) == []
    return next(e for e in document["slides"][0]["elements"] if e["type"] == "chart")


def test_a_bubble_map_composes_from_places_and_groups_them():
    chart = _point_chart({"type": "bubbleMap", "unit": "$M", "points": [
        {"label": "London", "latitude": 51.5, "longitude": -0.13, "size": 42, "group": "Europe"},
        {"label": "Tokyo", "latitude": 35.68, "longitude": 139.69, "size": 47, "group": "Asia"},
    ]})
    assert chart["chartType"] == "bubbleMap"
    assert chart["encoding"] == {"category": "label", "value": "size", "size": "size", "latitude": "latitude", "longitude": "longitude", "series": "group"}
    assert chart["data"]["rows"][0] == {"label": "London", "latitude": 51.5, "longitude": -0.13, "size": 42, "group": "Europe"}
    assert chart["chartStyle"]["showLegend"] is True
    assert chart["altText"] == "Bubble map. London 42 $M; Tokyo 47 $M"


def test_a_bubble_chart_carries_its_axis_titles_and_sizes():
    chart = _point_chart({"type": "bubble", "x_title": "GDP per person", "y_title": "Life expectancy", "points": [
        {"label": "A", "x": 12, "y": 71, "size": 140}, {"label": "B", "x": 45, "y": 81, "size": 60},
    ]})
    assert chart["encoding"] == {"category": "label", "x": "x", "value": "y", "size": "size"}
    assert chart["chartStyle"]["axisX"] == {"title": "GDP per person"}
    assert chart["chartStyle"]["showLegend"] is False
    assert "A at 12, 71, size 140" in chart["altText"]


@pytest.mark.parametrize("chart, reason", [
    ({"type": "scatter"}, "needs points"),
    ({"type": "scatter", "points": [{"label": "A", "x": 1}]}, "A needs x and y"),
    ({"type": "bubble", "points": [{"x": 1, "y": 2}]}, "Point 1 needs x, y and size"),
    ({"type": "bubbleMap", "points": [{"label": "Paris", "latitude": 48.9, "size": 3}]}, "Paris needs a latitude, a longitude and a size"),
    ({"type": "bubbleMap", "points": [{"latitude": 91, "longitude": 0, "size": 1}]}, "less than or equal to 90"),
    ({"type": "column", "points": [{"x": 1, "y": 1}]}, "needs categories"),
])
def test_a_point_chart_without_usable_points_is_refused_where_it_is_written(chart, reason):
    with pytest.raises(ValidationError, match=reason):
        _plan({"layout": "chart", "purpose": "p", "key_message": "k", "headline": "H", "chart": chart})


# -------------------------------------------------------------- diagram views
# A diagram can be seen as blocks, an exploded stack or an orbit (2026-10-13).


@pytest.mark.parametrize("view, hint", [
    ("flat", {"algorithm": "layered", "direction": "LR", "mode": "managed"}),
    ("isometric", {"algorithm": "layered", "direction": "LR", "mode": "managed", "projection": "isometric"}),
    ("stack", {"algorithm": "stack", "direction": "LR", "mode": "managed"}),
    ("orbit", {"algorithm": "orbit", "direction": "LR", "mode": "managed"}),
])
def test_a_diagram_view_becomes_its_layout_hint(view, hint):
    document = compose_document(_plan({
        "layout": "diagram", "purpose": "p", "key_message": "k", "headline": "How it fits together",
        "diagram": {"view": view, "nodes": [{"key": "a", "label": "Interface"}, {"key": "b", "label": "Engine"}, {"key": "c", "label": "Store"}],
                    "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "c"}]},
    }))
    assert validate_document(document) == []
    diagram = next(e for e in document["slides"][0]["elements"] if e["type"] == "diagram")
    assert diagram["layoutHint"] == hint


def test_an_unknown_diagram_view_is_refused_where_it_is_written():
    with pytest.raises(ValidationError, match="view"):
        _plan({"layout": "diagram", "purpose": "p", "key_message": "k", "headline": "H",
               "diagram": {"view": "helix", "nodes": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}]}})
