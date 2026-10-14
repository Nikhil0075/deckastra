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
from .language_kit import _display_stack, _over_scene, _rows, _shape, _solid
from .models import SlideLayout, SlidePlan, StoryPlan

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
                size=22,
                weight=700,
                color="token:colors.accent",
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
    """A Swiss poster: the title is the picture.

    Measured from the design-system v3 concept (2026-10-14): two condensed lines
    filling the left half of the slide, a hairline grid the whole page answers
    to, an architectural photograph cut by the grid at the top right, one red
    disc straddling a grid line, a folio, and a small exhibit at the foot.
    """
    hair = _solid("token:colors.border")
    elements: list[dict[str, Any]] = [
        _shape("Modular grid", x=0, y=188, width=VIEWPORT_W, height=2, fill=hair),
        _shape("Modular grid", x=114, y=70, width=2, height=918, fill=hair),
        _shape("Modular grid", x=958, y=70, width=2, height=918, fill=hair),
        _shape("Modular grid", x=1438, y=418, width=2, height=570, fill=hair),
        _shape("Modular grid", x=1804, y=418, width=2, height=570, fill=hair),
        # A reviewed black-and-white photograph fills this frame in the flagship
        # decks; it bleeds off the top and the right, which is what makes it
        # cut by the grid rather than placed on it.
        _shape("Swiss architecture frame", x=1440, y=0, width=480, height=418,
               fill=_solid("#E9E9E6"), role="supportingVisual"),
        _shape("Signal rule", x=62, y=70, width=7, height=48, fill=_solid("token:colors.accent"), rotation=16),
    ]
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=134, y=74, width=640, height=34,
                              content=_rich_text(plan.eyebrow), token="caption", size=20, weight=600,
                              color="token:colors.foreground", letter_spacing=1, transform_case="uppercase", align="left"))
    # The display stack: as large as the half-page module allows, leading tight
    # enough that the two lines read as one block. The last line is the signal.
    elements.append(_display_stack(plan.headline, x=124, y=196, width=800, height=700, size=430, minimum=110,
                                   line_height=0.86, weight=400, letter_spacing=-1, transform_case="uppercase",
                                   accent="token:colors.accent"))
    folio = "".join(ch for ch in (plan.eyebrow or "").split("·")[-1] if ch.isdigit())[:2]
    if folio:
        elements.append(_text(role="decoration", x=972, y=200, width=120, height=96, content=_rich_text(folio.zfill(2)),
                              token="body", size=84, weight=300, align="left"))
        for i in range(12):
            elements.append(_shape("Folio leader", kind="ellipse", x=1092 + i * 17, y=246, width=5, height=5,
                                   fill=_solid("token:colors.foreground")))
    if plan.subtitle:
        elements.append(_swiss_body(plan.subtitle, first=1, span=1, y=324, height=110, size=26))
        elements[-1]["transform"].update({"x": 972, "width": 430})
    # The signal disc straddles the grid line at 1438: on the grid, not in a cell.
    elements.append(_shape("Signal disc", kind="ellipse", x=1268, y=452, width=340, height=340,
                           fill=_solid("token:colors.accent")))
    # A miniature exhibit at the foot of the headline column.
    for i, h in enumerate((26, 52, 36, 72, 86, 62, 40)):
        elements.append(_shape("Micro bar", x=144 + i * 29, y=972 - h, width=21, height=h,
                               fill=_solid("token:colors.accent" if i == 4 else "#B4B2AD")))
    elements.append(_shape("Micro baseline", x=140, y=973, width=210, height=2, fill=_solid("token:colors.foreground")))
    return elements


def swiss_statement(plan: SlidePlan) -> list[dict[str, Any]]:
    """The statement is the poster: a stack down the left, its proof in a column.

    Design-system v3 inside concept (2026-10-14): the words fill the height in
    one condensed block, last line red; a rule closes the block and the
    supporting sentence stands in its own narrow column at the foot.
    """
    elements = _swiss_index(plan)
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=176, width=1120, height=834, size=400, minimum=96,
                                   line_height=0.86, weight=400, letter_spacing=-1, transform_case="uppercase",
                                   accent="token:colors.accent", lines=3))
    elements.append(_shape("Column rule", x=1300, y=150, width=2, height=860, fill=_solid("token:colors.border")))
    if plan.subtitle or plan.body:
        elements.append(_shape("Grid rule", x=1350, y=780, width=450, height=2, fill=_solid("token:colors.foreground")))
        elements.append(_swiss_body(plan.subtitle or plan.body or "", first=1, span=1, y=806, height=204, size=34, muted=False))
        elements[-1]["transform"].update({"x": 1350, "width": 450})
        elements[-1]["fit"] = "shrinkToFit"
        elements[-1]["minFontSize"] = 22
    return elements


def swiss_bullets(plan: SlidePlan) -> list[dict[str, Any]]:
    """The heading stacked tall on the left; the items as numbered rows on the right."""
    elements = _swiss_index(plan)
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=184, width=800, height=826, size=280, minimum=72,
                                   line_height=0.88, weight=400, letter_spacing=-1, transform_case="uppercase", lines=4))
    elements.append(_shape("Column rule", x=980, y=150, width=2, height=860, fill=_solid("token:colors.border")))
    bullets = (plan.bullets or [])[:4]
    elements += _rows(bullets, x=1030, y=150, width=770, height=860, size=50, minimum=26, weight=600,
                      numbers=[f"{i + 1:02d}" for i in range(len(bullets))], number_width=120, number_size=130,
                      rule="token:colors.border", line_height=1.12)
    return elements


def swiss_metrics(plan: SlidePlan) -> list[dict[str, Any]]:
    """One figure, enormous and red; the rest large and black in a column beside it."""
    elements = _swiss_index(plan)
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=180, width=CONTENT_W, height=150, size=150, minimum=60,
                                   line_height=0.9, weight=400, transform_case="uppercase", lines=1))
    elements.append(_shape("Grid rule", x=CONTENT_X, y=340, width=CONTENT_W, height=3, fill=_solid("token:colors.foreground")))
    metrics = plan.metrics[:4]
    if metrics:
        hero, rest = metrics[0], metrics[1:]
        hero_w = 1060 if rest else CONTENT_W
        elements.append(_text(role="metric", x=CONTENT_X, y=366, width=hero_w, height=504, content=_rich_text(hero.value),
                              token="display", size=560, weight=400, color="token:colors.accent", fit="shrinkToFit",
                              min_font_size=160, line_height=0.92, letter_spacing=-6, align="left"))
        elements.append(_text(role="caption", x=CONTENT_X, y=880, width=hero_w, height=130, content=_rich_text(hero.label),
                              token="body", size=60, weight=600, fit="shrinkToFit", min_font_size=30, line_height=1.05, align="left"))
        if rest:
            elements.append(_shape("Column rule", x=1240, y=360, width=2, height=650, fill=_solid("token:colors.border")))
            cell = 650 / len(rest)
            for i, metric in enumerate(rest):
                top = 360 + i * cell
                if i:
                    elements.append(_shape("Row rule", x=1280, y=top, width=520, height=2, fill=_solid("token:colors.border")))
                elements.append(_text(role="metric", x=1280, y=top + 18, width=520, height=cell * 0.55, content=_rich_text(metric.value),
                                      token="display", size=220, weight=400, fit="shrinkToFit", min_font_size=60,
                                      line_height=0.92, align="left"))
                elements.append(_text(role="caption", x=1280, y=top + 18 + cell * 0.55, width=520, height=cell * 0.4 - 24,
                                      content=_rich_text(metric.label), token="body", size=46, weight=600, fit="shrinkToFit",
                                      min_font_size=22, line_height=1.05, align="left"))
    return elements


def swiss_quote(plan: SlidePlan) -> list[dict[str, Any]]:
    """The quote is the slide: a red mark, the words at poster size, the source under a rule."""
    elements = _swiss_index(plan)
    quote = plan.quote or plan.headline
    elements.append(_text(role="decoration", x=CONTENT_X - 8, y=150, width=200, height=230, content=_rich_text("“"),
                          token="display", size=220, weight=400, color="token:colors.accent", line_height=1, align="left"))
    elements.append(_text(role="quote", x=CONTENT_X, y=390, width=1500, height=510, content=_rich_text(quote), token="display",
                          size=170, weight=400, fit="shrinkToFit", min_font_size=56, line_height=0.95, align="left"))
    if plan.attribution:
        elements.append(_shape("Grid rule", x=CONTENT_X, y=930, width=CONTENT_W, height=2, fill=_solid("token:colors.foreground")))
        elements.append(_text(role="caption", x=CONTENT_X, y=950, width=1200, height=50, content=_rich_text(plan.attribution),
                              token="body", size=30, weight=700, align="left"))
    return elements


def swiss_split(plan: SlidePlan) -> list[dict[str, Any]]:
    """A photograph down the left half, edge to edge; the stack and its text on the right."""
    elements = [
        _shape("Split picture frame", x=0, y=0, width=900, height=VIEWPORT_H, fill=_solid("#E9E9E6"), role="supportingVisual"),
    ]
    if plan.eyebrow:
        elements.append(_shape("Signal rule", x=980, y=CONTENT_TOP + 20, width=96, height=12, fill=_solid("token:colors.accent")))
        elements.append(_text(role="eyebrow", x=980, y=CONTENT_TOP + 48, width=820, height=40, content=_rich_text(plan.eyebrow),
                              token="caption", size=22, weight=700, align="left"))
    elements.append(_display_stack(plan.headline, x=980, y=190, width=820, height=560, size=240, minimum=72,
                                   line_height=0.88, weight=400, transform_case="uppercase", lines=4))
    copy = plan.body or plan.subtitle or ("  ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_shape("Grid rule", x=980, y=790, width=820, height=2, fill=_solid("token:colors.foreground")))
        elements.append(_swiss_body(copy, first=1, span=1, y=814, height=196, size=32, muted=False))
        elements[-1]["transform"].update({"x": 980, "width": 820})
        elements[-1]["fit"] = "shrinkToFit"
        elements[-1]["minFontSize"] = 22
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
    """A noir title card: one photograph, the words in its shadow.

    Measured from the design-system v3 concept (2026-10-14). The photograph
    takes the right two thirds and fades into black where the title sits, so
    the figure stands clear of the words; the title is a stack of large serif
    capitals, a hairline, and three contact prints aligned under it.
    """
    elements = [
        # `preset_media.attach` places the reviewed image directly above this
        # frame and below the wash that follows.
        _shape("Image frame", x=640, y=0, width=1280, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _shape("Noir left wash", x=640, y=0, width=640, height=VIEWPORT_H, fill={"type": "linearGradient", "angle": 90, "stops": [
            {"offset": 0, "color": "token:colors.background"}, {"offset": 1, "color": "#0A0A0B00"},
        ]}),
    ]
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=124, y=150, width=760, height=36, content=_rich_text(plan.eyebrow), token="caption",
                              size=20, color="token:colors.accent", letter_spacing=8, transform_case="uppercase", align="left"))
    elements.append(_display_stack(plan.headline, x=124, y=206, width=900, height=420, size=240, minimum=90,
                                   line_height=0.94, weight=500, letter_spacing=2))
    elements.append(_shape("Hairline", x=124, y=650, width=300, height=2, fill=_solid("token:colors.foreground")))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=124, y=676, width=760, height=72, content=_rich_text(plan.subtitle), token="body",
                              size=26, color="token:colors.foregroundMuted", line_height=1.35, align="left"))
    # Three contact prints, square, aligned to the title's left edge.
    for i in range(3):
        elements.append(_shape("Contact print", x=124 + i * 228, y=772, width=196, height=196,
                               fill=_solid("#171717"), role="supportingVisual"))
    return _over_scene(elements, {"Image frame"})


def _noir_scene(name: str, *, x: float, width: float) -> list[dict[str, Any]]:
    """A photograph washed to black from the left, so words can stand on it."""
    return [
        _shape(name, x=x, y=0, width=width, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _shape("Noir scene wash", x=x, y=0, width=width, height=VIEWPORT_H, fill={"type": "linearGradient", "angle": 90, "stops": [
            {"offset": 0, "color": "token:colors.background"}, {"offset": 0.55, "color": "#0A0A0BCC"}, {"offset": 1, "color": "#0A0A0B55"},
        ]}),
    ]


def noir_statement(plan: SlidePlan) -> list[dict[str, Any]]:
    """A line of dialogue over a scene: the photograph behind, the words in its shadow.

    Design-system v3 inside concept (2026-10-14): a full-bleed photograph washed
    to black on the left, a large serif stack, a hairline across the frame and
    the supporting sentence beneath it.
    """
    elements = _noir_scene("Noir scene frame", x=0, width=VIEWPORT_W)
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=136, y=180, width=900, height=40, content=_rich_text(plan.eyebrow), token="caption",
                              size=24, color="token:colors.accent", letter_spacing=6, transform_case="uppercase", align="left"))
    elements.append(_display_stack(plan.headline, x=136, y=240, width=1180, height=480, size=230, minimum=80,
                                   line_height=1.0, weight=500))
    if plan.subtitle or plan.body:
        elements.append(_shape("Hairline", x=136, y=790, width=1648, height=2, fill=_solid("token:colors.accent"), opacity=0.7))
        elements.append(_text(role="subtitle", x=136, y=820, width=1500, height=110, content=_rich_text(plan.subtitle or plan.body or ""),
                              token="body", size=40, color="token:colors.foreground", fit="shrinkToFit", min_font_size=24,
                              line_height=1.3, align="left"))
    return _over_scene(elements, {"Noir scene frame"})


def noir_bullets(plan: SlidePlan) -> list[dict[str, Any]]:
    """A case file: the heading, numbered entries under hairlines, a photographic strip."""
    elements = [
        _shape("Noir strip frame", x=1520, y=0, width=400, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    if plan.eyebrow:
        elements.append(_noir_eyebrow(plan.eyebrow, 90))
        elements[-1]["transform"].update({"x": 136, "width": 1200})
        elements[-1]["paragraph"] = {"align": "left"}
    elements.append(_display_stack(plan.headline, x=136, y=140, width=1260, height=300, size=130, minimum=60,
                                   line_height=1.02, weight=500, lines=2))
    bullets = (plan.bullets or [])[:3]
    numerals = ["I.", "II.", "III.", "IV."]
    elements += _rows(bullets, x=136, y=490, width=1260, height=480, size=46, minimum=26, token="body",
                      numbers=numerals[:len(bullets)], number_width=110, number_size=58, number_token="display",
                      number_color="token:colors.accent", rule="#EFE9DE40", line_height=1.25)
    return elements


def noir_metrics(plan: SlidePlan) -> list[dict[str, Any]]:
    """Exhibit A: the figure in gold, as large as the frame allows; the others beside it."""
    elements: list[dict[str, Any]] = []
    elements.append(_display_stack(plan.headline, x=136, y=110, width=1650, height=170, size=130, minimum=56,
                                   line_height=1.0, weight=500, lines=1))
    metrics = plan.metrics[:4]
    if metrics:
        hero, rest = metrics[0], metrics[1:]
        hero_w = 1060 if rest else 1650
        elements.append(_text(role="metric", x=136, y=330, width=hero_w, height=470, content=_rich_text(hero.value), token="display",
                              size=440, weight=500, color="token:colors.accent", fit="shrinkToFit", min_font_size=140,
                              line_height=1.0, align="center"))
        elements.append(_text(role="caption", x=136, y=820, width=hero_w, height=90, content=_rich_text(hero.label), token="body",
                              size=60, color="token:colors.foreground", fit="shrinkToFit", min_font_size=28, align="center"))
        if rest:
            elements.append(_shape("Hairline", x=1290, y=360, width=2, height=560, fill=_solid("token:colors.accent"), opacity=0.6))
            cell = 560 / len(rest)
            for i, metric in enumerate(rest):
                top = 360 + i * cell
                if i:
                    elements.append(_shape("Hairline", x=1360, y=top, width=420, height=2, fill=_solid("token:colors.accent"), opacity=0.6))
                elements.append(_text(role="metric", x=1340, y=top + 20, width=460, height=cell * 0.58, content=_rich_text(metric.value),
                                      token="display", size=170, weight=500, fit="shrinkToFit", min_font_size=56, line_height=1.0, align="center"))
                elements.append(_text(role="caption", x=1340, y=top + 20 + cell * 0.58, width=460, height=cell * 0.32,
                                      content=_rich_text(metric.label), token="body", size=36, color="token:colors.foregroundMuted",
                                      fit="shrinkToFit", min_font_size=20, align="center"))
    return elements


def noir_quote(plan: SlidePlan) -> list[dict[str, Any]]:
    """A confession: the words on the left in large serif, a face in shadow on the right."""
    elements = [
        _shape("Noir portrait frame", x=1180, y=0, width=740, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _shape("Noir portrait wash", x=1180, y=0, width=360, height=VIEWPORT_H, fill={"type": "linearGradient", "angle": 90, "stops": [
            {"offset": 0, "color": "token:colors.background"}, {"offset": 1, "color": "#0A0A0B00"},
        ]}),
    ]
    quote = plan.quote or plan.headline
    elements.append(_text(role="quote", x=136, y=210, width=1180, height=620, content=_rich_text(f"“{quote}”"), token="display",
                          size=130, weight=500, fit="shrinkToFit", min_font_size=52, line_height=1.08, align="left"))
    if plan.attribution:
        elements.append(_shape("Hairline", x=136, y=880, width=880, height=2, fill=_solid("token:colors.accent"), opacity=0.8))
        elements.append(_text(role="caption", x=136, y=906, width=1000, height=50, content=_rich_text(plan.attribution), token="caption",
                              size=28, color="token:colors.accent", letter_spacing=4, transform_case="uppercase", align="left"))
    return _over_scene(elements, {"Noir portrait frame"})


def noir_split(plan: SlidePlan) -> list[dict[str, Any]]:
    """A photograph on the left half, edge to edge; the scene's line on the right."""
    elements = [
        _shape("Image frame", x=0, y=0, width=920, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=1040, y=200, width=760, height=40, content=_rich_text(plan.eyebrow), token="caption",
                              size=22, color="token:colors.accent", letter_spacing=6, transform_case="uppercase", align="left"))
    elements.append(_display_stack(plan.headline, x=1040, y=260, width=760, height=420, size=170, minimum=60,
                                   line_height=1.02, weight=500, lines=3))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=1040, y=720, width=740, height=220, content=_rich_text(copy), token="body", size=36,
                              color="token:colors.foreground", fit="shrinkToFit", min_font_size=22, line_height=1.4, align="left"))
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


def apply_density(plan: StoryPlan, language: str) -> tuple[StoryPlan, list[str]]:
    """Hold a caller's plan to the language's density, and say what was done.

    A language's `forbid` list is prose for an agent to follow; the parts of it
    a composer can check are counts. More bullets than the language allows are
    dropped, because drawing them would break the grammar the person chose;
    a headline over the language's limit is kept and named, because shortening
    someone's words is theirs to do. Either way the caller is told.
    """
    from . import presets

    density = ((presets.catalog().get("designLanguages") or {}).get(language) or {}).get("density") or {}
    max_bullets = int(density.get("maxBullets") or 0)
    max_words = int(density.get("maxHeadlineWords") or 0)
    warnings: list[str] = []
    slides = []
    for index, slide in enumerate(plan.slides, start=1):
        if max_bullets and len(slide.bullets) > max_bullets:
            warnings.append(f"Slide {index}: {language} shows at most {max_bullets} bullets, so the last {len(slide.bullets) - max_bullets} were left out.")
            slide = slide.model_copy(update={"bullets": slide.bullets[:max_bullets]})
        words = len(slide.headline.split())
        if max_words and words > max_words:
            warnings.append(f"Slide {index}: the headline has {words} words; {language} reads best at {max_words} or fewer.")
        slides.append(slide)
    return plan.model_copy(update={"slides": slides}), warnings


def layout_for(language: str, layout: SlideLayout) -> Layout | None:
    """The language's own layout, or None to use the neutral composer's."""
    if language not in LANGUAGE_LAYOUTS:
        raise UnknownLanguage(f'"{language}" is not a design language this build composes.')
    return LANGUAGE_LAYOUTS[language].get(layout)
