"""The built-in theme.

A single theme in Phase 1. The Creative Director agent proposes themes in Phase 5;
until then a deck needs one that is complete rather than one that is chosen, and
"complete" means every token group doc 02 §22 requires. A three-colour theme would
pass validation and give the Layout Agent nothing to reference.
"""

from __future__ import annotations

from typing import Any

from .ids import new_id

SANS = "Inter, ui-sans-serif, system-ui, sans-serif"
MONO = "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"


def neo_technical_theme() -> dict[str, Any]:
    return {
        "id": new_id("thm"),
        "name": "Neo Technical",
        "description": "Dark editorial layout with luminous technical accents.",
        "mode": "dark",
        "colors": {
            "background": "#0B0F14",
            "surface": "#121821",
            "surfaceAlt": "#1A222E",
            "overlay": "#000000B3",
            "foreground": "#E8EEF5",
            "foregroundMuted": "#9FB0C3",
            "foregroundSubtle": "#6B7C90",
            "accent": "#4CC2FF",
            # Guaranteed readable ON accent, so "text on an accent fill" has a
            # defined answer instead of every layout guessing (doc 02 §22.1).
            "accentForeground": "#04121C",
            "accentMuted": "#1E5F80",
            "secondary": "#A78BFA",
            "secondaryForeground": "#150C2E",
            "border": "#243141",
            "borderStrong": "#35485D",
            "divider": "#1C2530",
            "success": "#3DDC97",
            "warning": "#F2C14E",
            "danger": "#FF6B6B",
            "info": "#4CC2FF",
            # Ordered: series 0 always takes index 0, so chart colour assignment
            # never depends on data ordering.
            "chartSeries": ["#4CC2FF", "#A78BFA", "#3DDC97", "#F2C14E", "#FF6B6B", "#7DD3FC"],
            "chartPositive": "#3DDC97",
            "chartNegative": "#FF6B6B",
            "chartNeutral": "#6B7C90",
        },
        "typography": {
            "display": {"fontFamily": SANS, "fontSize": 96, "fontWeight": 700, "lineHeight": 1.05, "letterSpacing": -2},
            "h1": {"fontFamily": SANS, "fontSize": 64, "fontWeight": 700, "lineHeight": 1.1, "letterSpacing": -1},
            "h2": {"fontFamily": SANS, "fontSize": 44, "fontWeight": 600, "lineHeight": 1.15},
            "h3": {"fontFamily": SANS, "fontSize": 32, "fontWeight": 600, "lineHeight": 1.2},
            "body": {"fontFamily": SANS, "fontSize": 26, "fontWeight": 400, "lineHeight": 1.45},
            "bodySmall": {"fontFamily": SANS, "fontSize": 20, "fontWeight": 400, "lineHeight": 1.45},
            "caption": {"fontFamily": SANS, "fontSize": 18, "fontWeight": 400, "lineHeight": 1.4},
            "quote": {"fontFamily": SANS, "fontSize": 44, "fontWeight": 400, "fontStyle": "italic", "lineHeight": 1.3},
            "code": {"fontFamily": MONO, "fontSize": 22, "fontWeight": 400, "lineHeight": 1.5},
            # Tabular numerals. Without them a numberCount animation makes the
            # whole slide jitter as digit widths change (doc 02 §12.2).
            "metric": {"fontFamily": SANS, "fontSize": 84, "fontWeight": 700, "lineHeight": 1, "fontFeatures": ["tnum"]},
            "scaleRatio": 1.25,
        },
        "spacing": {
            "base": 8, "xs": 4, "sm": 8, "md": 16, "lg": 32, "xl": 64, "xxl": 96,
            "slideMargin": {"top": 80, "right": 120, "bottom": 80, "left": 120},
        },
        "radii": {"none": 0, "sm": 4, "md": 12, "lg": 24, "full": 9999},
        "shadows": {
            "none": [],
            "sm": [{"type": "drop", "offsetX": 0, "offsetY": 1, "blur": 3, "color": "#00000059"}],
            "md": [{"type": "drop", "offsetX": 0, "offsetY": 6, "blur": 18, "color": "#00000073"}],
            "lg": [{"type": "drop", "offsetX": 0, "offsetY": 18, "blur": 48, "color": "#00000099"}],
        },
        "grid": {"columns": 12, "gutter": 24, "margin": 120, "baseUnit": 8, "baselineGrid": 8},
        "chart": {
            "series": ["#4CC2FF", "#A78BFA", "#3DDC97", "#F2C14E", "#FF6B6B", "#7DD3FC"],
            "gridlineColor": "#1C2530",
            "axisColor": "#6B7C90",
            "showGridlines": True,
            "barCornerRadius": 4,
            "lineWidth": 3,
            "pointSize": 6,
        },
        "diagram": {
            "nodeFill": {"type": "solid", "color": "token:colors.surface"},
            "nodeStroke": {"paint": {"type": "solid", "color": "token:colors.border"}, "width": 1},
            "nodeRadius": 12,
            "nodePadding": {"top": 16, "right": 20, "bottom": 16, "left": 20},
        },
        "imagery": {"treatment": "none", "defaultCornerRadius": 12},
        "motion": {
            "personality": "technical",
            "defaultEntrance": "fadeUp",
            "defaultDurationMs": 400,
            "defaultEasing": "emphasized",
            "staggerMs": 70,
            "reducedMotionFallback": "fade",
            "maxSlideDurationMs": 2500,
        },
        "contrastPairs": [
            {"foreground": "colors.foreground", "background": "colors.background", "minimumRatio": 4.5},
            {"foreground": "colors.accentForeground", "background": "colors.accent", "minimumRatio": 4.5},
            {"foreground": "colors.foregroundMuted", "background": "colors.background", "minimumRatio": 3.0},
        ],
        "brandRules": [
            {
                "id": "type-sizes",
                "kind": "must-not",
                "scope": "typography",
                "statement": "Use no more than three type sizes on a single slide.",
                "check": {"type": "maxFontSizesPerSlide", "value": 3},
            },
            {
                "id": "whitespace",
                "kind": "should",
                "scope": "layout",
                "statement": "Use whitespace aggressively. A crowded technical slide reads as an unconsidered one.",
            },
        ],
    }
