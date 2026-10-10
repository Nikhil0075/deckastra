"""Shared deck preset catalog and deterministic StoryPlan conversion."""

from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
import json
from typing import Any

from .models import Metric, SlidePlan, StoryPlan
from .paths import resource_root

PRESETS_PATH = resource_root() / "packages" / "deck-presets" / "generated" / "deck-presets.json"
THEMES_PATH = resource_root() / "packages" / "presentation-schema" / "generated" / "theme-presets.json"


class PresetError(ValueError):
    """A preset id, theme or slot override the caller can fix."""


@lru_cache(maxsize=1)
def catalog() -> dict[str, Any]:
    if not PRESETS_PATH.exists():
        raise RuntimeError(f"{PRESETS_PATH} is missing. Run: npm run presets:emit")
    with PRESETS_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def themes() -> dict[str, dict[str, Any]]:
    if not THEMES_PATH.exists():
        raise RuntimeError(f"{THEMES_PATH} is missing. Run: npm run schema:emit")
    with THEMES_PATH.open(encoding="utf-8") as handle:
        rows = json.load(handle).get("presets") or []
    return {str(row["key"]): row for row in rows}


def public_catalog() -> dict[str, Any]:
    """Only reviewed templates are visible to people and agents."""
    value = deepcopy(catalog())
    value["presets"] = [one for one in value.get("presets") or [] if one.get("reviewed") is True]
    value["themes"] = [
        {
            "key": key,
            "name": row.get("name") or key,
            "summary": row.get("summary") or "",
            "preview": {
                field: (row.get("theme") or {}).get("colors", {}).get(field)
                for field in ("background", "foreground", "accent", "surface")
            },
        }
        for key, row in themes().items()
    ]
    return value


def language_version(language_id: str) -> int:
    """The version of a design language in this catalog (UI audit unit 5)."""
    language = (catalog().get("designLanguages") or {}).get(language_id)
    if not language:
        raise PresetError(f'"{language_id}" is not a design language in this catalog.')
    return int(language.get("version") or 1)


def find_preset(preset_id: str) -> dict[str, Any]:
    found = next(
        (one for one in public_catalog().get("presets") or [] if one.get("id") == preset_id),
        None,
    )
    if found is None:
        raise PresetError(f"No reviewed deck template named {preset_id!r}.")
    return found


def resolve_theme(theme_key: str) -> tuple[dict[str, Any], str]:
    found = themes().get(theme_key)
    if found is None:
        raise PresetError(f"No built-in theme named {theme_key!r}.")
    definition = deepcopy(found["theme"])
    return definition, str(definition["id"])


def story_plan_from_preset(
    preset: dict[str, Any],
    *,
    title: str | None = None,
    content: dict[str, dict[str, Any]] | None = None,
) -> StoryPlan:
    overrides = content or {}
    slides_by_key = {str(slide["key"]): slide for slide in preset.get("slides") or []}
    unknown_slides = sorted(set(overrides) - set(slides_by_key))
    if unknown_slides:
        raise PresetError("Unknown preset slide keys: " + ", ".join(unknown_slides))

    plans: list[SlidePlan] = []
    for key, slide in slides_by_key.items():
        pattern_id = str(slide["pattern"])
        definition = (catalog().get("patternDefinitions") or {}).get(pattern_id)
        if not definition:
            raise PresetError(f"Preset slide {key!r} names unknown pattern {pattern_id!r}.")
        slots = deepcopy(slide.get("slots") or {})
        supplied = overrides.get(key) or {}
        unknown_slots = sorted(set(supplied) - set(slots))
        if unknown_slots:
            raise PresetError(f"Unknown slots on {key}: " + ", ".join(unknown_slots))
        slots.update(supplied)
        plans.append(slide_plan_from_pattern(pattern_id, slots, purpose=str(slide.get("purpose") or ""), label=f"preset slide {key!r}"))

    deck_title = (title or str(preset.get("name") or "Untitled presentation")).strip()
    if not deck_title:
        raise PresetError("A deck title cannot be empty.")
    return StoryPlan(
        title=deck_title,
        audience="",
        objective=str(preset.get("summary") or ""),
        narrative_arc=" → ".join(plan.purpose for plan in plans),
        slides=plans,
    )


def slide_plan_from_pattern(
    pattern_id: str,
    slots: dict[str, Any] | None = None,
    *,
    purpose: str = "Add a useful slide",
    label: str | None = None,
) -> SlidePlan:
    """Validate named content slots and return deterministic composer intent."""
    definition = (catalog().get("patternDefinitions") or {}).get(pattern_id)
    if not definition:
        raise PresetError(f"No slide pattern named {pattern_id!r}.")
    supplied = deepcopy(slots or {})
    definitions = definition.get("slots") or {}
    unknown = sorted(set(supplied) - set(definitions))
    if unknown:
        raise PresetError(f"Unknown slots for {pattern_id}: " + ", ".join(unknown))
    values = deepcopy(definition.get("exampleSlots") or {})
    values.update(supplied)
    missing = [name for name, slot in definitions.items() if slot.get("required") and not values.get(name)]
    if missing:
        raise PresetError(f"Missing required slots for {pattern_id}: " + ", ".join(missing))
    for name, slot in definitions.items():
        value = values.get(name)
        if slot.get("kind") in {"text-list", "metrics"} and value is not None:
            if not isinstance(value, list):
                raise PresetError(f"Slot {name!r} on {pattern_id} must be a list.")
            if len(value) < int(slot.get("minItems") or 0) or len(value) > int(slot.get("maxItems") or 10_000):
                raise PresetError(f"Slot {name!r} on {pattern_id} has the wrong number of items.")
    try:
        return SlidePlan(
            layout=str(definition["composerLayout"]), pattern_id=pattern_id, purpose=purpose,
            key_message=str(values.get("key_message") or values.get("headline") or ""),
            headline=str(values.get("headline") or ""), eyebrow=str(values.get("eyebrow") or ""),
            subtitle=str(values.get("subtitle") or ""), body=str(values.get("body") or ""),
            bullets=[str(value) for value in values.get("bullets") or []],
            metrics=[Metric.model_validate(value) for value in values.get("metrics") or []],
            quote=str(values.get("quote") or ""), attribution=str(values.get("attribution") or ""),
            code=str(values.get("code") or ""), language=str(values.get("language") or ""),
            caption=str(values.get("caption") or ""), speaker_notes=str(values.get("speaker_notes") or ""),
        )
    except (TypeError, ValueError) as error:
        raise PresetError(f"Content for {label or pattern_id!r} is invalid: {error}") from error


def motion_plan_from_preset(preset: dict[str, Any]) -> dict[str, Any]:
    """Resolve a reviewed named style into semantic per-slide intent."""
    style_id = str(preset.get("motionStyle") or "")
    style = (catalog().get("motionStyles") or {}).get(style_id)
    if not style:
        raise PresetError(f"No motion style named {style_id!r}.")
    return {
        "style": style_id,
        "slides": [
            {
                "index": index,
                "sequence": list(style.get("sequence") or []),
                "entrance": str(style.get("entrance") or "fade"),
                "pacing": str(style.get("pacing") or "measured"),
                "click_reveals": int(style.get("clickReveals") or 0),
            }
            for index, _slide in enumerate(preset.get("slides") or [])
        ],
    }
