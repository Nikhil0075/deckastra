"""Design-language geometry: how each language lays out the composer's layouts.

The language *contract* (rules, axes, defaults) is data in
`packages/deck-presets/src/languages.ts`, for the gallery and for agents. The
*geometry* lives here, in code, because geometry is the composer's job and never
a caller's (CLAUDE.md: "callers provide intent, code composes geometry").

Each language supplies its own version of the layouts it changes, built from
the composer's own helpers. A layout a language does not supply falls back to
the neutral composer, never to a guess. The neutral composer is untouched by
this module: `tests/goldens/compose_neutral.json` holds every neutral template's
document hash, and a change here cannot move one.

Grounding for the two pilots is in
`docs/design-audit/research/2026-10-10-design-languages.md`:

- **Swiss Signal** follows the International Typographic Style: an asymmetric
  12-column grid, flush-left ragged-right type, grotesque display type far
  larger than the body (a golden-ratio scale), black and white with one red
  signal, square corners, numbered sections.
- **Cinema Noir** follows the film-noir title card: near-black frames held
  between letterbox bars, a high-contrast serif set centred, one warm light
  (a radial "spotlight" behind the words), hairline rules, few words.
"""

from __future__ import annotations

from typing import Any, Callable

from .compose import (
    CONTENT_BOTTOM,
    CONTENT_TOP,
    CONTENT_W,
    CONTENT_X,
    SAFE,
    VIEWPORT_H,
    VIEWPORT_W,
    _rich_list,
    _rich_text,
    _text,
)
from .language_kit import _shape, _solid
from .models import SlideLayout, SlidePlan

Layout = Callable[[SlidePlan], list[dict[str, Any]]]


# ------------------------------------------------------------------ swiss signal
#
# Twelve columns across the safe area with 24px gutters: a column is 118px. The
# grid is what makes the asymmetry deliberate: text occupies a block of columns
# and the rest is space or the red signal.

SWISS_GUTTER = 24
SWISS_COLUMN = (CONTENT_W - SWISS_GUTTER * 11) / 12


def _cols(first: int, span: int) -> tuple[float, float]:
    """x and width of `span` columns starting at column `first` (1-based)."""
    x = CONTENT_X + (first - 1) * (SWISS_COLUMN + SWISS_GUTTER)
    return x, span * SWISS_COLUMN + (span - 1) * SWISS_GUTTER


def _swiss_index(plan: SlidePlan) -> list[dict[str, Any]]:
    """The section number and its red rule, top left: the index is part of the layout."""
    out = [
        _shape("Signal rule", x=CONTENT_X, y=CONTENT_TOP + 20, width=96, height=12, fill=_solid("token:colors.accent")),
    ]
    if plan.eyebrow:
        x, width = _cols(1, 3)
        out.append(
            _text(
                role="eyebrow",
                x=x,
                y=CONTENT_TOP + 48,
                width=width,
                height=44,
                content=_rich_text(plan.eyebrow),
                token="caption",
                size=26,
                weight=700,
                color="token:colors.foreground",
            )
        )
    return out


def _swiss_display(text: str, *, first: int, span: int, y: float, size: float, height: float, minimum: float) -> dict[str, Any]:
    x, width = _cols(first, span)
    return _text(
        role="headline",
        x=x,
        y=y,
        width=width,
        height=height,
        content=_rich_text(text),
        token="display",
        size=size,
        weight=800,
        fit="shrinkToFit",
        min_font_size=minimum,
        line_height=0.95,
        letter_spacing=-2,
        transform_case="uppercase",
        align="left",
    )


def _swiss_body(text: str, *, first: int, span: int, y: float, height: float, size: float = 28, muted: bool = True) -> dict[str, Any]:
    x, width = _cols(first, span)
    return _text(
        role="subtitle",
        x=x,
        y=y,
        width=width,
        height=height,
        content=_rich_text(text),
        token="body",
        size=size,
        color="token:colors.foregroundMuted" if muted else "token:colors.foreground",
        line_height=1.35,
        align="left",
    )


def swiss_title(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _swiss_index(plan)
    # The signal: one red disc, cut by the right edge of the grid.
    elements.append(
        _shape(
            "Signal disc",
            kind="ellipse",
            x=CONTENT_X + CONTENT_W - 470,
            y=330,
            width=560,
            height=560,
            fill=_solid("token:colors.accent"),
        )
    )
    elements.append(_swiss_display(plan.headline, first=1, span=8, y=300, size=168, height=420, minimum=88))
    if plan.subtitle:
        elements.append(_swiss_body(plan.subtitle, first=1, span=6, y=820, height=96))
    return elements


def swiss_statement(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _swiss_index(plan)
    elements.append(_swiss_display(plan.headline, first=1, span=9, y=300, size=132, height=360, minimum=72))
    # A black rule across the grid: the line the statement stands on.
    elements.append(_shape("Grid rule", x=CONTENT_X, y=720, width=CONTENT_W, height=4, fill=_solid("token:colors.foreground")))
    if plan.subtitle or plan.body:
        elements.append(_swiss_body(plan.subtitle or plan.body or "", first=7, span=6, y=760, height=180))
    return elements


def swiss_bullets(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _swiss_index(plan)
    elements.append(_swiss_display(plan.headline, first=1, span=4, y=200, size=72, height=420, minimum=44))
    # A vertical rule between the headline block and the list.
    rule_x, _ = _cols(5, 1)
    elements.append(_shape("Column rule", x=rule_x + SWISS_COLUMN / 2, y=200, width=3, height=CONTENT_BOTTOM - 240, fill=_solid("token:colors.foreground")))
    bullets = (plan.bullets or [])[:4]
    if bullets:
        x, width = _cols(6, 7)
        elements.append(
            _text(
                role="body",
                x=x,
                y=200,
                width=width,
                height=min(CONTENT_BOTTOM - 240, len(bullets) * 120 + 40),
                content=_rich_list(bullets, "numbered"),
                token="body",
                size=36,
                weight=500,
                line_height=1.45,
                align="left",
            )
        )
    if plan.subtitle:
        elements.append(_swiss_body(plan.subtitle, first=1, span=4, y=660, height=200, size=24))
    return elements


def swiss_metrics(plan: SlidePlan) -> list[dict[str, Any]]:
    """One figure, very large, in red: Swiss data shows the number that matters, not a row of equals."""
    elements = _swiss_index(plan)
    x, width = _cols(1, 7)
    elements.append(
        _text(
            role="headline",
            x=x,
            y=200,
            width=width,
            height=120,
            content=_rich_text(plan.headline),
            token="h1",
            size=48,
            weight=800,
            fit="shrinkToFit",
            min_font_size=32,
            transform_case="uppercase",
            letter_spacing=-1,
            align="left",
        )
    )
    metrics = plan.metrics[:4]
    if metrics:
        hero = metrics[0]
        hx, hwidth = _cols(1, 8)
        elements.append(
            _text(
                role="metric",
                x=hx,
                y=340,
                width=hwidth,
                height=360,
                content=_rich_text(hero.value),
                token="metric",
                size=320,
                weight=800,
                color="token:colors.accent",
                fit="shrinkToFit",
                min_font_size=140,
                line_height=0.9,
                letter_spacing=-8,
                align="left",
            )
        )
        elements.append(_swiss_body(hero.label, first=1, span=6, y=720, height=90, size=30, muted=False))
        # The rest as an index, small and black, on the right of the grid.
        for i, metric in enumerate(metrics[1:]):
            mx, mwidth = _cols(10, 3)
            y = 360 + i * 170
            elements.append(
                _text(
                    role="metric",
                    x=mx,
                    y=y,
                    width=mwidth,
                    height=80,
                    content=_rich_text(metric.value),
                    token="metric",
                    size=60,
                    weight=800,
                    fit="shrinkToFit",
                    min_font_size=32,
                    align="left",
                )
            )
            elements.append(
                _text(
                    role="caption",
                    x=mx,
                    y=y + 84,
                    width=mwidth,
                    height=60,
                    content=_rich_text(metric.label),
                    token="caption",
                    size=18,
                    color="token:colors.foregroundMuted",
                    align="left",
                )
            )
    if plan.caption:
        elements.append(_swiss_body(plan.caption, first=1, span=8, y=860, height=60, size=20))
    return elements


def swiss_quote(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _swiss_index(plan)
    quote = plan.quote or plan.headline
    mark_x, _ = _cols(1, 2)
    elements.append(
        _text(
            role="decoration",
            x=mark_x,
            y=180,
            width=240,
            # One line at line-height 1 is the full 360px; a shorter box clips
            # the mark (W103), which the preview sheet found.
            height=380,
            content=_rich_text("“"),
            token="display",
            size=360,
            weight=800,
            color="token:colors.accent",
            line_height=1,
            align="left",
        )
    )
    x, width = _cols(3, 9)
    elements.append(
        _text(
            role="quote",
            x=x,
            y=300,
            width=width,
            height=420,
            content=_rich_text(quote),
            token="quote",
            size=60,
            weight=700,
            fit="shrinkToFit",
            min_font_size=34,
            line_height=1.15,
            align="left",
        )
    )
    if plan.attribution:
        ax, awidth = _cols(3, 6)
        elements.append(
            _text(
                role="caption",
                x=ax,
                y=760,
                width=awidth,
                height=50,
                content=_rich_text(plan.attribution),
                token="caption",
                size=22,
                weight=700,
                color="token:colors.foreground",
                transform_case="uppercase",
                letter_spacing=2,
                align="left",
            )
        )
    return elements


def swiss_split(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _swiss_index(plan)
    elements.append(_swiss_display(plan.headline, first=1, span=12, y=190, size=88, height=200, minimum=52))
    # Two blocks of six columns, each under a black rule: the comparison is the grid.
    for first in (1, 7):
        x, width = _cols(first, 6)
        elements.append(_shape("Block rule", x=x, y=430, width=width, height=6, fill=_solid("token:colors.foreground")))
    if plan.body:
        elements.append(_swiss_body(plan.body, first=1, span=5, y=470, height=CONTENT_BOTTOM - 510, size=28, muted=False))
    bullets = (plan.bullets or [])[:4]
    if bullets:
        x, width = _cols(7, 6)
        elements.append(
            _text(
                role="body",
                x=x,
                y=470,
                width=width,
                height=min(CONTENT_BOTTOM - 510, len(bullets) * 80 + 40),
                content=_rich_list(bullets),
                token="body",
                size=28,
                line_height=1.45,
                align="left",
            )
        )
    return elements


# ------------------------------------------------------------------ cinema noir
#
# Letterbox bars take the frame to a widescreen picture; everything sits between
# them, centred. One warm spotlight sits behind the words: the only light.

NOIR_BAR = 116
NOIR_TOP = NOIR_BAR
NOIR_BOTTOM = VIEWPORT_H - NOIR_BAR
NOIR_COLUMN = 1200
NOIR_X = (VIEWPORT_W - NOIR_COLUMN) / 2


def _noir_frame(spot_y: float = VIEWPORT_H / 2) -> list[dict[str, Any]]:
    """The letterbox and the light, drawn first so everything sits on them."""
    spot_w, spot_h = 1500, 900
    return [
        _shape(
            "Spotlight",
            kind="ellipse",
            x=(VIEWPORT_W - spot_w) / 2,
            y=spot_y - spot_h / 2,
            width=spot_w,
            height=spot_h,
            fill={
                "type": "radialGradient",
                "stops": [
                    {"offset": 0, "color": "token:colors.surfaceAlt"},
                    {"offset": 1, "color": "token:colors.background"},
                ],
            },
        ),
        _shape("Letterbox top", x=0, y=0, width=VIEWPORT_W, height=NOIR_BAR, fill=_solid("#000000")),
        _shape("Letterbox bottom", x=0, y=NOIR_BOTTOM, width=VIEWPORT_W, height=NOIR_BAR, fill=_solid("#000000")),
    ]


def _noir_eyebrow(text: str, y: float) -> dict[str, Any]:
    return _text(
        role="eyebrow",
        x=NOIR_X,
        y=y,
        width=NOIR_COLUMN,
        height=40,
        content=_rich_text(text),
        token="caption",
        size=20,
        color="token:colors.accent",
        letter_spacing=8,
        transform_case="uppercase",
        align="center",
    )


def _noir_hairline(y: float, width: float = 220) -> dict[str, Any]:
    return _shape("Hairline", x=(VIEWPORT_W - width) / 2, y=y, width=width, height=2, fill=_solid("token:colors.accent"))


def _noir_display(text: str, *, y: float, size: float, height: float, minimum: float) -> dict[str, Any]:
    return _text(
        role="headline",
        x=NOIR_X,
        y=y,
        width=NOIR_COLUMN,
        height=height,
        content=_rich_text(text),
        token="display",
        size=size,
        weight=600,
        fit="shrinkToFit",
        min_font_size=minimum,
        line_height=1.08,
        letter_spacing=1,
        align="center",
    )


def _noir_line(text: str, *, y: float, height: float, size: float = 28, role: str = "subtitle") -> dict[str, Any]:
    return _text(
        role=role,
        x=NOIR_X + 120,
        y=y,
        width=NOIR_COLUMN - 240,
        height=height,
        content=_rich_text(text),
        token="body",
        size=size,
        color="token:colors.foregroundMuted",
        line_height=1.45,
        align="center",
    )


def noir_title(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _noir_frame(spot_y=520)
    if plan.eyebrow:
        elements.append(_noir_eyebrow(plan.eyebrow, 300))
    elements.append(_noir_display(plan.headline, y=360, size=128, height=290, minimum=64))
    elements.append(_noir_hairline(684))
    if plan.subtitle:
        elements.append(_noir_line(plan.subtitle, y=716, height=90, size=30))
    return elements


def noir_statement(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _noir_frame()
    if plan.eyebrow:
        elements.append(_noir_eyebrow(plan.eyebrow, 300))
    elements.append(_noir_display(plan.headline, y=360, size=96, height=260, minimum=52))
    if plan.subtitle or plan.body:
        elements.append(_noir_hairline(650, 120))
        elements.append(_noir_line(plan.subtitle or plan.body or "", y=680, height=150))
    return elements


def noir_bullets(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _noir_frame()
    if plan.eyebrow:
        elements.append(_noir_eyebrow(plan.eyebrow, NOIR_TOP + 70))
    elements.append(_noir_display(plan.headline, y=NOIR_TOP + 120, size=68, height=170, minimum=40))
    elements.append(_noir_hairline(NOIR_TOP + 310, 160))
    bullets = (plan.bullets or [])[:3]
    if bullets:
        # Three lines at most, centred: dialogue, not a list of features.
        elements.append(
            _text(
                role="body",
                x=NOIR_X + 150,
                y=NOIR_TOP + 350,
                width=NOIR_COLUMN - 300,
                height=min(NOIR_BOTTOM - NOIR_TOP - 400, len(bullets) * 96 + 40),
                content=_rich_list(bullets, "paragraph"),
                token="body",
                size=34,
                color="token:colors.foreground",
                line_height=1.6,
                align="center",
            )
        )
    return elements


def noir_metrics(plan: SlidePlan) -> list[dict[str, Any]]:
    """Exhibit A: one figure in the light, what it means beneath it."""
    elements = _noir_frame()
    if plan.eyebrow:
        elements.append(_noir_eyebrow(plan.eyebrow, NOIR_TOP + 70))
    metrics = plan.metrics[:4]
    if metrics:
        hero = metrics[0]
        elements.append(
            _text(
                role="metric",
                x=NOIR_X,
                y=NOIR_TOP + 140,
                width=NOIR_COLUMN,
                height=300,
                content=_rich_text(hero.value),
                token="metric",
                size=240,
                weight=600,
                color="token:colors.accent",
                fit="shrinkToFit",
                min_font_size=120,
                line_height=1,
                align="center",
            )
        )
        elements.append(_noir_display(plan.headline, y=NOIR_TOP + 470, size=52, height=130, minimum=34))
        elements.append(_noir_line(hero.label, y=NOIR_TOP + 610, height=60, size=26, role="caption"))
        rest = " · ".join(f"{metric.value} {metric.label}" for metric in metrics[1:])
        if rest:
            elements.append(_noir_line(rest, y=NOIR_BOTTOM - 110, height=50, size=20, role="caption"))
    else:
        elements.append(_noir_display(plan.headline, y=400, size=84, height=240, minimum=48))
    return elements


def noir_quote(plan: SlidePlan) -> list[dict[str, Any]]:
    elements = _noir_frame()
    quote = plan.quote or plan.headline
    if plan.eyebrow:
        elements.append(_noir_eyebrow(plan.eyebrow, NOIR_TOP + 90))
    elements.append(
        _text(
            role="quote",
            x=NOIR_X,
            y=NOIR_TOP + 170,
            width=NOIR_COLUMN,
            height=420,
            content=_rich_text(f"“{quote}”"),
            token="quote",
            size=62,
            weight=500,
            fit="shrinkToFit",
            min_font_size=34,
            line_height=1.3,
            align="center",
        )
    )
    if plan.attribution:
        elements.append(_noir_hairline(NOIR_TOP + 620, 120))
        elements.append(
            _text(
                role="caption",
                x=NOIR_X,
                y=NOIR_TOP + 650,
                width=NOIR_COLUMN,
                height=50,
                content=_rich_text(plan.attribution),
                token="caption",
                size=22,
                color="token:colors.foregroundMuted",
                letter_spacing=6,
                transform_case="uppercase",
                align="center",
            )
        )
    return elements


def noir_split(plan: SlidePlan) -> list[dict[str, Any]]:
    """A frame for a photograph on the left (unit 7 brings the pictures), the scene on the right."""
    elements = _noir_frame()
    frame_x, frame_w = CONTENT_X, 760
    elements.append(
        _shape(
            "Image frame",
            x=frame_x,
            y=NOIR_TOP + 60,
            width=frame_w,
            height=NOIR_BOTTOM - NOIR_TOP - 120,
            fill=_solid("token:colors.surfaceAlt"),
            role="supportingVisual",
        )
    )
    text_x = frame_x + frame_w + 96
    text_w = VIEWPORT_W - SAFE["right"] - text_x
    if plan.eyebrow:
        elements.append(
            _text(
                role="eyebrow",
                x=text_x,
                y=NOIR_TOP + 100,
                width=text_w,
                height=40,
                content=_rich_text(plan.eyebrow),
                token="caption",
                size=20,
                color="token:colors.accent",
                letter_spacing=8,
                transform_case="uppercase",
                align="left",
            )
        )
    elements.append(
        _text(
            role="headline",
            x=text_x,
            y=NOIR_TOP + 160,
            width=text_w,
            height=220,
            content=_rich_text(plan.headline),
            token="display",
            size=64,
            weight=600,
            fit="shrinkToFit",
            min_font_size=38,
            line_height=1.1,
            align="left",
        )
    )
    copy = plan.body or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(
            _text(
                role="body",
                x=text_x,
                y=NOIR_TOP + 420,
                width=text_w,
                height=NOIR_BOTTOM - NOIR_TOP - 480,
                content=_rich_text(copy),
                token="body",
                size=28,
                color="token:colors.foregroundMuted",
                line_height=1.55,
                align="left",
            )
        )
    return elements


#: The layouts each language composes differently. Anything absent falls back
#: to the neutral composer: code listings, for instance, read the same in both.
LANGUAGE_LAYOUTS: dict[str, dict[SlideLayout, Layout]] = {
    "neutral": {},
    "swiss-signal": {
        SlideLayout.TITLE: swiss_title,
        SlideLayout.STATEMENT: swiss_statement,
        SlideLayout.BULLETS: swiss_bullets,
        SlideLayout.METRICS: swiss_metrics,
        SlideLayout.QUOTE: swiss_quote,
        SlideLayout.SPLIT: swiss_split,
    },
    "cinema-noir": {
        SlideLayout.TITLE: noir_title,
        SlideLayout.STATEMENT: noir_statement,
        SlideLayout.BULLETS: noir_bullets,
        SlideLayout.METRICS: noir_metrics,
        SlideLayout.QUOTE: noir_quote,
        SlideLayout.SPLIT: noir_split,
    },
}


# The six after the pilots (unit 7a) live in their own module, so this one stays
# the pilots and the registry.
from .languages_more import MORE_LANGUAGE_LAYOUTS  # noqa: E402

LANGUAGE_LAYOUTS.update(MORE_LANGUAGE_LAYOUTS)


class UnknownLanguage(ValueError):
    """A language the composer has no geometry for."""


def layout_for(language: str, layout: SlideLayout) -> Layout | None:
    """The language's own layout, or None to use the neutral composer's."""
    if language not in LANGUAGE_LAYOUTS:
        raise UnknownLanguage(f'"{language}" is not a design language this build composes.')
    return LANGUAGE_LAYOUTS[language].get(layout)
