"""A PowerPoint theme, read into a Deckastra theme (Design tab review, 2026-09-26).

A company's brand usually arrives as a PowerPoint template: a `.thmx` theme, or
a `.pptx` whose theme part carries it. Both are zip packages with the theme in
one XML part, and the two facts worth carrying over are named in it: the colour
scheme (`a:clrScheme`: two darks, two lights, six accents) and the font scheme
(`a:fontScheme`: a heading face and a body face).

Read here rather than in the editor because a zip and an XML parser are the
standard library in Python and would be two new dependencies in the browser.
Only the theme part is read, and nothing in the package is executed or
followed. The package is bounded — size, entry count, the theme part's own
size — and a document type declaration is refused outright, because entity
expansion is how an XML part becomes a memory bomb.

The result is a complete `ThemeDefinition` built on one of the gallery's own
presets, so everything the scheme does not say (spacing, type scale, motion)
is a set of values the composer is already tuned against. What could not be
carried over is listed, not guessed at.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any
from xml.etree import ElementTree

from .ids import new_id
from .paths import resource_root

#: A theme file is kilobytes and a template deck rarely more than a few
#: megabytes; the cap only has to stop something that is not either.
MAX_PACKAGE_BYTES = 20 * 1024 * 1024
MAX_ENTRIES = 5_000
MAX_THEME_PART_BYTES = 2 * 1024 * 1024

_NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
_THEME_PART = re.compile(r"(^|/)theme/theme(\d*)\.xml$", re.IGNORECASE)


class OfficeThemeError(ValueError):
    """The file is not a PowerPoint theme this can read. The message says why, for a person."""


def theme_from_office(data: bytes) -> tuple[dict[str, Any], list[str]]:
    """A ThemeDefinition from a .thmx or .pptx, and what could not be carried over."""
    if len(data) > MAX_PACKAGE_BYTES:
        raise OfficeThemeError("That file is larger than a theme or template should be (over 20 MB).")
    try:
        package = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise OfficeThemeError("That is not a PowerPoint file (.thmx or .pptx).") from error

    with package:
        entries = package.infolist()
        if len(entries) > MAX_ENTRIES:
            raise OfficeThemeError("That file has more parts than a PowerPoint template would.")
        candidates = sorted(
            (entry for entry in entries if _THEME_PART.search(entry.filename)),
            # theme1 first: a deck's slide master theme is theme1, and a .thmx
            # has only one.
            key=lambda entry: (int(_THEME_PART.search(entry.filename).group(2) or 0), entry.filename),
        )
        if not candidates:
            raise OfficeThemeError("That file has no PowerPoint theme in it.")
        part = candidates[0]
        if part.file_size > MAX_THEME_PART_BYTES:
            raise OfficeThemeError("That file's theme part is too large to be a theme.")
        xml = package.read(part)

    if b"<!DOCTYPE" in xml[:4096].upper():
        raise OfficeThemeError("That theme declares a document type, which a PowerPoint theme never does.")
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as error:
        raise OfficeThemeError("That file's theme could not be read.") from error

    notes: list[str] = []
    scheme = root.find(".//a:clrScheme", _NS)
    if scheme is None:
        raise OfficeThemeError("That file's theme has no colour scheme.")
    colours = {child.tag.split("}")[1]: _colour(child, notes) for child in scheme}
    missing = [name for name in ("dk1", "lt1", "accent1") if not colours.get(name)]
    if missing:
        raise OfficeThemeError(f"That theme's colour scheme is missing {', '.join(missing)}.")

    major = _typeface(root, "majorFont")
    minor = _typeface(root, "minorFont")
    name = (root.get("name") or scheme.get("name") or "Imported theme").strip() or "Imported theme"

    return _build(name, colours, major, minor, notes), notes


def _colour(element: ElementTree.Element, notes: list[str]) -> str | None:
    srgb = element.find("a:srgbClr", _NS)
    if srgb is not None and re.fullmatch(r"[0-9A-Fa-f]{6}", srgb.get("val", "")):
        return "#" + srgb.get("val", "").upper()
    system = element.find("a:sysClr", _NS)
    if system is not None and re.fullmatch(r"[0-9A-Fa-f]{6}", system.get("lastClr", "")):
        # A system colour ("window text") is whatever Windows says it is on the
        # machine that saved the file; `lastClr` is what it was there.
        notes.append(f"{element.tag.split('}')[1]} is a Windows system colour; its last saved value was used.")
        return "#" + system.get("lastClr", "").upper()
    return None


def _typeface(root: ElementTree.Element, which: str) -> str | None:
    latin = root.find(f".//a:fontScheme/a:{which}/a:latin", _NS)
    face = (latin.get("typeface") if latin is not None else "") or ""
    # "+mj-lt" style references point back into the scheme itself; a theme
    # file that uses one for its own fonts has nothing to say.
    return face if face and not face.startswith("+") else None


def _rgb(hex_colour: str) -> tuple[float, float, float]:
    value = hex_colour.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _luminance(hex_colour: str) -> float:
    def channel(part: float) -> float:
        c = part / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = _rgb(hex_colour)
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    light, dark = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def _mix(a: str, b: str, amount: float) -> str:
    """`a` moved `amount` of the way toward `b`."""
    ra, rb = _rgb(a), _rgb(b)
    return "#" + "".join(f"{round(x + (y - x) * amount):02X}" for x, y in zip(ra, rb))


def _readable(on: str, *choices: str) -> str:
    return max(choices, key=lambda choice: contrast(choice, on))


def _template(dark: bool) -> dict[str, Any]:
    path = resource_root() / "packages" / "presentation-schema" / "generated" / "theme-presets.json"
    presets = json.loads(path.read_text(encoding="utf-8"))["presets"]
    key = "neo-technical" if dark else "minimal-light"
    return json.loads(json.dumps(next(p for p in presets if p["key"] == key)["theme"]))


def _build(name: str, c: dict[str, str | None], major: str | None, minor: str | None, notes: list[str]) -> dict[str, Any]:
    # A PowerPoint slide's background is the first light and its text the first
    # dark, whatever their brightness: a dark theme is one whose "light" is dark.
    background, foreground = c["lt1"], c["dk1"]
    dark = _luminance(background) < _luminance(foreground)
    surface = c.get("lt2") if not dark and c.get("lt2") else _mix(background, foreground, 0.05)
    surface_alt = _mix(surface, foreground, 0.08)

    theme = _template(dark)
    accents = [c.get(f"accent{i}") for i in range(1, 7)]
    series = [a for a in accents if a] or [c["accent1"]]
    while len(series) < 6:
        series.append(_mix(series[len(series) % len(series)], foreground, 0.35))

    accent = c["accent1"]
    secondary = c.get("accent2") or _mix(accent, foreground, 0.4)
    muted = _mix(foreground, background, 0.22)
    subtle = _mix(foreground, background, 0.38)
    if contrast(muted, background) < 4.5:
        muted = _mix(foreground, background, 0.1)

    colours = theme["colors"]
    colours.update(
        {
            "background": background,
            "surface": surface,
            "surfaceAlt": surface_alt,
            "foreground": foreground,
            "foregroundMuted": muted,
            "foregroundSubtle": subtle,
            "accent": accent,
            "accentForeground": _readable(accent, background, foreground, "#FFFFFF", "#000000"),
            "accentMuted": surface_alt,
            "secondary": secondary,
            "secondaryForeground": _readable(secondary, background, foreground, "#FFFFFF", "#000000"),
            "border": _mix(background, foreground, 0.18),
            "borderStrong": _mix(background, foreground, 0.4),
            "divider": _mix(background, foreground, 0.12),
            "info": accent,
            "chartSeries": series[:6],
            "chartNeutral": subtle,
        }
    )
    theme["chart"]["series"] = series[:6]
    theme["chart"]["gridlineColor"] = colours["divider"]
    theme["chart"]["axisColor"] = subtle

    for token in ("display", "h1", "h2", "h3", "quote", "metric"):
        if major:
            theme["typography"][token]["fontFamily"] = major
    for token in ("body", "bodySmall", "caption"):
        if minor:
            theme["typography"][token]["fontFamily"] = minor
    if not major or not minor:
        notes.append("The theme names no heading or body font of its own; the template's were kept.")

    if c.get("hlink"):
        notes.append("Hyperlink colours are not part of a Deckastra theme and were not carried over.")
    if contrast(foreground, background) < 4.5:
        notes.append(
            f"Text on the background is {contrast(foreground, background):.1f}:1, under the 4.5:1 WCAG AA asks for."
        )

    theme["id"] = new_id("thm")
    theme["name"] = name[:120]
    theme["description"] = "Imported from a PowerPoint theme."
    theme["mode"] = "dark" if dark else "light"
    # Only the pairs this import can stand behind: the ones it chose for
    # contrast. The template's own pairs described its colours, not these.
    theme["contrastPairs"] = [
        {"foreground": "colors.foreground", "background": "colors.background", "minimumRatio": 4.5},
        {"foreground": "colors.accentForeground", "background": "colors.accent", "minimumRatio": 4.5},
    ]
    return theme
