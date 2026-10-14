"""The six design languages after the two pilots (UI audit 2026-10-10, unit 7a).

Same model as `languages.py`: each language supplies its own version of the
layouts it changes, and anything absent falls back to the neutral composer. The
contract each one follows (rules, axes, defaults) is data in
`packages/deck-presets/src/languages.ts`; the reasoning is in
`docs/design-audit/research/2026-10-10-design-languages.md`.

Every element stays inside the 1920×1080 slide and text never overlaps text:
`tests/test_design_languages.py` holds both, for every layout in every language.
Motifs are decoration by role, so motion and the overlap check leave them be.
Colours are theme tokens, so a language follows whichever theme a template or a
person picks; literal colours appear only where the motif *is* the colour (a
terminal's window buttons).
"""

from __future__ import annotations

import math
from typing import Any

from .ids import new_id
from .compose import CONTENT_BOTTOM, CONTENT_TOP, CONTENT_W, CONTENT_X, VIEWPORT_H, VIEWPORT_W, _rich_list, _rich_text
from .language_kit import _clipped_circle, _display_stack, _line, _none, _over_scene, _path, _radial, _rotated, _rows, _shape, _solid, _text
from .models import SlideLayout, SlidePlan

Elements = list[dict[str, Any]]
RIGHT = CONTENT_X + CONTENT_W


def _bullets(plan: SlidePlan, limit: int) -> list[str]:
    return (plan.bullets or [])[:limit]


# ======================================================================== play lab
#
# A playground: soft bubbles of the theme's two colours, a tilted sticker for the
# eyebrow, rounded cards that each hold one idea, and a friendly heavy display.
# Nothing is square; nothing is tiny.

PLAY_RADIUS = 36


def _play_bubbles() -> Elements:
    return [
        _shape("Bubble", kind="ellipse", x=1420, y=40, width=440, height=440, fill=_solid("token:colors.accent"), opacity=0.16),
        _shape("Bubble", kind="ellipse", x=1640, y=360, width=200, height=200, fill=_solid("token:colors.secondary"), opacity=0.28),
        _shape("Bubble", kind="ellipse", x=40, y=860, width=180, height=180, fill=_solid("token:colors.secondary"), opacity=0.22),
    ]


def _play_sticker(text: str, *, x: float = CONTENT_X, y: float = 150) -> Elements:
    width = min(620, 60 + len(text) * 19)
    return [
        _rotated(_shape("Sticker", kind="pill", x=x, y=y, width=width, height=64, fill=_solid("token:colors.secondary")), 357),
        _rotated(
            _text(
                role="eyebrow",
                x=x,
                y=y + 14,
                width=width,
                height=40,
                content=_rich_text(text),
                token="caption",
                size=24,
                weight=800,
                color="token:colors.secondaryForeground",
                align="center",
            ),
            357,
        ),
    ]


def _play_display(text: str, *, y: float, size: float, height: float, minimum: float, width: float = 1300) -> dict[str, Any]:
    return _text(
        role="headline",
        x=CONTENT_X,
        y=y,
        width=width,
        height=height,
        content=_rich_text(text),
        token="display",
        size=size,
        weight=800,
        fit="shrinkToFit",
        min_font_size=minimum,
        line_height=1.02,
        letter_spacing=-1,
        align="left",
    )


def play_title(plan: SlidePlan) -> Elements:
    """A playground poster: a huge friendly stack, flat shapes, a subject mid-leap.

    Measured from the design-system v3 concept (2026-10-14). The photograph
    fills the slide with its subject on the right; the left fades into the
    theme's flat colour so the title sits on paint, not on a picture. Corner
    discs run off the slide and a stair of blocks climbs to the right.
    """
    elements = [
        _shape("Play Lab hero frame", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H,
               fill=_solid("token:colors.background"), role="background"),
        # The hero is a whole photograph with its own shapes in it, so the cover
        # adds none over it: the wash turns its left side into flat paint for
        # the title and leaves the subject and the photograph's blocks alone.
        _shape("Play Lab readability wash", x=0, y=0, width=1240, height=VIEWPORT_H,
               fill={"type": "linearGradient", "angle": 90, "stops": [
                   {"offset": 0, "color": "token:colors.background"},
                   {"offset": 0.62, "color": "token:colors.background"},
                   {"offset": 1, "color": "#0757EF00"},
               ]}),
        _clipped_circle("Play corner disc", cx=0, cy=1100, r=270, fill=_solid("token:colors.accent")),
    ]
    elements[0]["metadata"] = {"designCheckIgnore": ["W104"]}
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, x=150, y=70)
    elements.append(_display_stack(plan.headline, x=150, y=160, width=900, height=540, size=320, minimum=110,
                                   line_height=0.86, weight=800, letter_spacing=-4, color="#FFFFFF",
                                   accent="token:colors.accent"))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=150, y=716, width=820, height=60, content=_rich_text(plan.subtitle), token="body",
                              size=30, weight=650, color="#FFFFFF", line_height=1.3, align="left"))
    for i, colour in enumerate(("#16245E", "#E5322D", "token:colors.secondary", "#FFFFFF")):
        elements.append(_shape("Play dot", kind="ellipse", x=230 + i * 82, y=812, width=56, height=56, fill=_solid(colour)))
    # One hand-drawn gesture: an arrow arcing up toward the subject.
    elements.append(_path("Play arrow", [
        ("M", 560, 1000), ("C", 700, 1060, 900, 1030, 982, 884),
        ("M", 942, 896), ("L", 982, 884), ("L", 990, 928),
    ], stroke=_line("#FFFFFF", 6)))
    return elements


def _term_cube(x: float, y: float, size: float) -> dict[str, Any]:
    """A wireframe cube, drawn as one outline so it recolours with the accent."""
    w, h = size, size * 1.15
    cx, top, mid, low, bottom = x + w / 2, y, y + h * 0.25, y + h * 0.75, y + h
    return _path("Wire cube", [
        ("M", cx, top), ("L", x + w, mid), ("L", x + w, low), ("L", cx, bottom), ("L", x, low), ("L", x, mid), ("Z",),
        ("M", x, mid), ("L", cx, y + h * 0.5), ("L", x + w, mid), ("M", cx, y + h * 0.5), ("L", cx, bottom),
    ], stroke=_line("token:colors.accent", 3))


def _term_bar() -> Elements:
    """Three status lights and the console rule: the top of every terminal slide."""
    green = "token:colors.accent"
    out: Elements = [_shape("Status light", kind="ellipse", x=40 + i * 32, y=18, width=20, height=20, fill=_solid(green)) for i in range(3)]
    out.append(_shape("Console rule", x=0, y=58, width=VIEWPORT_W, height=2, fill=_solid(green), opacity=0.7))
    return out


def play_statement(plan: SlidePlan) -> Elements:
    """A shout: the stack fills the slide, a sticker tilts in the corner, a sun rises."""
    elements: Elements = [
        _clipped_circle("Play corner disc", cx=1920, cy=1080, r=520, fill=_solid("token:colors.accent")),
    ]
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, x=1340, y=110)
        for part in elements[-2:]:
            part["transform"]["rotation"] = 12
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=110, width=1180, height=640, size=280, minimum=90,
                                   line_height=0.92, weight=800, letter_spacing=-4, color="#FFFFFF",
                                   accent="token:colors.accent", lines=3))
    if plan.subtitle or plan.body:
        elements.append(_text(role="subtitle", x=CONTENT_X, y=800, width=1040, height=180, content=_rich_text(plan.subtitle or plan.body or ""),
                              token="body", size=48, weight=650, color="#FFFFFF", fit="shrinkToFit", min_font_size=28,
                              line_height=1.25, align="left"))
    return elements


def play_bullets(plan: SlidePlan) -> Elements:
    """Four ideas, four friendly cards, a number badge on each."""
    elements: Elements = [_display_stack(plan.headline, x=CONTENT_X, y=70, width=CONTENT_W, height=160, size=120, minimum=56,
                                         line_height=1.0, weight=800, color="#FFFFFF", align="center", lines=1)]
    items = _bullets(plan, 4)
    columns = 2 if len(items) > 1 else 1
    rows = (len(items) + columns - 1) // columns
    gap = 40
    card_w = (CONTENT_W - gap * (columns - 1)) / columns
    top, bottom = 300, 1000
    card_h = (bottom - top - gap * (rows - 1) - 40 * rows) / max(rows, 1)
    for i, item in enumerate(items):
        x = CONTENT_X + (i % columns) * (card_w + gap)
        y = top + 40 + (i // columns) * (card_h + gap + 40)
        elements.append(_shape("Card", x=x, y=y, width=card_w, height=card_h, fill=_solid("#16245E"), radius=PLAY_RADIUS))
        elements.append(_shape("Number badge", kind="ellipse", x=x + card_w / 2 - 48, y=y - 48, width=96, height=96,
                               fill=_solid("token:colors.accent")))
        elements.append(_text(role="decoration", x=x + card_w / 2 - 48, y=y - 34, width=96, height=70, content=_rich_text(str(i + 1)),
                              token="display", size=54, weight=800, color="#16245E", align="center"))
        elements.append(_text(role="body", x=x + 48, y=y + 64, width=card_w - 96, height=card_h - 96, content=_rich_text(item),
                              token="body", size=52, weight=700, color="#FFFFFF", fit="shrinkToFit", min_font_size=28,
                              line_height=1.15, align="center"))
    return elements


def play_metrics(plan: SlidePlan) -> Elements:
    """Three tall cards in the theme's three colours, each one number."""
    elements: Elements = [_display_stack(plan.headline, x=CONTENT_X, y=70, width=CONTENT_W, height=160, size=120, minimum=56,
                                         line_height=1.0, weight=800, color="#FFFFFF", align="center", lines=1)]
    metrics = plan.metrics[:3]
    colours = (("token:colors.accent", "#16245E"), ("token:colors.secondary", "#16245E"), ("#16245E", "#FFFFFF"))
    gap = 36
    width = (CONTENT_W - gap * (len(metrics) - 1)) / max(len(metrics), 1)
    for i, metric in enumerate(metrics):
        fill, ink = colours[i % 3]
        x = CONTENT_X + i * (width + gap)
        elements.append(_shape("Metric card", x=x, y=280, width=width, height=720, fill=_solid(fill), radius=PLAY_RADIUS + 8))
        elements.append(_text(role="metric", x=x + 32, y=360, width=width - 64, height=300, content=_rich_text(metric.value), token="display",
                              size=230, weight=800, color=ink, fit="shrinkToFit", min_font_size=80, line_height=1.0,
                              letter_spacing=-4, align="center"))
        elements.append(_text(role="caption", x=x + 40, y=690, width=width - 80, height=240, content=_rich_text(metric.label), token="body",
                              size=56, weight=700, color=ink, fit="shrinkToFit", min_font_size=28, line_height=1.1, align="center"))
    return elements


def play_quote(plan: SlidePlan) -> Elements:
    """A speech bubble that fills the slide, and the face that said it."""
    quote = plan.quote or plan.headline
    elements: Elements = [
        _shape("Speech bubble", x=CONTENT_X, y=80, width=CONTENT_W, height=720, fill=_solid("#16245E"), radius=96),
        _path("Bubble tail", [("M", 340, 790), ("L", 520, 790), ("L", 300, 930), ("Z",)], fill=_solid("#16245E")),
        _shape("Quote avatar frame", kind="ellipse", x=1540, y=760, width=240, height=240, fill=_solid("token:colors.secondary"),
               role="supportingVisual"),
    ]
    elements.append(_text(role="quote", x=CONTENT_X + 120, y=180, width=CONTENT_W - 240, height=520, content=_rich_text(quote), token="display",
                          size=120, weight=800, color="#FFFFFF", fit="shrinkToFit", min_font_size=48, line_height=1.05,
                          letter_spacing=-2, align="left"))
    if plan.attribution:
        elements.append(_text(role="caption", x=860, y=860, width=640, height=110, content=_rich_text(plan.attribution), token="body",
                              size=40, weight=800, color="token:colors.accent", fit="shrinkToFit", min_font_size=24,
                              line_height=1.15, align="right"))
    return elements


def play_split(plan: SlidePlan) -> Elements:
    """A photograph tilted on a stack of coloured cards; the line beside it."""
    elements: Elements = [
        _shape("Play backing", x=150, y=150, width=640, height=780, fill=_solid("token:colors.secondary"), radius=48, rotation=-6),
        _shape("Play backing", x=110, y=230, width=600, height=760, fill=_solid("token:colors.accent"), radius=48, rotation=5),
        _shape("Picture blob", x=140, y=160, width=620, height=780, fill=_solid("#16245E"), radius=40, role="supportingVisual"),
    ]
    elements[-1]["transform"]["rotation"] = -2
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, x=930, y=150)
    elements.append(_display_stack(plan.headline, x=930, y=260, width=870, height=460, size=170, minimum=64,
                                   line_height=0.96, weight=800, letter_spacing=-3, color="#FFFFFF",
                                   accent="token:colors.accent", lines=3))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=930, y=760, width=860, height=220, content=_rich_text(copy), token="body", size=40,
                              weight=600, color="#FFFFFF", fit="shrinkToFit", min_font_size=24, line_height=1.3, align="left"))
    return elements


# ================================================================= system terminal
#
# A terminal session: a window bar with its three buttons, monospace everything,
# a prompt before the eyebrow, line numbers in a gutter, a block cursor. The data
# is a table of boxes, the quote a block comment. Square corners, one green.

TERM_GUTTER = 96
TERM_X = CONTENT_X + TERM_GUTTER


def _term_window(lines: int = 0) -> Elements:
    # The same status lights and rule as every other terminal slide (v3).
    out = _term_bar() + [
        _shape("Gutter rule", x=CONTENT_X + TERM_GUTTER - 28, y=CONTENT_TOP + 60, width=2, height=CONTENT_BOTTOM - CONTENT_TOP - 80, fill=_solid("token:colors.border")),
    ]
    if lines:
        numbers = "\n".join(f"{n:02d}" for n in range(1, lines + 1))
        out.append(_text(role="decoration", x=CONTENT_X, y=CONTENT_TOP + 70, width=56, height=lines * 62, content=_rich_list(numbers.split("\n"), "paragraph"), token="code", size=22, color="token:colors.foregroundSubtle", line_height=2.3, align="right"))
    return out


def _term_prompt(text: str, *, y: float = CONTENT_TOP + 70) -> dict[str, Any]:
    return _text(role="eyebrow", x=TERM_X, y=y, width=1200, height=40, content=_rich_text(f"$ {text.lower()}"), token="code", size=22, color="token:colors.accent", align="left")


def _term_display(text: str, *, y: float, size: float, height: float, minimum: float, width: float = CONTENT_W - TERM_GUTTER) -> dict[str, Any]:
    return _text(role="headline", x=TERM_X, y=y, width=width, height=height, content=_rich_text(text), token="code", size=size, weight=600, fit="shrinkToFit", min_font_size=minimum, line_height=1.15, letter_spacing=-1, align="left")


def _term_comment(text: str, *, y: float, height: float, size: float = 26, width: float = 1300) -> dict[str, Any]:
    return _text(role="subtitle", x=TERM_X, y=y, width=width, height=height, content=_rich_text(f"// {text}"), token="code", size=size, color="token:colors.foregroundMuted", line_height=1.5, align="left")


def term_title(plan: SlidePlan) -> Elements:
    """A systems console: a mono stack, an exploded isometric stack, live traces.

    Measured from the design-system v3 concept (2026-10-14). Everything is a
    one-colour line drawing on the dark ground, so the whole cover recolours
    with the theme's accent.
    """
    green = "token:colors.accent"
    elements: Elements = [
        _shape("Status light", kind="ellipse", x=40 + i * 32, y=18, width=20, height=20, fill=_solid(green)) for i in range(3)
    ]
    elements.append(_shape("Console rule", x=0, y=58, width=VIEWPORT_W, height=2, fill=_solid(green), opacity=0.7))
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow, y=96))
        elements[-1]["transform"]["x"] = 104
    elements.append(_display_stack(plan.headline, x=104, y=140, width=900, height=330, size=190, minimum=72,
                                   line_height=0.94, weight=600, color=green, transform_case="uppercase"))
    if plan.subtitle:
        elements.append(_term_comment(plan.subtitle, y=486, height=40, size=24, width=860))
        elements[-1]["transform"]["x"] = 104

    # A node trace: three hollow nodes on a spine, each with two readouts.
    elements.append(_shape("Node spine", x=142, y=574, width=3, height=204, fill=_solid(green)))
    for i in range(3):
        y = 560 + i * 102
        elements.append(_shape("Node", kind="ellipse", x=128, y=y, width=30, height=30,
                               fill=_solid("token:colors.background"), stroke=_line(green, 3)))
        elements.append(_shape("Node readout", x=184, y=y + 6, width=92, height=4, fill=_solid(green), opacity=0.85))
        elements.append(_shape("Node readout", x=184, y=y + 18, width=58 + i * 10, height=4, fill=_solid(green), opacity=0.55))
    elements.append(_shape("Node panel", x=322, y=556, width=124, height=88, fill=_none(), stroke=_line(green, 2)))
    for i, w in enumerate((70, 92, 56)):
        elements.append(_shape("Panel readout", x=338, y=576 + i * 20, width=w, height=3, fill=_solid(green), opacity=0.6))

    # The signal panel: a gridded trace.
    elements.append(_shape("Trace panel", x=96, y=820, width=800, height=190, fill=_none(), stroke=_line(green, 2)))
    for i in range(1, 4):
        elements.append(_shape("Trace grid", x=116, y=820 + i * 47, width=760, height=1, fill=_solid(green), opacity=0.22))
    wave = [(120 + step * 12.5, 915 - 62 * math.sin(step / 60 * 4.6 * math.pi)) for step in range(61)]
    elements.append(_path("Signal trace", [("M", *wave[0])] + [("L", *point) for point in wave[1:]], stroke=_line(green, 3)))

    # The exploded stack: four isometric layers on one axis.
    elements.append(_shape("Stack axis", x=1410, y=110, width=2, height=900, fill=_solid(green), opacity=0.4))
    for i in range(4):
        x0, y0, w, top, depth = 1094, 140 + i * 150, 634, 363, 50
        cx, mid = x0 + w / 2, y0 + top / 2
        elements.append(_path("System layer", [
            ("M", x0, mid), ("L", cx, y0), ("L", x0 + w, mid), ("L", cx, y0 + top), ("Z",),
            ("M", x0, mid), ("L", x0, mid + depth), ("L", cx, y0 + top + depth), ("L", x0 + w, mid + depth), ("L", x0 + w, mid),
            ("M", cx, y0 + top), ("L", cx, y0 + top + depth),
        ], fill=_solid("#4ADE800F") if i == 0 else None, stroke=_line(green, 2.5 if i == 0 else 2)))

    # The target dial.
    for d in (176, 112, 38):
        elements.append(_shape("Target ring", kind="ellipse", x=1800 - d / 2, y=962 - d / 2, width=d, height=d,
                               fill=_none(), stroke=_line(green, 2)))
    elements.append(_shape("Target cross", x=1698, y=961, width=204, height=2, fill=_solid(green)))
    elements.append(_shape("Target cross", x=1799, y=868, width=2, height=188, fill=_solid(green)))
    return elements


def term_statement(plan: SlidePlan) -> Elements:
    """A command and its output: the statement as a mono stack, a comment, a cursor."""
    elements = _term_bar()
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow, y=110))
        elements[-1]["transform"].update({"x": 104, "width": 1100})
    elements.append(_display_stack(plan.headline, x=104, y=170, width=1180, height=600, size=220, minimum=72,
                                   line_height=1.0, weight=600, color="token:colors.foreground", transform_case="uppercase", lines=3))
    if plan.subtitle or plan.body:
        elements.append(_term_comment(plan.subtitle or plan.body or "", y=810, height=150, size=40, width=1180))
        elements[-1]["transform"]["x"] = 104
        elements[-1]["fit"] = "shrinkToFit"
        elements[-1]["minFontSize"] = 24
        elements[-1]["typography"]["color"] = "token:colors.accent"
    elements.append(_shape("Cursor", x=104, y=982, width=28, height=48, fill=_solid("token:colors.accent")))
    elements.append(_term_cube(1400, 220, 400))
    return elements


def term_bullets(plan: SlidePlan) -> Elements:
    """A log: each item a numbered line, spread down the console."""
    elements = _term_bar()
    elements.append(_display_stack(plan.headline, x=104, y=110, width=1712, height=150, size=120, minimum=56,
                                   line_height=1.0, weight=600, color="token:colors.foreground", transform_case="uppercase", lines=1))
    items = _bullets(plan, 4)
    elements += _rows(items, x=104, y=320, width=1712, height=680, size=50, minimum=26, token="code",
                      numbers=[f"[{i + 1:02d}]" for i in range(len(items))], number_width=180, number_size=50,
                      number_token="code", number_color="token:colors.accent", rule="#4ADE8033", line_height=1.2)
    return elements


def term_metrics(plan: SlidePlan) -> Elements:
    """Three readouts in outlined panels, the figure large in the accent."""
    elements = _term_bar()
    elements.append(_display_stack(plan.headline, x=104, y=110, width=1712, height=150, size=120, minimum=56,
                                   line_height=1.0, weight=600, color="token:colors.foreground", transform_case="uppercase", lines=1))
    metrics = plan.metrics[:4]
    gap = 32
    width = (1712 - gap * (len(metrics) - 1)) / max(len(metrics), 1)
    for i, metric in enumerate(metrics):
        x = 104 + i * (width + gap)
        elements.append(_shape("Readout panel", x=x, y=310, width=width, height=600, fill=_none(), stroke=_line("token:colors.accent", 2)))
        elements.append(_text(role="metric", x=x + 32, y=380, width=width - 64, height=280, content=_rich_text(metric.value), token="code",
                              size=210, weight=600, color="token:colors.accent", fit="shrinkToFit", min_font_size=64, line_height=1.0, align="center"))
        elements.append(_text(role="caption", x=x + 32, y=700, width=width - 64, height=160, content=_rich_text(metric.label), token="code",
                              size=40, color="token:colors.foreground", fit="shrinkToFit", min_font_size=22, line_height=1.2, align="center"))
        elements.append(_shape("Panel rule", x=x + 32, y=660, width=width - 64, height=2, fill=_solid("token:colors.accent"), opacity=0.35))
    return elements


def term_quote(plan: SlidePlan) -> Elements:
    """A block comment at full size, the source as a signature, a target in the corner."""
    elements = _term_bar()
    quote = plan.quote or plan.headline
    elements.append(_text(role="quote", x=104, y=120, width=1440, height=760, content=_rich_text(f"/* {quote} */"), token="code",
                          size=150, weight=500, color="token:colors.foreground", fit="shrinkToFit", min_font_size=48,
                          line_height=1.15, align="left"))
    if plan.attribution:
        elements.append(_text(role="caption", x=104, y=920, width=1300, height=60, content=_rich_text(f"-- {plan.attribution}"), token="code",
                              size=40, color="token:colors.accent", fit="shrinkToFit", min_font_size=22, align="left"))
    for d in (240, 160, 80):
        elements.append(_shape("Target ring", kind="ellipse", x=1700 - d / 2, y=880 - d / 2, width=d, height=d, fill=_none(),
                               stroke=_line("token:colors.accent", 2)))
    elements.append(_shape("Target cross", x=1570, y=879, width=260, height=2, fill=_solid("token:colors.accent")))
    elements.append(_shape("Target cross", x=1699, y=750, width=2, height=260, fill=_solid("token:colors.accent")))
    return elements


def term_split(plan: SlidePlan) -> Elements:
    """A spec panel on the left, the exploded system on the right."""
    elements = _term_bar()
    elements.append(_shape("Spec panel", x=104, y=120, width=820, height=880, fill=_none(), stroke=_line("token:colors.accent", 2)))
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow, y=160))
        elements[-1]["transform"].update({"x": 150, "width": 730})
    elements.append(_display_stack(plan.headline, x=150, y=230, width=730, height=420, size=130, minimum=52,
                                   line_height=1.05, weight=600, color="token:colors.foreground", transform_case="uppercase", lines=4))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=150, y=690, width=730, height=270, content=_rich_text(copy), token="code", size=32,
                              color="token:colors.foregroundMuted", fit="shrinkToFit", min_font_size=20, line_height=1.45, align="left"))
    for i in range(4):
        x0, y0, w, top, depth = 1100, 170 + i * 180, 600, 340, 46
        cx, mid = x0 + w / 2, y0 + top / 2
        elements.append(_path("System layer", [
            ("M", x0, mid), ("L", cx, y0), ("L", x0 + w, mid), ("L", cx, y0 + top), ("Z",),
            ("M", x0, mid), ("L", x0, mid + depth), ("L", cx, y0 + top + depth), ("L", x0 + w, mid + depth), ("L", x0 + w, mid),
        ], stroke=_line("token:colors.accent", 2)))
    return elements


def term_code(plan: SlidePlan) -> Elements:
    """The one layout a terminal is for: a listing in the session, square, numbered, no card."""
    elements = _term_window()
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow))
    elements.append(_term_display(plan.headline, y=CONTENT_TOP + 130, size=56, height=150, minimum=36))
    code = plan.code or "// no code provided"
    line_count = code.count("\n") + 1
    height = min(CONTENT_BOTTOM - 420, max(200, line_count * 40 + 80))
    elements.append(
        {
            "id": new_id("el"),
            "type": "code",
            "name": "Code",
            "transform": {"x": TERM_X, "y": 340, "width": CONTENT_W - TERM_GUTTER, "height": round(height, 2)},
            "language": plan.language or "text",
            "code": code,
            "showLineNumbers": True,
            "style": {
                "fill": {"type": "solid", "color": "token:colors.surface"},
                "cornerRadius": 0,
                "stroke": {"paint": {"type": "solid", "color": "token:colors.borderStrong"}, "width": 1},
            },
        }
    )
    if plan.caption:
        # The code renderer reserves a small optical gutter below its measured
        # box; leave that gutter before the explanatory comment.
        elements.append(_term_comment(plan.caption, y=390 + height, height=60, size=22))
    return elements


# ===================================================================== quiet luxe
#
# A fashion house's lookbook: wide margins, a light serif display, small tracked
# capitals, hairlines rather than boxes, a tall portrait frame, and a lot of room.

LUXE_X = 240
LUXE_RIGHT = VIEWPORT_W - 240


def _luxe_eyebrow(text: str, *, x: float = LUXE_X, y: float, width: float = 900, align: str = "left") -> dict[str, Any]:
    return _text(role="eyebrow", x=x, y=y, width=width, height=36, content=_rich_text(text), token="caption", size=18, weight=600, color="token:colors.accent", letter_spacing=6, transform_case="uppercase", align=align)


def _luxe_hairline(x: float, y: float, width: float = 80) -> dict[str, Any]:
    return _shape("Hairline", x=x, y=y, width=width, height=2, fill=_solid("token:colors.accent"))


def _luxe_display(text: str, *, x: float, y: float, width: float, size: float, height: float, minimum: float, align: str = "left") -> dict[str, Any]:
    return _text(role="headline", x=x, y=y, width=width, height=height, content=_rich_text(text), token="display", size=size, weight=400, fit="shrinkToFit", min_font_size=minimum, line_height=1.08, align=align)


def luxe_title(plan: SlidePlan) -> Elements:
    """A lookbook cover: half paper, half photograph, a serif stack between rules.

    Measured from the design-system v3 concept (2026-10-14): the interior
    photograph takes the right half edge to edge; the left half is paper with a
    tick, two short rules framing the title, and one small framed inset.
    """
    elements = [
        _shape("Luxe paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Portrait frame", x=960, y=0, width=960, height=1080,
               fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _shape("Luxe tick", x=100, y=92, width=2, height=32, fill=_solid("token:colors.accent")),
        _luxe_hairline(152, 106, 168),
    ]
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, x=152, y=150, width=700))
    elements.append(_display_stack(plan.headline, x=150, y=212, width=760, height=400, size=220, minimum=80,
                                   line_height=0.92, weight=500, color="token:colors.secondary",
                                   accent="token:colors.accent", transform_case="uppercase"))
    elements.append(_luxe_hairline(152, 632, 168))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=152, y=662, width=700, height=76, content=_rich_text(plan.subtitle), token="body",
                              size=24, color="token:colors.foregroundMuted", line_height=1.5, align="left"))
    elements.append(_shape("Inset mount", x=148, y=760, width=198, height=272, fill=_none(), stroke=_line("token:colors.border", 2)))
    elements.append(_shape("Luxe inset", x=156, y=768, width=182, height=256, fill=_solid("token:colors.accentMuted"), role="supportingVisual"))
    return elements


def luxe_statement(plan: SlidePlan) -> Elements:
    """A considered sentence beside a still life: two lines of serif, one photograph."""
    elements: Elements = [
        _shape("Luxe paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Luxe still frame", x=1300, y=90, width=520, height=900, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, x=150, y=110, width=1000))
    elements.append(_luxe_hairline(150, 166, 620))
    elements.append(_display_stack(plan.headline, x=150, y=300, width=1080, height=430, size=200, minimum=72,
                                   line_height=0.98, weight=500, color="token:colors.secondary", accent="token:colors.accent"))
    if plan.subtitle or plan.body:
        elements.append(_text(role="subtitle", x=150, y=780, width=1000, height=180, content=_rich_text(plan.subtitle or plan.body or ""),
                              token="body", size=44, color="token:colors.foreground", fit="shrinkToFit", min_font_size=24,
                              line_height=1.35, align="left"))
    return elements


def luxe_bullets(plan: SlidePlan) -> Elements:
    """The heading set tall on the left; the items as a quiet numbered list on the right."""
    elements: Elements = [
        _shape("Luxe paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
    ]
    elements.append(_display_stack(plan.headline, x=150, y=150, width=840, height=780, size=200, minimum=64,
                                   line_height=1.0, weight=500, color="token:colors.secondary", lines=4))
    items = _bullets(plan, 4)
    elements += _rows(items, x=1040, y=150, width=760, height=780, size=56, minimum=28, token="display", weight=400,
                      numbers=[f"{i + 1:02d}" for i in range(len(items))], number_width=80, number_size=30,
                      number_token="caption", number_color="token:colors.accent", rule="token:colors.accent", line_height=1.12)
    return elements


def luxe_metrics(plan: SlidePlan) -> Elements:
    """Figures in the accent serif, hairlines between them, a material strip beneath."""
    elements: Elements = [
        _shape("Luxe paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Luxe strip frame", x=0, y=860, width=VIEWPORT_W, height=220, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    elements.append(_display_stack(plan.headline, x=150, y=110, width=1620, height=170, size=140, minimum=60,
                                   line_height=1.0, weight=500, color="token:colors.secondary", lines=1))
    metrics = plan.metrics[:4]
    width = 1620 / max(len(metrics), 1)
    for i, metric in enumerate(metrics):
        x = 150 + i * width
        if i:
            elements.append(_shape("Hairline", x=x, y=360, width=2, height=420, fill=_solid("token:colors.accent"), opacity=0.6))
        elements.append(_text(role="metric", x=x + 40, y=370, width=width - 80, height=280, content=_rich_text(metric.value), token="display",
                              size=230, weight=500, color="token:colors.accent", fit="shrinkToFit", min_font_size=80,
                              line_height=1.0, align="left"))
        elements.append(_luxe_eyebrow(metric.label, x=x + 44, y=690, width=width - 88))
        elements[-1]["semanticRole"] = "caption"
        elements[-1]["typography"]["fontSize"] = 26
    return elements


def luxe_quote(plan: SlidePlan) -> Elements:
    """A photograph down the left edge; the words, large and centred, in the room it leaves."""
    quote = plan.quote or plan.headline
    elements: Elements = [
        _shape("Luxe paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Luxe strip frame", x=0, y=0, width=400, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    elements.append(_text(role="quote", x=520, y=160, width=1280, height=600, content=_rich_text(f"“{quote}”"), token="display",
                          size=140, weight=500, color="token:colors.secondary", fit="shrinkToFit", min_font_size=56,
                          line_height=1.08, align="left"))
    if plan.attribution:
        elements.append(_luxe_hairline(520, 820, 1280))
        elements.append(_luxe_eyebrow(plan.attribution, x=520, y=860, width=1280))
        elements[-1]["semanticRole"] = "caption"
        elements[-1]["typography"]["fontSize"] = 26
    return elements


def luxe_split(plan: SlidePlan) -> Elements:
    """Half photograph, edge to edge; half paper, with the line and a short paragraph."""
    elements: Elements = [
        _shape("Luxe paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Portrait frame", x=0, y=0, width=900, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, x=1020, y=200, width=780))
    elements.append(_display_stack(plan.headline, x=1020, y=260, width=780, height=460, size=170, minimum=64,
                                   line_height=1.0, weight=500, color="token:colors.secondary", lines=3))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=1020, y=760, width=760, height=220, content=_rich_text(copy), token="body", size=36,
                              color="token:colors.foreground", fit="shrinkToFit", min_font_size=22, line_height=1.45, align="left"))
    return elements


# ====================================================================== data desk
#
# An operations dashboard: a header strip with the section and a status dot,
# tiles with hairline borders, figures that are the largest thing on the slide,
# small headlines, and a row of spark bars as the title's motif.

DESK_RADIUS = 12

# Natural Earth 1:110m land (public domain, via the renderer's world-map.ts),
# rasterized onto a 52 by 22 grid of equirectangular cells from 80°N to 58°S:
# "1" where the cell is mostly land. The Data Desk cover draws a dot per land
# cell, so its map is the real world rather than a traced picture of one.
_WORLD_DOTS = (
    "0000000001011110111111100000100000000001110000000000",
    "0001110111111111001111100000011000011111111111111101",
    "1011111111111101101110010001111111111111111111111111",
    "0011001111111001100000000001111111111111111111111100",
    "0000000111111111110000000111111111111111111111100000",
    "0000000011111111100000000111111111111111111111100000",
    "0000000011111111000000000100111111111111111110000000",
    "0000000001111110000000000111010111111111111101000000",
    "0000000000110010000000001111111111111111111100000000",
    "0000000000010000000000011111111111101111110000000000",
    "0000000000001100000000011111111111000100110100000000",
    "0000000000000011110000001111111110000100000000000000",
    "0000000000000011111000000001111110000000101000000000",
    "0000000000000011111110000001111100000000011001100000",
    "0000000000000001111110000000111100000000000000000000",
    "0000000000000001111110000000111110000000000011100000",
    "0000000000000000111100000000111010000000001111110000",
    "0000000000000000111000000000111000000000001111110000",
    "0000000000000001110000000000000000000000000000110000",
    "0000000000000001100000000000000000000000000000000000",
    "0000000000000001000000000000000000000000000000000000",
    "0000000000000001000000000000000000000000000000000000",
)




def _desk_header(plan: SlidePlan) -> Elements:
    out: Elements = [
        _shape("Header rule", x=CONTENT_X, y=CONTENT_TOP + 64, width=CONTENT_W, height=2, fill=_solid("token:colors.border")),
        _shape("Status dot", kind="ellipse", x=RIGHT - 16, y=CONTENT_TOP + 20, width=16, height=16, fill=_solid("token:colors.success")),
    ]
    if plan.eyebrow:
        out.append(_text(role="eyebrow", x=CONTENT_X, y=CONTENT_TOP + 12, width=1200, height=36, content=_rich_text(plan.eyebrow), token="caption", size=20, weight=700, color="token:colors.foregroundMuted", letter_spacing=2, transform_case="uppercase", align="left"))
    return out


def _desk_tile(name: str, x: float, y: float, width: float, height: float) -> dict[str, Any]:
    return _shape(name, x=x, y=y, width=width, height=height, fill=_solid("token:colors.surface"), radius=DESK_RADIUS, stroke=_line("token:colors.border", 2))


def _desk_headline(text: str, *, y: float = CONTENT_TOP + 100, size: float = 56, height: float = 150, width: float = CONTENT_W) -> dict[str, Any]:
    return _text(role="headline", x=CONTENT_X, y=y, width=width, height=height, content=_rich_text(text), token="h1", size=size, weight=700, fit="shrinkToFit", min_font_size=34, line_height=1.1, letter_spacing=-1, align="left")


def desk_title(plan: SlidePlan) -> Elements:
    """An editorial data wall: a huge two-colour stack and five live-looking views.

    Measured from the design-system v3 concept (2026-10-14). Hairlines divide
    the page into a trend, a world of places, a ranking, a share and a series.
    They are cover motifs drawn as editable shapes, with no figures on them: a
    number on a cover that is not the deck's own data would be invented.
    """
    navy, red, hair = "token:colors.accent", "token:colors.secondary", _solid("token:colors.border")
    elements: Elements = [
        _shape("Desk rule", x=958, y=48, width=2, height=1032, fill=hair),
        _shape("Desk rule", x=48, y=540, width=1824, height=2, fill=hair),
        _shape("Desk rule", x=960, y=808, width=912, height=2, fill=hair),
        _shape("Desk rule", x=1438, y=810, width=2, height=270, fill=hair),
    ]
    elements.append(_display_stack(plan.headline, x=58, y=36, width=840, height=452, size=290, minimum=90,
                                   line_height=0.86, weight=800, color=navy, accent=red, letter_spacing=-2,
                                   transform_case="uppercase"))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=62, y=494, width=860, height=36, content=_rich_text(plan.subtitle), token="body",
                              size=22, color="token:colors.foregroundMuted", align="left"))
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=1010, y=50, width=560, height=32, content=_rich_text(plan.eyebrow), token="caption",
                              size=20, weight=700, color="token:colors.foreground", letter_spacing=1, transform_case="uppercase", align="left"))

    # The trend: two series rising, a highlighted period, gridlines.
    left, right, top, bottom = 1010.0, 1860.0, 104.0, 484.0
    for i in range(9):
        elements.append(_shape("Trend grid", x=left, y=top + i * 47.5, width=right - left, height=1, fill=hair))
    elements.append(_shape("Trend highlight", x=1690, y=top, width=100, height=bottom - top, fill=_solid("token:colors.surfaceAlt")))
    for name, colour, values in (
        ("Trend line", navy, (0.06, 0.09, 0.15, 0.17, 0.25, 0.27, 0.31, 0.37, 0.41, 0.47, 0.57, 0.62, 0.65, 0.73, 0.74, 0.80, 0.83, 0.88, 0.94, 0.95, 1.0)),
        ("Trend line", red, (0.03, 0.05, 0.10, 0.12, 0.15, 0.18, 0.20, 0.21, 0.25, 0.28, 0.34, 0.43, 0.46, 0.48, 0.53, 0.61, 0.68, 0.69, 0.79, 0.77, 0.87)),
    ):
        step = (right - left) / (len(values) - 1)
        points = [(left + i * step, bottom - v * (bottom - top - 12)) for i, v in enumerate(values)]
        elements.append(_path(name, [("M", *points[0])] + [("L", *p) for p in points[1:]], stroke=_line(colour, 4)))
    for i, colour in enumerate((navy, red)):
        elements.append(_shape("Trend key", x=1640 + i * 120, y=62, width=34, height=4, fill=_solid(colour)))

    # The world: Natural Earth land as a dot grid, places as bubbles.
    map_left, map_top, map_w, map_h = 60.0, 572.0, 870.0, 470.0
    cols, rows = len(_WORLD_DOTS[0]), len(_WORLD_DOTS)
    cell_w, cell_h = map_w / cols, map_h / rows
    dots: list[tuple[Any, ...]] = []
    for j, row in enumerate(_WORLD_DOTS):
        for i, cell in enumerate(row):
            if cell == "1":
                cx, cy, r = map_left + (i + 0.5) * cell_w, map_top + (j + 0.5) * cell_h, 4.5
                dots += [("M", cx - r, cy), ("L", cx, cy - r), ("L", cx + r, cy), ("L", cx, cy + r), ("Z",)]
    elements.append(_path("World dots", dots, fill=_solid("#A3A8AE")))
    for lat, lon, size in ((40.7, -74.0, 48), (34.0, -118.2, 62), (51.5, -0.1, 70), (48.9, 2.3, 30), (6.5, 3.4, 26),
                           (19.0, 72.8, 40), (31.2, 121.5, 56), (35.7, 139.7, 34), (1.3, 103.8, 30), (-23.5, -46.6, 30), (-33.9, 151.2, 26)):
        x = map_left + (lon + 180) / 360 * map_w
        y = map_top + (80 - lat) / 138 * map_h
        elements.append(_shape("Place", kind="ellipse", x=x - size / 2, y=y - size / 2, width=size, height=size,
                               fill=_solid(red), opacity=0.82))

    # The ranking: bars rising to the one that matters.
    heights = (18, 24, 30, 38, 48, 58, 68, 78, 92, 104, 124, 140, 150, 162, 176, 190)
    for i, h in enumerate(heights):
        elements.append(_shape("Rank bar", x=1012 + i * 53, y=790 - h, width=38, height=h,
                               fill=_solid(red if i == len(heights) - 1 else navy)))
    elements.append(_shape("Rank baseline", x=1010, y=790, width=850, height=2, fill=_solid("token:colors.foreground")))

    # The share: a donut and a ranked list beside it.
    cx, cy, r = 1110.0, 944.0, 82.0
    start = -math.pi / 2
    for colour, share in ((navy, 0.52), (red, 0.34), ("#8DBDE6", 0.14)):
        end = start + share * 2 * math.pi
        arc = [(cx + r * math.cos(start + (end - start) * k / 24), cy + r * math.sin(start + (end - start) * k / 24)) for k in range(25)]
        elements.append(_path("Share arc", [("M", *arc[0])] + [("L", *p) for p in arc[1:]], stroke=_line(colour, 34)))
        start = end
    for i, w in enumerate((176, 160, 152, 132, 120, 104, 72)):
        y = 872 + i * 26
        elements.append(_shape("List dot", kind="ellipse", x=1236, y=y, width=12, height=12, fill=_solid(red if i in (1, 2) else navy)))
        elements.append(_shape("List track", x=1258, y=y + 3, width=176, height=6, fill=_solid("token:colors.surfaceAlt")))
        elements.append(_shape("List value", x=1258, y=y + 3, width=w, height=6, fill=_solid(navy)))

    # The series: a soft area under a line.
    values = (0.1, 0.36, 0.42, 0.24, 0.38, 0.46, 0.68, 0.78, 0.58, 0.48, 0.38, 0.66, 0.66, 0.78, 0.92, 0.78, 0.42, 0.40, 0.34, 0.9, 0.7, 0.56, 0.7)
    left, right, base, peak = 1470.0, 1860.0, 1050.0, 846.0
    step = (right - left) / (len(values) - 1)
    line = [(left + i * step, base - v * (base - peak)) for i, v in enumerate(values)]
    elements.append(_path("Series area", [("M", left, base)] + [("L", *p) for p in line] + [("L", right, base), ("Z",)],
                          fill=_solid("#BFD4EA")))
    elements.append(_path("Series line", [("M", *line[0])] + [("L", *p) for p in line[1:]], stroke=_line(navy, 2.5)))
    return elements


def _space_ruler() -> Elements:
    """The ruler down the left edge of every spatial slide."""
    out: Elements = [_shape("Ruler", x=74, y=70, width=2, height=940, fill=_solid("token:colors.foregroundSubtle"), opacity=0.6)]
    for i in range(24):
        out.append(_shape("Ruler tick", x=76, y=76 + i * 40, width=14 if i % 4 == 0 else 8, height=1.5,
                          fill=_solid("token:colors.foregroundSubtle"), opacity=0.6))
    return out


def _earth_torn(x: float, top: float, bottom: float, name: str = "Torn paper") -> dict[str, Any]:
    """A ragged strip of paper along a photograph's edge."""
    edge = [(x - 36, top)]
    steps = int((bottom - top) / 30)
    for k in range(1, steps):
        edge.append((x + (14 if k % 2 else -8) + (k % 3) * 5, top + k * 30))
    edge.append((x - 36, bottom))
    return _path(name, [("M", *edge[0])] + [("L", *p) for p in edge[1:]] + [("Z",)], fill=_solid("token:colors.surface"))


def _earth_tree_ring(cx: float, cy: float, r: float, name: str = "Tree ring") -> Elements:
    """A cut log seen end on: a disc and its growth rings, clipped to the slide."""
    out: Elements = [_clipped_circle(name, cx=cx, cy=cy, r=r, fill=_solid("#E3D2B2"))]
    for k in (0.82, 0.62, 0.42, 0.2):
        d = 2 * r * k
        if cx - d / 2 >= 0 and cy - d / 2 >= 0 and cx + d / 2 <= VIEWPORT_W and cy + d / 2 <= VIEWPORT_H:
            out.append(_shape("Ring line", kind="ellipse", x=cx - d / 2, y=cy - d / 2, width=d, height=d, fill=_none(),
                              stroke=_line("#A47D52", 2.5), opacity=0.75))
    return out


def desk_statement(plan: SlidePlan) -> Elements:
    """A front page: the claim in two colours across the top, its source beneath a rule."""
    elements: Elements = [_shape("Desk rule", x=CONTENT_X, y=86, width=CONTENT_W, height=2, fill=_solid("token:colors.border"))]
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=CONTENT_X, y=104, width=1200, height=36, content=_rich_text(plan.eyebrow), token="caption",
                              size=22, weight=700, color="token:colors.foregroundMuted", letter_spacing=2, transform_case="uppercase", align="left"))
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=160, width=CONTENT_W, height=560, size=300, minimum=96,
                                   line_height=0.95, weight=800, letter_spacing=-4, color="token:colors.accent",
                                   accent="token:colors.secondary"))
    elements.append(_shape("Desk rule", x=CONTENT_X, y=770, width=CONTENT_W, height=2, fill=_solid("token:colors.border")))
    if plan.subtitle or plan.body:
        elements.append(_text(role="subtitle", x=CONTENT_X, y=800, width=CONTENT_W, height=180, content=_rich_text(plan.subtitle or plan.body or ""),
                              token="body", size=46, weight=500, color="token:colors.foreground", fit="shrinkToFit", min_font_size=26,
                              line_height=1.3, align="left"))
    return elements


def desk_bullets(plan: SlidePlan) -> Elements:
    """A ranked table: big numbers, one line each, hairlines between the rows."""
    elements: Elements = [_shape("Desk rule", x=CONTENT_X, y=86, width=CONTENT_W, height=2, fill=_solid("token:colors.border"))]
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=110, width=CONTENT_W, height=250, size=130, minimum=60,
                                   line_height=1.0, weight=800, letter_spacing=-2, color="token:colors.foreground", lines=2))
    elements.append(_shape("Desk rule", x=CONTENT_X, y=390, width=CONTENT_W, height=2, fill=_solid("token:colors.foreground")))
    items = _bullets(plan, 6)
    elements += _rows(items, x=CONTENT_X, y=392, width=CONTENT_W, height=608, size=50, minimum=26, weight=600,
                      numbers=[f"{i + 1:02d}" for i in range(len(items))], number_width=200, number_size=110,
                      number_color="token:colors.accent", number_weight=800, rule="token:colors.border", line_height=1.15)
    return elements


def desk_metrics(plan: SlidePlan) -> Elements:
    """The figures as the largest thing on the page, ruled into columns."""
    elements: Elements = [_shape("Desk rule", x=CONTENT_X, y=86, width=CONTENT_W, height=2, fill=_solid("token:colors.border"))]
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=110, width=CONTENT_W, height=250, size=130, minimum=60,
                                   line_height=1.0, weight=800, letter_spacing=-2, color="token:colors.foreground", lines=2))
    metrics = plan.metrics[:4]
    width = CONTENT_W / max(len(metrics), 1)
    for i, metric in enumerate(metrics):
        x = CONTENT_X + i * width
        if i:
            elements.append(_shape("Desk rule", x=x, y=430, width=2, height=520, fill=_solid("token:colors.border")))
        pad = 0 if i == 0 else 48
        elements.append(_text(role="caption", x=x + pad, y=430, width=width - pad - 24, height=60, content=_rich_text(metric.label), token="body",
                              size=34, weight=700, color="token:colors.foregroundMuted", fit="shrinkToFit", min_font_size=20, align="left"))
        elements.append(_text(role="metric", x=x + pad, y=520, width=width - pad - 24, height=300, content=_rich_text(metric.value), token="display",
                              size=270, weight=800, color="token:colors.accent" if i else "token:colors.secondary", fit="shrinkToFit",
                              min_font_size=80, line_height=1.0, letter_spacing=-6, align="left"))
        elements.append(_shape("Figure rule", x=x + pad, y=860, width=min(240, width - pad - 24), height=8,
                               fill=_solid("token:colors.secondary" if i == 0 else "token:colors.accent")))
    return elements


def desk_quote(plan: SlidePlan) -> Elements:
    """A pull quote: a thick red rule, the words in heavy type, the source at its foot."""
    quote = plan.quote or plan.headline
    elements: Elements = [
        _shape("Quote rule", x=CONTENT_X, y=130, width=16, height=820, fill=_solid("token:colors.secondary")),
        _text(role="decoration", x=CONTENT_X + 70, y=110, width=220, height=240, content=_rich_text("“"), token="display",
              size=220, weight=800, color="token:colors.accent", line_height=1, align="left"),
    ]
    elements.append(_text(role="quote", x=CONTENT_X + 70, y=370, width=1500, height=490, content=_rich_text(quote), token="display",
                          size=130, weight=800, color="token:colors.accent", fit="shrinkToFit", min_font_size=52,
                          line_height=1.08, letter_spacing=-2, align="left"))
    if plan.attribution:
        elements.append(_text(role="caption", x=CONTENT_X + 70, y=890, width=1400, height=60, content=_rich_text(plan.attribution), token="body",
                              size=36, weight=700, color="token:colors.foreground", align="left"))
    return elements


def desk_split(plan: SlidePlan) -> Elements:
    """A picture or exhibit panel on the left, the headline and its reading on the right."""
    elements: Elements = [
        _shape("Desk rule", x=CONTENT_X, y=86, width=CONTENT_W, height=2, fill=_solid("token:colors.border")),
        _shape("Split picture frame", x=CONTENT_X, y=130, width=1000, height=860, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _shape("Desk rule", x=1160, y=130, width=2, height=860, fill=_solid("token:colors.border")),
    ]
    if plan.eyebrow:
        elements.append(_text(role="eyebrow", x=1200, y=130, width=600, height=36, content=_rich_text(plan.eyebrow), token="caption",
                              size=22, weight=700, color="token:colors.foregroundMuted", letter_spacing=2, transform_case="uppercase", align="left"))
    elements.append(_display_stack(plan.headline, x=1200, y=190, width=600, height=520, size=130, minimum=52,
                                   line_height=1.02, weight=800, letter_spacing=-2, color="token:colors.foreground", lines=4))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=1200, y=750, width=600, height=240, content=_rich_text(copy), token="body", size=34,
                              color="token:colors.foreground", fit="shrinkToFit", min_font_size=22, line_height=1.4, align="left"))
    return elements


# ==================================================================== earth story
#
# A field journal: a block of the theme's earth colour, arched frames for
# photographs, a low hill along the foot of a slide, a serif voice, and lists
# walked as stepping stones.


def _earth_hill() -> dict[str, Any]:
    return _shape("Hill", kind="ellipse", x=-0.0, y=860, width=VIEWPORT_W, height=220, fill=_solid("token:colors.accentMuted"))


def _earth_eyebrow(text: str, *, x: float = CONTENT_X, y: float, width: float = 1000, color: str = "token:colors.secondary") -> dict[str, Any]:
    return _text(role="eyebrow", x=x, y=y, width=width, height=40, content=_rich_text(text), token="caption", size=22, weight=700, color=color, letter_spacing=3, transform_case="uppercase", align="left")


def _earth_display(text: str, *, x: float = CONTENT_X, y: float, width: float, size: float, height: float, minimum: float, color: str = "token:colors.foreground") -> dict[str, Any]:
    return _text(role="headline", x=x, y=y, width=width, height=height, content=_rich_text(text), token="display", size=size, weight=600, color=color, fit="shrinkToFit", min_font_size=minimum, line_height=1.1, align="left")


def earth_title(plan: SlidePlan) -> Elements:
    """A field-journal collage: a serif stack, specimen prints, a torn landscape.

    Measured from the design-system v3 concept (2026-10-14). The landscape is
    torn along its left edge; a botanical card, a sage disc and a tree ring
    overlap its foot, and three mounted prints sit under the title.
    """
    paper = "token:colors.surface"
    elements: Elements = [
        _shape("Field paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Arch frame", x=1171, y=104, width=640, height=870, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    # The torn edge: a ragged strip of paper over the photograph's left side.
    tear = [(1150, 104)]
    for k in range(1, 30):
        tear.append((1186 + (17 if k % 2 else -6) + (k % 3) * 4, 104 + k * 30))
    tear.append((1150, 974))
    elements.append(_path("Torn paper", [("M", *tear[0])] + [("L", *p) for p in tear[1:]] + [("Z",)], fill=_solid(paper)))

    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, x=120, y=64, width=760, color="token:colors.secondary"))
    elements.append(_display_stack(plan.headline, x=118, y=108, width=820, height=430, size=240, minimum=84,
                                   line_height=0.9, weight=500, color="token:colors.accent", accent="token:colors.secondary",
                                   transform_case="uppercase"))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=120, y=548, width=780, height=40, content=_rich_text(plan.subtitle), token="body",
                              size=24, color="token:colors.foregroundMuted", align="left"))

    # Three specimen prints on paper mounts: two side by side, one beneath.
    for name, x, y in (("Earth detail frame", 120, 610), ("Earth texture frame", 370, 610), ("Earth texture frame", 120, 846)):
        elements.append(_shape("Print mount", x=x - 10, y=y - 10, width=224, height=214, fill=_solid(paper)))
        elements.append(_shape(name, x=x, y=y, width=204, height=194, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"))

    # The botanical card, tilted, with a line drawing of a stem.
    card = _shape("Botanical card", x=938, y=528, width=210, height=330, fill=_solid(paper), rotation=-6)
    elements.append(card)
    elements.append(_shape("Botanical stem", x=1040, y=574, width=3, height=250, fill=_solid("token:colors.secondary"), opacity=0.7, rotation=-6))
    for i, side in enumerate((-1, 1, -1, 1, -1)):
        leaf = _shape("Botanical leaf", kind="ellipse", x=1000 + (side > 0) * 48, y=596 + i * 44, width=74, height=30, fill=_none(),
                      stroke=_line("token:colors.secondary", 2.5), opacity=0.75)
        leaf["transform"]["rotation"] = side * 28 - 6
        elements.append(leaf)
    # The tree ring runs off the foot of the slide; the sage disc sits on it.
    elements.append(_clipped_circle("Tree ring", cx=1253, cy=960, r=218, fill=_solid("#D8BD94")))
    for d in (330, 240, 150, 64):
        if 960 + d / 2 <= VIEWPORT_H:
            elements.append(_shape("Ring line", kind="ellipse", x=1253 - d / 2, y=960 - d / 2, width=d, height=d, fill=_none(),
                                   stroke=_line("#A47D52", 2), opacity=0.7))
    elements.append(_shape("Sage disc", kind="ellipse", x=1066, y=712, width=200, height=200, fill=_solid("#8FA582")))
    return elements


def earth_statement(plan: SlidePlan) -> Elements:
    """A field note: the line in two colours, a torn photograph down the right."""
    elements: Elements = [
        _shape("Field paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Earth scene frame", x=1300, y=0, width=620, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _earth_torn(1300, 0, VIEWPORT_H),
        _shape("Sage disc", kind="ellipse", x=1180, y=180, width=200, height=200, fill=_solid("#8FA582")),
    ]
    elements += _earth_tree_ring(150, 1040, 230)
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, x=150, y=220, width=1000))
    elements.append(_display_stack(plan.headline, x=150, y=280, width=1060, height=420, size=210, minimum=72,
                                   line_height=1.0, weight=600, color="token:colors.accent", accent="token:colors.secondary"))
    if plan.subtitle or plan.body:
        elements.append(_text(role="subtitle", x=150, y=730, width=1000, height=150, content=_rich_text(plan.subtitle or plan.body or ""),
                              token="body", size=42, color="token:colors.foreground", fit="shrinkToFit", min_font_size=24,
                              line_height=1.35, align="left"))
    return elements


def earth_bullets(plan: SlidePlan) -> Elements:
    """A path of stepping stones: each item beside a round specimen print, walking down the slide."""
    elements: Elements = [
        _shape("Field paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
    ]
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=80, width=CONTENT_W, height=150, size=110, minimum=56,
                                   line_height=1.0, weight=600, color="token:colors.accent", align="center", lines=1))
    items = _bullets(plan, 5)
    row = 760 / max(len(items), 1)
    for i, item in enumerate(items):
        x = 360 + i * 150
        y = 270 + i * row
        size = min(150, row - 30)
        elements.append(_shape("Stone mount", kind="ellipse", x=x - 8, y=y - 8, width=size + 16, height=size + 16, fill=_solid("token:colors.surface")))
        elements.append(_shape("Earth stone frame", kind="ellipse", x=x, y=y, width=size, height=size, fill=_solid("token:colors.accentMuted"),
                               role="supportingVisual"))
        elements.append(_text(role="body", x=x + size + 48, y=y + 6, width=1500 - (x + size + 48) + 320, height=size - 12, content=_rich_text(item),
                              token="body", size=48, weight=500, color="token:colors.foreground", fit="shrinkToFit", min_font_size=24,
                              line_height=1.2, align="left"))
    return elements


def earth_metrics(plan: SlidePlan) -> Elements:
    """Each figure inside a tree ring: measured in years, like the wood."""
    elements: Elements = [
        _shape("Field paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
    ]
    elements.append(_display_stack(plan.headline, x=CONTENT_X, y=80, width=CONTENT_W, height=150, size=110, minimum=56,
                                   line_height=1.0, weight=600, color="token:colors.accent", align="center", lines=1))
    metrics = plan.metrics[:4]
    width = CONTENT_W / max(len(metrics), 1)
    for i, metric in enumerate(metrics):
        cx = CONTENT_X + width * (i + 0.5)
        r = min(220, width / 2 - 30)
        elements += _earth_tree_ring(cx, 520, r, name="Figure ring")
        elements.append(_text(role="metric", x=cx - r * 0.8, y=520 - r * 0.42, width=r * 1.6, height=r * 0.84, content=_rich_text(metric.value),
                              token="display", size=170, weight=600, color="token:colors.accent", fit="shrinkToFit",
                              min_font_size=56, line_height=1.0, align="center"))
        elements.append(_text(role="caption", x=cx - width / 2 + 30, y=780, width=width - 60, height=150, content=_rich_text(metric.label),
                              token="body", size=46, color="token:colors.foreground", fit="shrinkToFit", min_font_size=24,
                              line_height=1.15, align="center"))
    return elements


def earth_quote(plan: SlidePlan) -> Elements:
    """A portrait pinned to the page, the words beside it."""
    quote = plan.quote or plan.headline
    elements: Elements = [
        _shape("Field paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Sage disc", kind="ellipse", x=330, y=160, width=300, height=300, fill=_solid("#8FA582")),
        _shape("Print mount", x=140, y=250, width=440, height=560, fill=_solid("token:colors.surface"), rotation=-3),
        _shape("Arch frame", x=166, y=276, width=388, height=470, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _shape("Tape", x=200, y=226, width=150, height=48, fill=_solid("#D9C9A3"), opacity=0.85, rotation=-8),
    ]
    elements += _earth_tree_ring(1780, 980, 200)
    elements.append(_text(role="quote", x=720, y=200, width=1080, height=600, content=_rich_text(quote), token="display",
                          size=130, weight=600, color="token:colors.accent", fit="shrinkToFit", min_font_size=52,
                          line_height=1.08, align="left"))
    if plan.attribution:
        elements.append(_text(role="caption", x=720, y=840, width=900, height=60, content=_rich_text(plan.attribution), token="body",
                              size=38, color="token:colors.secondary", align="left"))
    return elements


def earth_split(plan: SlidePlan) -> Elements:
    """A torn landscape down the left, the line and its paragraph on paper beside it."""
    elements: Elements = [
        _shape("Field paper", x=0, y=0, width=VIEWPORT_W, height=VIEWPORT_H, fill=_solid("token:colors.background")),
        _shape("Arch frame", x=0, y=0, width=840, height=VIEWPORT_H, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
        _earth_torn(876, 0, VIEWPORT_H),
    ]
    elements += _earth_tree_ring(1700, 0, 200)
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, x=980, y=250, width=820))
    elements.append(_display_stack(plan.headline, x=980, y=310, width=820, height=420, size=160, minimum=60,
                                   line_height=1.02, weight=600, color="token:colors.accent", lines=3))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=980, y=770, width=800, height=220, content=_rich_text(copy), token="body", size=36,
                              color="token:colors.foreground", fit="shrinkToFit", min_font_size=22, line_height=1.45, align="left"))
    return elements


# ================================================================= spatial future
#
# A view into a space: glowing orbs, an orbit ring, glass panels that let the
# glow through, a light geometric display set centred, wide tracking.

SPACE_RADIUS = 32


def _space_glow() -> Elements:
    return [
        _shape("Cyan light volume", kind="ellipse", x=1120, y=0, width=800, height=800, fill=_radial("token:colors.accent", "token:colors.background"), opacity=0.58),
        _shape("Magenta light volume", kind="ellipse", x=0, y=520, width=600, height=560, fill=_radial("token:colors.secondary", "token:colors.background"), opacity=0.48),
        _shape("Lens orb", kind="ellipse", x=1220, y=610, width=250, height=250, fill=_radial("#FFFFFF99", "#7DD3FC00"), opacity=0.72),
    ]


def _space_glass(name: str, x: float, y: float, width: float, height: float) -> dict[str, Any]:
    panel = _shape(
        name, x=x, y=y, width=width, height=height,
        fill=_solid("#FFFFFF1F"), radius=SPACE_RADIUS,
        stroke=_line("#FFFFFF70", 1.2), opacity=0.92,
    )
    # A real material layer: the image below is blurred, the border catches a
    # highlight, an inner rim gives thickness, and the outer shadow separates
    # this plane from the next one.  PowerPoint keeps the translucent fill,
    # rim and shadows even though backdrop blur itself has no native equivalent.
    panel["style"]["backdropFilters"] = [
        {"type": "blur", "radius": 26},
        {"type": "saturate", "amount": 1.18},
    ]
    panel["style"]["shadow"] = [
        {"type": "drop", "offsetX": 0, "offsetY": 26, "blur": 56, "spread": -12, "color": "#050818A6"},
        {"type": "inner", "offsetX": 0, "offsetY": 2, "blur": 0, "spread": 0, "color": "#FFFFFF55"},
    ]
    return panel


def _space_eyebrow(text: str, *, y: float, x: float = CONTENT_X, width: float = CONTENT_W, align: str = "center") -> dict[str, Any]:
    return _text(role="eyebrow", x=x, y=y, width=width, height=40, content=_rich_text(text), token="caption", size=22, weight=600, color="token:colors.accent", letter_spacing=10, transform_case="uppercase", align=align)


def _space_display(text: str, *, y: float, size: float, height: float, minimum: float, x: float = CONTENT_X + 120, width: float = CONTENT_W - 240, align: str = "center") -> dict[str, Any]:
    return _text(role="headline", x=x, y=y, width=width, height=height, content=_rich_text(text), token="display", size=size, weight=500, fit="shrinkToFit", min_font_size=minimum, line_height=1.05, letter_spacing=-2, align=align)


def space_title(plan: SlidePlan) -> Elements:
    """A spatial cover: a wide luminous stack, a world without a frame, a strip.

    Measured from the design-system v3 concept (2026-10-14). The image has no
    border: it fades into the dark from the left so the light seems to come out
    of the slide itself. A ruler runs down the left edge; three framed
    thumbnails and a row of dots close the foot.
    """
    elements: Elements = [
        _shape("Hologram frame", x=720, y=0, width=1200, height=900, fill=_radial("token:colors.secondary", "token:colors.background"),
               role="supportingVisual"),
        _shape("Media veil", x=720, y=0, width=520, height=900, fill={"type": "linearGradient", "angle": 90, "stops": [
            {"offset": 0, "color": "token:colors.background"}, {"offset": 1, "color": "#1E1B4B00"},
        ]}),
        _shape("Media floor", x=720, y=640, width=1200, height=260, fill={"type": "linearGradient", "angle": 180, "stops": [
            {"offset": 0, "color": "#1E1B4B00"}, {"offset": 1, "color": "token:colors.background"},
        ]}),
        _shape("Ruler", x=74, y=70, width=2, height=940, fill=_solid("token:colors.foregroundSubtle"), opacity=0.6),
    ]
    for i in range(24):
        elements.append(_shape("Ruler tick", x=76, y=76 + i * 40, width=14 if i % 4 == 0 else 8, height=1.5,
                               fill=_solid("token:colors.foregroundSubtle"), opacity=0.6))
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=84, x=158, width=700, align="left"))
    elements.append(_display_stack(plan.headline, x=156, y=130, width=820, height=350, size=180, minimum=72,
                                   line_height=0.98, weight=500, color="token:colors.foreground",
                                   accent="token:colors.accent", letter_spacing=4, transform_case="uppercase"))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=160, y=500, width=640, height=80, content=_rich_text(plan.subtitle), token="body",
                              size=26, color="token:colors.foregroundMuted", line_height=1.4, align="left"))
    for i in range(3):
        x = 1258 + i * 204
        elements.append(_shape("Spatial thumbnail", x=x, y=902, width=180, height=102, fill=_solid("#10183B"), radius=8,
                               stroke=_line("token:colors.accent", 2), role="supportingVisual"))
    for i, colour in enumerate(("token:colors.secondary", "#FFFFFF66", "#FFFFFF44", "#FFFFFF33")):
        elements.append(_shape("Carousel dot", kind="ellipse", x=158 + i * 42, y=996, width=16, height=16, fill=_solid(colour)))
    elements.append(_shape("Carousel rule", x=346, y=1003, width=870, height=1.5, fill=_solid("token:colors.foregroundSubtle"), opacity=0.5))
    return _over_scene(elements, {"Hologram frame"})


def space_statement(plan: SlidePlan) -> Elements:
    """A luminous claim: the stack on the left, light and glass on the right."""
    elements: Elements = [
        _shape("Spatial scene frame", x=900, y=0, width=1020, height=VIEWPORT_H, fill=_radial("token:colors.secondary", "token:colors.background"),
               role="supportingVisual", opacity=0.9),
        _shape("Media veil", x=900, y=0, width=420, height=VIEWPORT_H, fill={"type": "linearGradient", "angle": 90, "stops": [
            {"offset": 0, "color": "token:colors.background"}, {"offset": 1, "color": "#1E1B4B00"},
        ]}),
    ]
    elements += _space_ruler()
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=200, x=160, width=1000, align="left"))
    elements.append(_display_stack(plan.headline, x=156, y=260, width=1100, height=440, size=200, minimum=72,
                                   line_height=1.0, weight=500, letter_spacing=-2, color="token:colors.foreground",
                                   accent="token:colors.accent"))
    if plan.subtitle or plan.body:
        elements.append(_text(role="subtitle", x=160, y=740, width=900, height=180, content=_rich_text(plan.subtitle or plan.body or ""),
                              token="body", size=42, color="token:colors.foregroundMuted", fit="shrinkToFit", min_font_size=24,
                              line_height=1.35, align="left"))
    return _over_scene(elements, {"Spatial scene frame"})


def space_bullets(plan: SlidePlan) -> Elements:
    """Tall glass cards side by side, a large number at the top of each."""
    elements = _space_glow() + _space_ruler()
    elements.append(_display_stack(plan.headline, x=160, y=90, width=1660, height=150, size=110, minimum=56,
                                   line_height=1.0, weight=500, color="token:colors.foreground", align="center", lines=1))
    items = _bullets(plan, 4)
    gap = 32
    width = (1660 - gap * (len(items) - 1)) / max(len(items), 1)
    for i, item in enumerate(items):
        x = 160 + i * (width + gap)
        elements.append(_space_glass("Glass card", x, 300, width, 680))
        elements.append(_text(role="decoration", x=x + 36, y=330, width=width - 72, height=170, content=_rich_text(f"{i + 1:02d}"),
                              token="display", size=150, weight=500, color="token:colors.accent", line_height=1.0, align="left"))
        elements.append(_text(role="body", x=x + 36, y=540, width=width - 72, height=400, content=_rich_text(item), token="body",
                              size=48, weight=500, color="token:colors.foreground", fit="shrinkToFit", min_font_size=24,
                              line_height=1.2, align="left"))
    return elements


def space_metrics(plan: SlidePlan) -> Elements:
    """Three glass panels on an orbit, the figures lit in the accent."""
    elements = _space_glow() + _space_ruler()
    elements.append(_display_stack(plan.headline, x=160, y=90, width=1660, height=150, size=110, minimum=56,
                                   line_height=1.0, weight=500, color="token:colors.foreground", align="center", lines=1))
    elements.append(_shape("Orbit ring", kind="ellipse", x=200, y=330, width=1580, height=620, fill=_none(),
                           stroke=_line("token:colors.accent", 2), opacity=0.5))
    metrics = plan.metrics[:4]
    gap = 40
    width = (1420 - gap * (len(metrics) - 1)) / max(len(metrics), 1)
    for i, metric in enumerate(metrics):
        x = 280 + i * (width + gap)
        elements.append(_space_glass("Glass panel", x, 360, width, 560))
        elements.append(_text(role="metric", x=x + 30, y=440, width=width - 60, height=250, content=_rich_text(metric.value), token="display",
                              size=200, weight=500, color="token:colors.accent", fit="shrinkToFit", min_font_size=64,
                              line_height=1.0, align="center"))
        elements.append(_text(role="caption", x=x + 30, y=720, width=width - 60, height=150, content=_rich_text(metric.label), token="body",
                              size=42, color="token:colors.foreground", fit="shrinkToFit", min_font_size=22, line_height=1.2, align="center"))
    return elements


def space_quote(plan: SlidePlan) -> Elements:
    """One wide pane of glass holding the words, two spheres at its corners."""
    quote = plan.quote or plan.headline
    elements = _space_glow() + _space_ruler()
    elements.append(_space_glass("Glass panel", 180, 130, 1580, 820))
    for x, y in ((1690, 90), (1690, 880)):
        elements.append(_shape("Glass sphere", kind="ellipse", x=x, y=y, width=110, height=110, fill=_radial("#FFFFFFAA", "#7DD3FC22"), opacity=0.9))
    elements.append(_text(role="quote", x=280, y=230, width=1380, height=540, content=_rich_text(quote), token="display",
                          size=140, weight=500, color="token:colors.foreground", fit="shrinkToFit", min_font_size=52,
                          line_height=1.06, letter_spacing=-1, align="left"))
    if plan.attribution:
        elements.append(_space_eyebrow(plan.attribution, y=820, x=280, width=1300, align="left"))
        elements[-1]["semanticRole"] = "caption"
        elements[-1]["typography"]["fontSize"] = 30
        elements[-1]["transform"]["height"] = 56
    return elements


def space_split(plan: SlidePlan) -> Elements:
    """A glowing object in its own pane on the left, the line beside it."""
    elements = _space_glow() + _space_ruler()
    elements.append(_shape("Hologram frame", x=180, y=140, width=760, height=800, fill=_radial("token:colors.secondary", "token:colors.surface"),
                           radius=SPACE_RADIUS, role="supportingVisual"))
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=230, x=1040, width=780, align="left"))
    elements.append(_display_stack(plan.headline, x=1040, y=290, width=780, height=440, size=160, minimum=60,
                                   line_height=1.02, weight=500, color="token:colors.foreground", lines=3))
    copy = plan.body or plan.subtitle or (" ".join(plan.bullets[:3]) if plan.bullets else "")
    if copy:
        elements.append(_text(role="body", x=1040, y=770, width=780, height=200, content=_rich_text(copy), token="body", size=36,
                              color="token:colors.foregroundMuted", fit="shrinkToFit", min_font_size=22, line_height=1.4, align="left"))
    return elements


MORE_LANGUAGE_LAYOUTS: dict[str, dict[SlideLayout, Any]] = {
    "play-lab": {
        SlideLayout.TITLE: play_title,
        SlideLayout.STATEMENT: play_statement,
        SlideLayout.BULLETS: play_bullets,
        SlideLayout.METRICS: play_metrics,
        SlideLayout.QUOTE: play_quote,
        SlideLayout.SPLIT: play_split,
    },
    "system-terminal": {
        SlideLayout.TITLE: term_title,
        SlideLayout.STATEMENT: term_statement,
        SlideLayout.BULLETS: term_bullets,
        SlideLayout.METRICS: term_metrics,
        SlideLayout.QUOTE: term_quote,
        SlideLayout.SPLIT: term_split,
        SlideLayout.CODE: term_code,
    },
    "quiet-luxe": {
        SlideLayout.TITLE: luxe_title,
        SlideLayout.STATEMENT: luxe_statement,
        SlideLayout.BULLETS: luxe_bullets,
        SlideLayout.METRICS: luxe_metrics,
        SlideLayout.QUOTE: luxe_quote,
        SlideLayout.SPLIT: luxe_split,
    },
    "data-desk": {
        SlideLayout.TITLE: desk_title,
        SlideLayout.STATEMENT: desk_statement,
        SlideLayout.BULLETS: desk_bullets,
        SlideLayout.METRICS: desk_metrics,
        SlideLayout.QUOTE: desk_quote,
        SlideLayout.SPLIT: desk_split,
    },
    "earth-story": {
        SlideLayout.TITLE: earth_title,
        SlideLayout.STATEMENT: earth_statement,
        SlideLayout.BULLETS: earth_bullets,
        SlideLayout.METRICS: earth_metrics,
        SlideLayout.QUOTE: earth_quote,
        SlideLayout.SPLIT: earth_split,
    },
    "spatial-future": {
        SlideLayout.TITLE: space_title,
        SlideLayout.STATEMENT: space_statement,
        SlideLayout.BULLETS: space_bullets,
        SlideLayout.METRICS: space_metrics,
        SlideLayout.QUOTE: space_quote,
        SlideLayout.SPLIT: space_split,
    },
}
