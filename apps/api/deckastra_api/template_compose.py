"""Turning a reviewed template into a document, for creating and for previewing.

`POST /v1/decks/from-template` stores what this composes. `POST /v1/presets/{id}
/preview` returns it and stores nothing (UI audit 2026-10-10, unit 2): the
template gallery used to draw every card as the same CSS mock, so templates that
compose very differently looked alike, and templates that compose alike looked
like a catalogue. A preview is the real composer's output, drawn by the same
renderer an export uses.

One function for both, so a preview cannot drift from the deck "Use template"
then makes: a gallery that shows one composition and creates another is worse
than no preview at all.
"""

from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from functools import lru_cache
import hashlib
import json
import threading
from typing import Any

from . import motion, preset_media, presets
from .compose import compose_document

#: A content map is the person's words for a handful of slots; this is far more
#: than any template needs, and a bound on what one request can make us compose.
MAX_CONTENT_BYTES = 64 * 1024


def compose_template(
    template_id: str,
    *,
    theme_key: str | None = None,
    title: str | None = None,
    content: dict[str, dict[str, object]] | None = None,
) -> dict[str, Any]:
    """The document a template becomes. Raises `presets.PresetError` for a caller fix."""
    preset = presets.find_preset(template_id)
    plan = presets.story_plan_from_preset(preset, title=title, content=content or {})
    theme, theme_id = presets.resolve_theme(theme_key or str(preset["themeKey"]))
    motion_plan = presets.motion_plan_from_preset(preset)

    language = str(preset.get("designLanguage") or "neutral")
    document = compose_document(
        plan,
        instruction=f"Deck template: {template_id}",
        motion_plan=motion_plan,
        theme_definition=theme,
        theme_id=theme_id,
        language=language,
        language_version=presets.language_version(language),
    )
    document.setdefault("metadata", {})["templateId"] = template_id
    document["metadata"]["motionStyle"] = str(preset["motionStyle"])
    # A template's delivery direction is part of the resulting deck, not just
    # gallery copy. Narration resolves the default provider voice from this
    # style while an explicitly selected cue or request voice still wins.
    document["metadata"]["voiceStyle"] = str(preset.get("voiceStyle") or "")
    previous_slide = None
    pacing = str((motion_plan.get("slides") or [{}])[0].get("pacing") or "measured")
    for slide in document.get("slides") or []:
        transition, _warnings = motion.plan_transition(
            previous_slide,
            slide,
            str(preset.get("transitionStyle") or "fade"),
            pacing,
        )
        if transition is not None:
            slide["transition"] = transition
        previous_slide = slide
    # The template's own pictures in the frames its language drew (unit 7b).
    return preset_media.attach(document, template_id)


@lru_cache(maxsize=1)
def catalog_revision() -> str:
    """Which catalog a preview was composed from: the template and theme files.

    In a cache key so an updated catalog can never be answered from a preview of
    the old one. Read once per process, because the files ship with the build.
    """
    digest = hashlib.sha256()
    for path in (presets.PRESETS_PATH, presets.THEMES_PATH):
        digest.update(path.read_bytes())
    # The pictures are part of what a preview shows.
    manifest = preset_media.media_dir() / "MANIFEST.json"
    if manifest.exists():
        digest.update(manifest.read_bytes())
    return digest.hexdigest()[:16]


def content_size(content: dict[str, dict[str, object]] | None) -> int:
    return len(json.dumps(content or {}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def preview_key(template_id: str, theme_key: str | None, slides: str) -> str:
    """The cache and ETag key. Only previews without the person's words are cached."""
    # A new version of the template's language composes differently, so it is a
    # different preview.
    language_version = str(template_language_version(template_id) or "")
    raw = "\x1f".join([template_id, theme_key or "", language_version, catalog_revision(), slides])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def template_language_version(template_id: str) -> int | None:
    """The version of the language a template composes in, or None if it is not known."""
    try:
        preset = presets.find_preset(template_id)
    except presets.PresetError:
        return None
    return presets.language_version(str(preset.get("designLanguage") or "neutral"))


class _PreviewCache:
    """A small in-process LRU of composed previews.

    A gallery asks for 24 covers every time it opens, and composing is the same
    work each time for the same template and theme. Bounded, because a preview
    holds a whole document; thread-safe, because uvicorn serves sync routes from
    a pool.
    """

    def __init__(self, limit: int = 200) -> None:
        self._limit = limit
        self._items: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            found = self._items.get(key)
            if found is not None:
                self._items.move_to_end(key)
            return deepcopy(found) if found is not None else None

    def put(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._items[key] = deepcopy(value)
            self._items.move_to_end(key)
            while len(self._items) > self._limit:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


PREVIEWS = _PreviewCache()


def preview(
    template_id: str,
    *,
    theme_key: str | None,
    content: dict[str, dict[str, object]] | None,
    slides: str,
) -> tuple[dict[str, Any], str | None]:
    """The preview body and its ETag (None when it carries the person's words)."""
    cacheable = not content
    key = preview_key(template_id, theme_key, slides) if cacheable else None
    if key is not None:
        hit = PREVIEWS.get(key)
        if hit is not None:
            return hit, key
    document = compose_template(template_id, theme_key=theme_key, content=content)
    if slides == "cover":
        # The card needs the first slide; the rest is the detail drawer's.
        # Transitions name the slide before them, so the cover keeps none.
        document["slides"] = [dict(slide) for slide in (document.get("slides") or [])[:1]]
        for slide in document["slides"]:
            slide.pop("transition", None)
    body = {
        "template_id": template_id,
        "catalog_revision": catalog_revision(),
        "language_version": template_language_version(template_id),
        "slides": slides,
        "document": document,
    }
    if key is not None:
        PREVIEWS.put(key, body)
    return body, key
