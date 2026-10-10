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

from typing import Any

from .ids import new_id
from .compose import CONTENT_BOTTOM, CONTENT_TOP, CONTENT_W, CONTENT_X, VIEWPORT_H, VIEWPORT_W, _rich_list, _rich_text
from .language_kit import _line, _none, _radial, _rotated, _shape, _solid, _text
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
    elements = _play_bubbles()
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, y=200)
    elements.append(_play_display(plan.headline, y=310, size=136, height=400, minimum=72))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=CONTENT_X, y=760, width=1100, height=110, content=_rich_text(plan.subtitle), token="body", size=34, color="token:colors.foregroundMuted", line_height=1.35, align="left"))
    return elements


def play_statement(plan: SlidePlan) -> Elements:
    elements = _play_bubbles()
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow)
    elements.append(_play_display(plan.headline, y=270, size=100, height=320, minimum=56))
    copy = plan.subtitle or plan.body
    if copy:
        elements.append(_shape("Note card", x=CONTENT_X, y=640, width=1200, height=260, fill=_solid("token:colors.surface"), radius=PLAY_RADIUS))
        elements.append(_text(role="body", x=CONTENT_X + 56, y=680, width=1088, height=180, content=_rich_text(copy), token="body", size=32, line_height=1.4, align="left"))
    return elements


def play_bullets(plan: SlidePlan) -> Elements:
    elements = _play_bubbles()
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, y=100)
    elements.append(_play_display(plan.headline, y=190, size=72, height=170, minimum=44, width=1400))
    items = _bullets(plan, 4)
    card_w, card_h, gap = (CONTENT_W - 40) / 2, 230, 40
    for i, item in enumerate(items):
        cx = CONTENT_X + (i % 2) * (card_w + gap)
        cy = 410 + (i // 2) * (card_h + gap)
        elements.append(_shape("Idea card", x=cx, y=cy, width=card_w, height=card_h, fill=_solid("token:colors.surface"), radius=PLAY_RADIUS))
        elements.append(_shape("Number bubble", kind="ellipse", x=cx + 40, y=cy + 40, width=84, height=84, fill=_solid("token:colors.accent")))
        elements.append(_text(role="decoration", x=cx + 40, y=cy + 52, width=84, height=60, content=_rich_text(str(i + 1)), token="display", size=40, weight=800, color="token:colors.accentForeground", line_height=1.2, align="center"))
        elements.append(_text(role="body", x=cx + 156, y=cy + 44, width=card_w - 196, height=card_h - 80, content=_rich_text(item), token="body", size=32, weight=600, fit="shrinkToFit", min_font_size=22, line_height=1.3, align="left"))
    return elements


def play_metrics(plan: SlidePlan) -> Elements:
    elements = _play_bubbles()
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, y=100)
    elements.append(_play_display(plan.headline, y=190, size=72, height=170, minimum=44, width=1400))
    metrics = plan.metrics[:4]
    if metrics:
        tiles = [("token:colors.accent", "token:colors.accentForeground"), ("token:colors.secondary", "token:colors.secondaryForeground"), ("token:colors.surface", "token:colors.foreground"), ("token:colors.surfaceAlt", "token:colors.foreground")]
        gap = 36
        width = (CONTENT_W - gap * (len(metrics) - 1)) / len(metrics)
        for i, metric in enumerate(metrics):
            fill, ink = tiles[i % len(tiles)]
            x = CONTENT_X + i * (width + gap)
            elements.append(_shape("Metric tile", x=x, y=430, width=width, height=420, fill=_solid(fill), radius=PLAY_RADIUS))
            elements.append(_text(role="metric", x=x + 36, y=500, width=width - 72, height=160, content=_rich_text(metric.value), token="metric", size=120, weight=800, color=ink, fit="shrinkToFit", min_font_size=56, line_height=1, align="left"))
            elements.append(_text(role="caption", x=x + 36, y=690, width=width - 72, height=120, content=_rich_text(metric.label), token="body", size=28, weight=600, color=ink, line_height=1.3, align="left"))
    if plan.caption:
        elements.append(_text(role="caption", x=CONTENT_X, y=900, width=1400, height=50, content=_rich_text(plan.caption), token="caption", size=22, color="token:colors.foregroundMuted", align="left"))
    return elements


def play_quote(plan: SlidePlan) -> Elements:
    elements = _play_bubbles()
    quote = plan.quote or plan.headline
    elements.append(_shape("Speech bubble", kind="speechBubble", x=CONTENT_X + 80, y=160, width=1440, height=600, fill=_solid("token:colors.surface"), radius=PLAY_RADIUS))
    elements.append(_text(role="quote", x=CONTENT_X + 180, y=240, width=1240, height=380, content=_rich_text(quote), token="quote", size=64, weight=700, fit="shrinkToFit", min_font_size=34, line_height=1.25, align="left"))
    if plan.attribution:
        elements.append(_shape("Avatar", kind="ellipse", x=CONTENT_X + 80, y=820, width=96, height=96, fill=_solid("token:colors.accent")))
        elements.append(_text(role="caption", x=CONTENT_X + 210, y=846, width=1000, height=50, content=_rich_text(plan.attribution), token="caption", size=28, weight=800, align="left"))
    return elements


def play_split(plan: SlidePlan) -> Elements:
    elements = [_shape("Bubble", kind="ellipse", x=1640, y=40, width=220, height=220, fill=_solid("token:colors.secondary"), opacity=0.25)]
    elements.append(_shape("Picture blob", x=CONTENT_X, y=150, width=760, height=780, fill=_solid("token:colors.surfaceAlt"), radius=120, role="supportingVisual"))
    text_x = CONTENT_X + 840
    text_w = RIGHT - text_x
    if plan.eyebrow:
        elements += _play_sticker(plan.eyebrow, x=text_x, y=170)
    elements.append(_text(role="headline", x=text_x, y=270, width=text_w, height=250, content=_rich_text(plan.headline), token="display", size=72, weight=800, fit="shrinkToFit", min_font_size=42, line_height=1.05, align="left"))
    copy_y = 560
    if plan.body:
        elements.append(_text(role="body", x=text_x, y=copy_y, width=text_w, height=140, content=_rich_text(plan.body), token="body", size=28, color="token:colors.foregroundMuted", line_height=1.4, align="left"))
        copy_y += 170
    items = _bullets(plan, 3)
    if items:
        elements.append(_text(role="body", x=text_x, y=copy_y, width=text_w, height=min(CONTENT_BOTTOM - copy_y - 20, len(items) * 64 + 20), content=_rich_list(items), token="body", size=28, weight=600, line_height=1.5, align="left"))
    return elements


# ================================================================= system terminal
#
# A terminal session: a window bar with its three buttons, monospace everything,
# a prompt before the eyebrow, line numbers in a gutter, a block cursor. The data
# is a table of boxes, the quote a block comment. Square corners, one green.

TERM_GUTTER = 96
TERM_X = CONTENT_X + TERM_GUTTER


def _term_window(lines: int = 0) -> Elements:
    out = [
        _shape("Window bar", x=0, y=0, width=VIEWPORT_W, height=56, fill=_solid("token:colors.surface")),
        # The motif is these three colours, so they are literal on purpose.
        _shape("Close button", kind="ellipse", x=28, y=18, width=20, height=20, fill=_solid("#FF5F57")),
        _shape("Minimise button", kind="ellipse", x=60, y=18, width=20, height=20, fill=_solid("#FEBC2E")),
        _shape("Zoom button", kind="ellipse", x=92, y=18, width=20, height=20, fill=_solid("#28C840")),
        _shape("Gutter rule", x=CONTENT_X + TERM_GUTTER - 28, y=CONTENT_TOP + 60, width=2, height=CONTENT_BOTTOM - CONTENT_TOP - 80, fill=_solid("token:colors.border")),
    ]
    if lines:
        numbers = "\n".join(f"{n:02d}" for n in range(1, lines + 1))
        out.append(_text(role="decoration", x=CONTENT_X, y=CONTENT_TOP + 70, width=56, height=lines * 62, content=_rich_list(numbers.split("\n"), "paragraph"), token="code", size=22, color="token:colors.foregroundSubtle", line_height=2.3, align="right"))
    return out


def _term_prompt(text: str, *, y: float = CONTENT_TOP + 70) -> dict[str, Any]:
    return _text(role="eyebrow", x=TERM_X, y=y, width=1200, height=40, content=_rich_text(f"$ {text.lower()}"), token="code", size=26, color="token:colors.accent", align="left")


def _term_display(text: str, *, y: float, size: float, height: float, minimum: float, width: float = CONTENT_W - TERM_GUTTER) -> dict[str, Any]:
    return _text(role="headline", x=TERM_X, y=y, width=width, height=height, content=_rich_text(text), token="code", size=size, weight=600, fit="shrinkToFit", min_font_size=minimum, line_height=1.15, letter_spacing=-1, align="left")


def _term_comment(text: str, *, y: float, height: float, size: float = 26, width: float = 1300) -> dict[str, Any]:
    return _text(role="subtitle", x=TERM_X, y=y, width=width, height=height, content=_rich_text(f"// {text}"), token="code", size=size, color="token:colors.foregroundMuted", line_height=1.5, align="left")


def term_title(plan: SlidePlan) -> Elements:
    elements = _term_window(lines=9)
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow, y=300))
    elements.append(_term_display(plan.headline, y=360, size=104, height=330, minimum=56))
    elements.append(_shape("Cursor", x=TERM_X, y=730, width=28, height=56, fill=_solid("token:colors.accent")))
    if plan.subtitle:
        elements.append(_term_comment(plan.subtitle, y=736, height=110, size=28, width=1400))
        elements[-1]["transform"]["x"] = TERM_X + 60
    return elements


def term_statement(plan: SlidePlan) -> Elements:
    elements = _term_window(lines=12)
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow))
    elements.append(_term_display(plan.headline, y=CONTENT_TOP + 160, size=80, height=300, minimum=44))
    copy = plan.subtitle or plan.body
    if copy:
        elements.append(_term_comment(copy, y=CONTENT_TOP + 520, height=200))
    return elements


def term_bullets(plan: SlidePlan) -> Elements:
    elements = _term_window(lines=12)
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow))
    elements.append(_term_display(plan.headline, y=CONTENT_TOP + 130, size=56, height=150, minimum=36))
    items = _bullets(plan, 6)
    if items:
        lines = [f"[{i + 1:02d}] {item}" for i, item in enumerate(items)]
        elements.append(_text(role="body", x=TERM_X, y=CONTENT_TOP + 320, width=CONTENT_W - TERM_GUTTER, height=min(CONTENT_BOTTOM - CONTENT_TOP - 360, len(items) * 82 + 30), content=_rich_list(lines, "paragraph"), token="code", size=32, line_height=1.9, align="left"))
    return elements


def term_metrics(plan: SlidePlan) -> Elements:
    elements = _term_window()
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow))
    elements.append(_term_display(plan.headline, y=CONTENT_TOP + 130, size=56, height=150, minimum=36))
    metrics = plan.metrics[:4]
    if metrics:
        gap = 0
        width = (CONTENT_W - TERM_GUTTER - gap * (len(metrics) - 1)) / len(metrics)
        for i, metric in enumerate(metrics):
            x = TERM_X + i * (width + gap)
            elements.append(_shape("Table cell", x=x, y=420, width=width, height=360, fill=_none(), stroke=_line("token:colors.borderStrong", 2)))
            elements.append(_text(role="caption", x=x + 32, y=450, width=width - 64, height=40, content=_rich_text(f"{i:02d} {metric.label.lower()}"), token="code", size=20, color="token:colors.foregroundMuted", align="left"))
            elements.append(_text(role="metric", x=x + 32, y=540, width=width - 64, height=180, content=_rich_text(metric.value), token="code", size=112, weight=600, color="token:colors.accent", fit="shrinkToFit", min_font_size=48, line_height=1, align="left"))
    if plan.caption:
        elements.append(_term_comment(plan.caption, y=830, height=60, size=22))
    return elements


def term_quote(plan: SlidePlan) -> Elements:
    elements = _term_window(lines=12)
    quote = plan.quote or plan.headline
    elements.append(_text(role="decoration", x=TERM_X, y=CONTENT_TOP + 120, width=200, height=64, content=_rich_text("/*"), token="code", size=40, color="token:colors.foregroundSubtle", align="left"))
    elements.append(_text(role="quote", x=TERM_X + 48, y=CONTENT_TOP + 200, width=CONTENT_W - TERM_GUTTER - 96, height=420, content=_rich_text(quote), token="code", size=52, weight=500, fit="shrinkToFit", min_font_size=30, line_height=1.4, align="left"))
    elements.append(_text(role="decoration", x=TERM_X, y=CONTENT_TOP + 650, width=200, height=64, content=_rich_text("*/"), token="code", size=40, color="token:colors.foregroundSubtle", align="left"))
    if plan.attribution:
        elements.append(_text(role="caption", x=TERM_X, y=CONTENT_TOP + 740, width=1200, height=44, content=_rich_text(f"-- {plan.attribution}"), token="code", size=26, color="token:colors.accent", align="left"))
    return elements


def term_split(plan: SlidePlan) -> Elements:
    elements = _term_window()
    if plan.eyebrow:
        elements.append(_term_prompt(plan.eyebrow))
    elements.append(_term_display(plan.headline, y=CONTENT_TOP + 130, size=56, height=150, minimum=36))
    pane_w = (CONTENT_W - TERM_GUTTER - 40) / 2
    for i in range(2):
        elements.append(_shape("Pane", x=TERM_X + i * (pane_w + 40), y=380, width=pane_w, height=CONTENT_BOTTOM - 420, fill=_solid("token:colors.surface")))
    if plan.body:
        elements.append(_text(role="body", x=TERM_X + 36, y=416, width=pane_w - 72, height=CONTENT_BOTTOM - 500, content=_rich_text(plan.body), token="code", size=26, line_height=1.6, align="left"))
    items = _bullets(plan, 5)
    if items:
        x = TERM_X + pane_w + 40 + 36
        elements.append(_text(role="body", x=x, y=416, width=pane_w - 72, height=min(CONTENT_BOTTOM - 500, len(items) * 70 + 20), content=_rich_list([f"> {item}" for item in items], "paragraph"), token="code", size=26, color="token:colors.foreground", line_height=1.7, align="left"))
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
        elements.append(_term_comment(plan.caption, y=360 + height, height=60, size=22))
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
    elements = [_shape("Portrait frame", x=1340, y=120, width=440, height=840, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual")]
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, y=250))
    elements.append(_luxe_hairline(LUXE_X, 310))
    elements.append(_luxe_display(plan.headline, x=LUXE_X, y=350, width=960, size=112, height=380, minimum=60))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=LUXE_X, y=770, width=860, height=100, content=_rich_text(plan.subtitle), token="body", size=26, color="token:colors.foregroundMuted", line_height=1.6, align="left"))
    return elements


def luxe_statement(plan: SlidePlan) -> Elements:
    column = 1080
    x = (VIEWPORT_W - column) / 2
    elements: Elements = []
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, x=x, y=240, width=column, align="center"))
    elements.append(_luxe_display(plan.headline, x=x, y=300, width=column, size=84, height=300, minimum=48, align="center"))
    copy = plan.subtitle or plan.body
    if copy:
        elements.append(_luxe_hairline((VIEWPORT_W - 80) / 2, 650))
        elements.append(_text(role="body", x=x + 90, y=690, width=column - 180, height=170, content=_rich_text(copy), token="body", size=26, color="token:colors.foregroundMuted", line_height=1.7, align="center"))
    return elements


def luxe_bullets(plan: SlidePlan) -> Elements:
    elements: Elements = []
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, y=220, width=560))
    elements.append(_luxe_display(plan.headline, x=LUXE_X, y=280, width=560, size=64, height=440, minimum=40))
    items = _bullets(plan, 4)
    list_x = 940
    for i, item in enumerate(items):
        y = 240 + i * 170
        elements.append(_shape("Hairline", x=list_x, y=y, width=LUXE_RIGHT - list_x, height=1, fill=_solid("token:colors.border")))
        elements.append(_text(role="decoration", x=list_x, y=y + 28, width=80, height=40, content=_rich_text(f"0{i + 1}"), token="caption", size=18, color="token:colors.accent", letter_spacing=4, align="left"))
        elements.append(_text(role="body", x=list_x + 100, y=y + 22, width=LUXE_RIGHT - list_x - 100, height=120, content=_rich_text(item), token="display", size=34, weight=400, fit="shrinkToFit", min_font_size=24, line_height=1.3, align="left"))
    return elements


def luxe_metrics(plan: SlidePlan) -> Elements:
    elements: Elements = []
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, y=220))
    elements.append(_luxe_display(plan.headline, x=LUXE_X, y=270, width=1200, size=60, height=170, minimum=38))
    metrics = plan.metrics[:4]
    if metrics:
        span = (LUXE_RIGHT - LUXE_X) / len(metrics)
        for i, metric in enumerate(metrics):
            x = LUXE_X + i * span
            if i:
                elements.append(_shape("Hairline", x=x, y=520, width=1, height=320, fill=_solid("token:colors.border")))
            pad = 0 if i == 0 else 48
            elements.append(_text(role="metric", x=x + pad, y=540, width=span - pad - 24, height=180, content=_rich_text(metric.value), token="display", size=132, weight=400, color="token:colors.accent", fit="shrinkToFit", min_font_size=60, line_height=1, align="left"))
            elements.append(_text(role="caption", x=x + pad, y=750, width=span - pad - 24, height=80, content=_rich_text(metric.label), token="caption", size=18, weight=600, letter_spacing=4, transform_case="uppercase", color="token:colors.foregroundMuted", line_height=1.4, align="left"))
    return elements


def luxe_quote(plan: SlidePlan) -> Elements:
    column = 1240
    x = (VIEWPORT_W - column) / 2
    quote = plan.quote or plan.headline
    elements: Elements = [_luxe_hairline((VIEWPORT_W - 80) / 2, 230)]
    elements.append(_text(role="quote", x=x, y=280, width=column, height=420, content=_rich_text(quote), token="quote", size=64, weight=400, fit="shrinkToFit", min_font_size=34, line_height=1.3, align="center"))
    if plan.attribution:
        elements.append(_luxe_eyebrow(plan.attribution, x=x, y=760, width=column, align="center"))
    return elements


def luxe_split(plan: SlidePlan) -> Elements:
    elements = [_shape("Portrait frame", x=LUXE_X, y=140, width=600, height=800, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual")]
    text_x = LUXE_X + 720
    text_w = LUXE_RIGHT - text_x
    if plan.eyebrow:
        elements.append(_luxe_eyebrow(plan.eyebrow, x=text_x, y=230, width=text_w))
    elements.append(_luxe_display(plan.headline, x=text_x, y=290, width=text_w, size=64, height=260, minimum=38))
    elements.append(_luxe_hairline(text_x, 590))
    copy = plan.body or " · ".join(_bullets(plan, 3))
    if copy:
        elements.append(_text(role="body", x=text_x, y=630, width=text_w, height=260, content=_rich_text(copy), token="body", size=26, color="token:colors.foregroundMuted", line_height=1.7, align="left"))
    return elements


# ====================================================================== data desk
#
# An operations dashboard: a header strip with the section and a status dot,
# tiles with hairline borders, figures that are the largest thing on the slide,
# small headlines, and a row of spark bars as the title's motif.

DESK_RADIUS = 12


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
    elements = _desk_header(plan)
    elements.append(_desk_headline(plan.headline, y=300, size=112, height=380, width=1000))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=CONTENT_X, y=720, width=900, height=100, content=_rich_text(plan.subtitle), token="body", size=30, color="token:colors.foregroundMuted", line_height=1.4, align="left"))
    # Spark bars: the dashboard's signature, rising to the right.
    heights = [140, 220, 180, 300, 260, 400, 360, 520]
    for i, h in enumerate(heights):
        elements.append(_shape("Spark bar", x=1240 + i * 70, y=880 - h, width=46, height=h, fill=_solid("token:colors.accent" if i == len(heights) - 1 else "token:colors.accentMuted"), radius=6))
    return elements


def desk_statement(plan: SlidePlan) -> Elements:
    elements = _desk_header(plan)
    elements.append(_desk_headline(plan.headline, y=260, size=88, height=300, width=1500))
    copy = plan.subtitle or plan.body
    if copy:
        elements.append(_desk_tile("Callout", CONTENT_X, 620, 1300, 220))
        elements.append(_shape("Callout stripe", x=CONTENT_X, y=620, width=10, height=220, fill=_solid("token:colors.accent")))
        elements.append(_text(role="body", x=CONTENT_X + 50, y=660, width=1210, height=150, content=_rich_text(copy), token="body", size=30, line_height=1.45, align="left"))
    return elements


def desk_bullets(plan: SlidePlan) -> Elements:
    elements = _desk_header(plan)
    elements.append(_desk_headline(plan.headline))
    items = _bullets(plan, 5)
    row_h, gap, top = 104, 16, 340
    for i, item in enumerate(items):
        y = top + i * (row_h + gap)
        elements.append(_desk_tile("Row", CONTENT_X, y, CONTENT_W, row_h))
        elements.append(_text(role="decoration", x=CONTENT_X + 32, y=y + 30, width=80, height=44, content=_rich_text(f"{i + 1:02d}"), token="metric", size=30, weight=700, color="token:colors.accent", align="left"))
        elements.append(_text(role="body", x=CONTENT_X + 130, y=y + 28, width=CONTENT_W - 170, height=60, content=_rich_text(item), token="body", size=30, weight=500, fit="shrinkToFit", min_font_size=22, align="left"))
    return elements


def desk_metrics(plan: SlidePlan) -> Elements:
    elements = _desk_header(plan)
    elements.append(_desk_headline(plan.headline))
    metrics = plan.metrics[:4]
    if metrics:
        gap = 32
        width = (CONTENT_W - gap * (len(metrics) - 1)) / len(metrics)
        for i, metric in enumerate(metrics):
            x = CONTENT_X + i * (width + gap)
            elements.append(_desk_tile("KPI tile", x, 340, width, 460))
            elements.append(_text(role="caption", x=x + 36, y=380, width=width - 72, height=70, content=_rich_text(metric.label), token="caption", size=22, weight=700, color="token:colors.foregroundMuted", transform_case="uppercase", letter_spacing=1, line_height=1.3, align="left"))
            elements.append(_text(role="metric", x=x + 36, y=490, width=width - 72, height=180, content=_rich_text(metric.value), token="metric", size=128, weight=700, fit="shrinkToFit", min_font_size=56, line_height=1, letter_spacing=-2, align="left"))
            elements.append(_shape("Trend bar", x=x + 36, y=720, width=(width - 72) * (0.9 - 0.15 * i), height=10, fill=_solid("token:colors.accent"), radius=5))
    if plan.caption:
        elements.append(_text(role="caption", x=CONTENT_X, y=850, width=1400, height=44, content=_rich_text(plan.caption), token="caption", size=20, color="token:colors.foregroundMuted", align="left"))
    return elements


def desk_quote(plan: SlidePlan) -> Elements:
    elements = _desk_header(plan)
    quote = plan.quote or plan.headline
    elements.append(_desk_tile("Quote tile", CONTENT_X, 220, CONTENT_W, 580))
    elements.append(_shape("Quote stripe", x=CONTENT_X, y=220, width=12, height=580, fill=_solid("token:colors.accent")))
    elements.append(_text(role="quote", x=CONTENT_X + 80, y=290, width=CONTENT_W - 160, height=360, content=_rich_text(quote), token="quote", size=56, weight=500, fit="shrinkToFit", min_font_size=32, line_height=1.3, align="left"))
    if plan.attribution:
        elements.append(_text(role="caption", x=CONTENT_X + 80, y=700, width=1200, height=44, content=_rich_text(plan.attribution), token="caption", size=24, weight=700, color="token:colors.foregroundMuted", align="left"))
    return elements


def desk_split(plan: SlidePlan) -> Elements:
    elements = _desk_header(plan)
    elements.append(_desk_headline(plan.headline))
    pane_w = (CONTENT_W - 32) / 2
    for i, label in enumerate(("Summary", "Details")):
        x = CONTENT_X + i * (pane_w + 32)
        elements.append(_desk_tile(f"{label} tile", x, 340, pane_w, CONTENT_BOTTOM - 380))
        elements.append(_text(role="decoration", x=x + 36, y=370, width=pane_w - 72, height=36, content=_rich_text(label), token="caption", size=20, weight=700, color="token:colors.foregroundMuted", transform_case="uppercase", letter_spacing=2, align="left"))
    if plan.body:
        elements.append(_text(role="body", x=CONTENT_X + 36, y=430, width=pane_w - 72, height=CONTENT_BOTTOM - 520, content=_rich_text(plan.body), token="body", size=28, line_height=1.5, align="left"))
    items = _bullets(plan, 5)
    if items:
        x = CONTENT_X + pane_w + 32 + 36
        elements.append(_text(role="body", x=x, y=430, width=pane_w - 72, height=min(CONTENT_BOTTOM - 520, len(items) * 66 + 20), content=_rich_list(items), token="body", size=28, line_height=1.55, align="left"))
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
    elements = [
        _shape("Earth block", x=0, y=0, width=880, height=VIEWPORT_H, fill=_solid("token:colors.accent")),
        _shape("Arch frame", kind="pill", x=1080, y=150, width=620, height=780, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual"),
    ]
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, y=260, width=680, color="token:colors.accentForeground"))
    elements.append(_earth_display(plan.headline, y=320, width=680, size=96, height=420, minimum=52, color="token:colors.accentForeground"))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=CONTENT_X, y=780, width=660, height=120, content=_rich_text(plan.subtitle), token="body", size=26, color="token:colors.accentForeground", line_height=1.45, align="left"))
    return elements


def earth_statement(plan: SlidePlan) -> Elements:
    elements = [_earth_hill(), _shape("Leaf", kind="ellipse", x=CONTENT_X, y=200, width=44, height=88, fill=_solid("token:colors.accent"), rotation=30)]
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, x=CONTENT_X + 80, y=224))
    elements.append(_earth_display(plan.headline, y=310, width=1400, size=88, height=300, minimum=48))
    copy = plan.subtitle or plan.body
    if copy:
        elements.append(_text(role="body", x=CONTENT_X, y=640, width=1100, height=160, content=_rich_text(copy), token="body", size=28, color="token:colors.foregroundMuted", line_height=1.6, align="left"))
    return elements


def earth_bullets(plan: SlidePlan) -> Elements:
    elements = [_earth_hill()]
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, y=CONTENT_TOP + 40))
    elements.append(_earth_display(plan.headline, y=CONTENT_TOP + 90, width=1500, size=64, height=160, minimum=40))
    items = _bullets(plan, 4)
    # Stepping stones: each item a little further along, as a path walked.
    for i, item in enumerate(items):
        x = CONTENT_X + i * 110
        y = 340 + i * 130
        elements.append(_shape("Stone", kind="ellipse", x=x, y=y, width=96, height=72, fill=_solid("token:colors.secondary")))
        elements.append(_text(role="decoration", x=x, y=y + 14, width=96, height=44, content=_rich_text(str(i + 1)), token="display", size=30, weight=700, color="token:colors.secondaryForeground", align="center"))
        elements.append(_text(role="body", x=x + 130, y=y + 10, width=RIGHT - x - 130, height=60, content=_rich_text(item), token="body", size=30, fit="shrinkToFit", min_font_size=22, align="left"))
    return elements


def earth_metrics(plan: SlidePlan) -> Elements:
    elements = [_earth_hill()]
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, y=CONTENT_TOP + 40))
    elements.append(_earth_display(plan.headline, y=CONTENT_TOP + 90, width=1500, size=64, height=160, minimum=40))
    metrics = plan.metrics[:4]
    if metrics:
        size = 300
        gap = (CONTENT_W - size * len(metrics)) / max(1, len(metrics) - 1) if len(metrics) > 1 else 0
        for i, metric in enumerate(metrics):
            x = CONTENT_X + i * (size + gap) if len(metrics) > 1 else (VIEWPORT_W - size) / 2
            elements.append(_shape("Seed", kind="ellipse", x=x, y=330, width=size, height=size, fill=_solid("token:colors.surfaceAlt")))
            elements.append(_text(role="metric", x=x + 30, y=420, width=size - 60, height=120, content=_rich_text(metric.value), token="display", size=88, weight=600, color="token:colors.accent", fit="shrinkToFit", min_font_size=40, line_height=1, align="center"))
            elements.append(_text(role="caption", x=x - 10, y=660, width=size + 20, height=100, content=_rich_text(metric.label), token="body", size=24, color="token:colors.foregroundMuted", line_height=1.35, align="center"))
    return elements


def earth_quote(plan: SlidePlan) -> Elements:
    quote = plan.quote or plan.headline
    elements = [_shape("Arch frame", kind="pill", x=CONTENT_X, y=160, width=420, height=600, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual")]
    elements.append(_text(role="quote", x=CONTENT_X + 520, y=220, width=RIGHT - CONTENT_X - 520, height=440, content=_rich_text(quote), token="quote", size=56, weight=500, fit="shrinkToFit", min_font_size=32, line_height=1.35, align="left"))
    if plan.attribution:
        elements.append(_earth_eyebrow(plan.attribution, x=CONTENT_X + 520, y=700))
    elements.append(_earth_hill())
    return elements


def earth_split(plan: SlidePlan) -> Elements:
    elements = [_shape("Arch frame", kind="pill", x=CONTENT_X, y=120, width=640, height=840, fill=_solid("token:colors.surfaceAlt"), role="supportingVisual")]
    text_x = CONTENT_X + 760
    text_w = RIGHT - text_x
    if plan.eyebrow:
        elements.append(_earth_eyebrow(plan.eyebrow, x=text_x, y=220, width=text_w))
    elements.append(_earth_display(plan.headline, x=text_x, y=280, width=text_w, size=64, height=240, minimum=38))
    y = 560
    if plan.body:
        elements.append(_text(role="body", x=text_x, y=y, width=text_w, height=150, content=_rich_text(plan.body), token="body", size=26, color="token:colors.foregroundMuted", line_height=1.6, align="left"))
        y += 180
    items = _bullets(plan, 3)
    if items:
        elements.append(_text(role="body", x=text_x, y=y, width=text_w, height=min(CONTENT_BOTTOM - y - 10, len(items) * 60 + 20), content=_rich_list(items), token="body", size=26, line_height=1.6, align="left"))
    return elements


# ================================================================= spatial future
#
# A view into a space: glowing orbs, an orbit ring, glass panels that let the
# glow through, a light geometric display set centred, wide tracking.

SPACE_RADIUS = 32


def _space_glow() -> Elements:
    return [
        _shape("Glow", kind="ellipse", x=1200, y=0, width=720, height=720, fill=_radial("token:colors.accent", "token:colors.background"), opacity=0.35),
        _shape("Glow", kind="ellipse", x=0, y=520, width=560, height=560, fill=_radial("token:colors.secondary", "token:colors.background"), opacity=0.3),
    ]


def _space_glass(name: str, x: float, y: float, width: float, height: float) -> dict[str, Any]:
    return _shape(name, x=x, y=y, width=width, height=height, fill=_solid("token:colors.overlay"), radius=SPACE_RADIUS, stroke=_line("token:colors.border", 1), opacity=0.55)


def _space_eyebrow(text: str, *, y: float, x: float = CONTENT_X, width: float = CONTENT_W, align: str = "center") -> dict[str, Any]:
    return _text(role="eyebrow", x=x, y=y, width=width, height=40, content=_rich_text(text), token="caption", size=22, weight=600, color="token:colors.accent", letter_spacing=10, transform_case="uppercase", align=align)


def _space_display(text: str, *, y: float, size: float, height: float, minimum: float, x: float = CONTENT_X + 120, width: float = CONTENT_W - 240, align: str = "center") -> dict[str, Any]:
    return _text(role="headline", x=x, y=y, width=width, height=height, content=_rich_text(text), token="display", size=size, weight=500, fit="shrinkToFit", min_font_size=minimum, line_height=1.05, letter_spacing=-2, align=align)


def space_title(plan: SlidePlan) -> Elements:
    elements = _space_glow()
    elements.append(_shape("Orbit ring", kind="ellipse", x=360, y=140, width=1200, height=800, fill=_none(), stroke=_line("token:colors.accent", 2), opacity=0.5))
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=300))
    elements.append(_space_display(plan.headline, y=370, size=128, height=330, minimum=64))
    if plan.subtitle:
        elements.append(_text(role="subtitle", x=CONTENT_X + 260, y=740, width=CONTENT_W - 520, height=100, content=_rich_text(plan.subtitle), token="body", size=30, color="token:colors.foregroundMuted", line_height=1.4, align="center"))
    return elements


def space_statement(plan: SlidePlan) -> Elements:
    elements = _space_glow()
    elements.append(_space_glass("Glass panel", 260, 200, VIEWPORT_W - 520, 680))
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=280, x=320, width=VIEWPORT_W - 640))
    elements.append(_space_display(plan.headline, y=340, size=84, height=280, minimum=44, x=360, width=VIEWPORT_W - 720))
    copy = plan.subtitle or plan.body
    if copy:
        elements.append(_text(role="body", x=420, y=660, width=VIEWPORT_W - 840, height=160, content=_rich_text(copy), token="body", size=28, color="token:colors.foregroundMuted", line_height=1.5, align="center"))
    return elements


def space_bullets(plan: SlidePlan) -> Elements:
    elements = _space_glow()
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=CONTENT_TOP + 50))
    elements.append(_space_display(plan.headline, y=CONTENT_TOP + 110, size=64, height=170, minimum=40))
    items = _bullets(plan, 4)
    if items:
        gap = 32
        width = (CONTENT_W - gap * (len(items) - 1)) / len(items)
        for i, item in enumerate(items):
            x = CONTENT_X + i * (width + gap)
            elements.append(_space_glass("Glass card", x, 400, width, 460))
            elements.append(_text(role="decoration", x=x + 36, y=440, width=width - 72, height=60, content=_rich_text(f"{i + 1:02d}"), token="display", size=44, weight=500, color="token:colors.accent", align="left"))
            elements.append(_text(role="body", x=x + 36, y=540, width=width - 72, height=280, content=_rich_text(item), token="body", size=30, fit="shrinkToFit", min_font_size=22, line_height=1.35, align="left"))
    return elements


def space_metrics(plan: SlidePlan) -> Elements:
    elements = _space_glow()
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=CONTENT_TOP + 50))
    elements.append(_space_display(plan.headline, y=CONTENT_TOP + 110, size=64, height=170, minimum=40))
    metrics = plan.metrics[:4]
    if metrics:
        gap = 32
        width = (CONTENT_W - gap * (len(metrics) - 1)) / len(metrics)
        for i, metric in enumerate(metrics):
            x = CONTENT_X + i * (width + gap)
            elements.append(_space_glass("Glass tile", x, 400, width, 420))
            elements.append(_text(role="metric", x=x + 30, y=470, width=width - 60, height=170, content=_rich_text(metric.value), token="metric", size=120, weight=500, color="token:colors.accent", fit="shrinkToFit", min_font_size=56, line_height=1, align="center"))
            elements.append(_text(role="caption", x=x + 30, y=680, width=width - 60, height=100, content=_rich_text(metric.label), token="body", size=24, color="token:colors.foregroundMuted", line_height=1.35, align="center"))
    return elements


def space_quote(plan: SlidePlan) -> Elements:
    quote = plan.quote or plan.headline
    elements = [_shape("Glow", kind="ellipse", x=560, y=140, width=800, height=800, fill=_radial("token:colors.accent", "token:colors.background"), opacity=0.3)]
    elements.append(_text(role="quote", x=CONTENT_X + 160, y=280, width=CONTENT_W - 320, height=420, content=_rich_text(quote), token="quote", size=60, weight=400, fit="shrinkToFit", min_font_size=34, line_height=1.3, align="center"))
    if plan.attribution:
        elements.append(_space_eyebrow(plan.attribution, y=760))
    return elements


def space_split(plan: SlidePlan) -> Elements:
    elements = _space_glow()
    elements.append(_shape("Hologram frame", x=CONTENT_X, y=160, width=760, height=760, fill=_radial("token:colors.secondary", "token:colors.surface"), radius=SPACE_RADIUS, role="supportingVisual", opacity=0.8))
    text_x = CONTENT_X + 840
    text_w = RIGHT - text_x
    if plan.eyebrow:
        elements.append(_space_eyebrow(plan.eyebrow, y=220, x=text_x, width=text_w, align="left"))
    elements.append(_space_display(plan.headline, y=280, size=68, height=250, minimum=40, x=text_x, width=text_w, align="left"))
    y = 570
    if plan.body:
        elements.append(_text(role="body", x=text_x, y=y, width=text_w, height=140, content=_rich_text(plan.body), token="body", size=26, color="token:colors.foregroundMuted", line_height=1.5, align="left"))
        y += 170
    items = _bullets(plan, 3)
    if items:
        elements.append(_text(role="body", x=text_x, y=y, width=text_w, height=min(CONTENT_BOTTOM - y - 10, len(items) * 60 + 20), content=_rich_list(items), token="body", size=26, line_height=1.6, align="left"))
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
