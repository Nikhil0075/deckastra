"""Turning motion intent into animation tracks (doc 03 §12, doc 04 §24).

The Motion Agent says *what* moves and in what order, in semantic roles and one
word of pacing. This turns that into concrete `AnimationTrack`s on the slide:
which element, which preset, how long, and where the presenter's clicks fall.

The division is the same one the composer already enforces for space, applied to
time. It matters for one concrete reason beyond consistency: doc 04 §24.2 sets a
**2.5 second per-slide entrance budget**, and a budget only means something if
something enforces it. A model asked to respect a budget usually does; code that
computes the durations always does. So `_fit_to_budget` compresses a sequence
that would over-run rather than emitting one and warning about it.

Three smaller rules that follow from doc 04 §24.4:

- **Roles the plan does not name do not animate.** An element that is simply
  there from the first frame is the default, not the exception.
- **Long body text animates as one block or not at all.** Never per line.
- **Nothing is animated twice.** An element reached by a role appears in exactly
  one step, so two tracks can never fight over its opacity.
"""

from __future__ import annotations

from typing import Any, Iterable

from .ids import new_id

#: Pacing → base duration in milliseconds, and the gap between steps. Doc 04
#: §24.2's bands, reduced to the three registers a Motion Agent can name.
PACING = {
    "tight": {"durationMs": 300, "gapMs": 60},
    "measured": {"durationMs": 420, "gapMs": 110},
    "deliberate": {"durationMs": 600, "gapMs": 200},
}

#: Doc 04 §24.2. Overridable by a theme's `motion.maxSlideDurationMs`.
ENTRANCE_BUDGET_MS = 2_500

#: Past this many words a text block is something the audience needs to read
#: while the presenter is still talking (doc 04 §24.4).
READ_IMMEDIATELY_WORDS = 24

#: Presets this composer will emit. A plan naming anything else falls back to
#: `fade` — the renderer would degrade it anyway, and degrading here means the
#: document says what it will actually do.
KNOWN_PRESETS = {
    "fade",
    "slide",
    "scale",
    "blurReveal",
    "maskReveal",
    "staggerReveal",
    "springIn",
}


def animate_slide(
    slide: dict[str, Any],
    intent: dict[str, Any] | None,
    *,
    budget_ms: int = ENTRANCE_BUDGET_MS,
) -> list[str]:
    """Attach animation tracks to one composed slide, in place.

    Returns any warnings. Mutating the slide rather than returning tracks is
    deliberate: the caller has just built it, the tracks belong to it, and a
    second structure the caller has to remember to attach is a structure someone
    forgets to attach.
    """
    warnings: list[str] = []
    if not intent:
        return warnings

    sequence = [role for role in (intent.get("sequence") or []) if role]
    if not sequence:
        return warnings

    pacing = PACING.get(str(intent.get("pacing") or "measured"), PACING["measured"])
    preset = str(intent.get("entrance") or "fade")
    if preset not in KNOWN_PRESETS:
        warnings.append(
            f'"{preset}" is not a motion preset, so those elements fade in instead.'
        )
        preset = "fade"

    by_role = _elements_by_role(slide.get("elements") or [])
    steps: list[list[dict[str, Any]]] = []
    used: set[str] = set()

    for role in sequence:
        targets = [element for element in by_role.get(role, []) if element["id"] not in used]
        if not targets:
            continue

        skipped = [element for element in targets if _reads_immediately(element)]
        for element in skipped:
            warnings.append(
                f"{role} on \"{slide.get('name', 'a slide')}\" is long enough that the "
                "audience needs it immediately, so it was left in place."
            )

        animated = [element for element in targets if element not in skipped]
        if not animated:
            continue

        for element in animated:
            used.add(element["id"])
        steps.append(animated)

    if not steps:
        return warnings

    click_reveals = min(int(intent.get("click_reveals") or 0), max(0, len(steps) - 1))
    entrance_steps = len(steps) - click_reveals

    # The fan counts. A step holding six metrics is not one duration long — each
    # extra element is offset so they do not land on the same frame, and a budget
    # that ignored that would be satisfied by a slide that visibly over-runs.
    fanned = sum(max(0, len(step) - 1) for step in steps[:entrance_steps])

    duration, gap = _fit_to_budget(
        entrance_steps, fanned, pacing["durationMs"], pacing["gapMs"], budget_ms
    )
    if duration < pacing["durationMs"]:
        warnings.append(
            f"\"{slide.get('name', 'This slide')}\" had more to reveal than fits in "
            f"{budget_ms}ms, so the motion was tightened to fit."
        )

    tracks: list[dict[str, Any]] = []

    for index, step in enumerate(steps):
        clicked = index >= entrance_steps
        trigger = _trigger(index, clicked, entrance_steps)

        for offset, element in enumerate(step):
            tracks.append(
                {
                    "id": new_id("anm"),
                    "targetId": element["id"],
                    "trigger": trigger if offset == 0 else {"type": "withPrevious"},
                    "label": f"{element.get('semanticRole', 'element')} in",
                    "clips": [
                        {
                            "id": new_id("clp"),
                            "preset": _preset_for(element, preset),
                            # Several elements in one step arrive together, fanned
                            # by the pacing gap. `withPrevious` plus a startMs is
                            # how the schema expresses a stagger (doc 02 §25).
                            "startMs": 0 if offset == 0 else offset * min(gap, MAX_FAN_MS),
                            "durationMs": duration,
                            "easing": "emphasized",
                        }
                    ],
                }
            )

        # The gap between steps is a delay on the *next* track's trigger, not a
        # longer clip: stretching the clip would slow the motion rather than
        # spacing it.
        if index + 1 < entrance_steps and gap > 0:
            tracks[-1]["clips"][0]["_gapMs"] = gap

    _apply_gaps(tracks)
    slide["animations"] = tracks
    return warnings


def _trigger(index: int, clicked: bool, entrance_steps: int) -> dict[str, Any]:
    if clicked:
        # A click opens a segment: playback runs to the boundary and waits, which
        # is what the presenter's arrow key advances (doc 04 §25.1).
        return {"type": "click"}
    if index == 0:
        return {"type": "slideEnter"}
    return {"type": "afterPrevious"}


def _apply_gaps(tracks: list[dict[str, Any]]) -> None:
    """Turn the marked gaps into `timer` triggers on the following track.

    Written as a second pass because the gap belongs between two tracks and only
    the first of them is known when it is decided.
    """
    for index, track in enumerate(tracks):
        clip = track["clips"][0]
        gap = clip.pop("_gapMs", None)
        if gap is None or index + 1 >= len(tracks):
            continue

        following = tracks[index + 1]
        if following["trigger"].get("type") == "afterPrevious":
            following["trigger"] = {"type": "timer", "delayMs": int(gap)}


#: The offset between elements revealed within one step. Capped so a step with
#: many elements fans rather than queues.
MAX_FAN_MS = 90


def _fit_to_budget(
    steps: int, fanned: int, duration_ms: int, gap_ms: int, budget_ms: int
) -> tuple[int, int]:
    """Compress a sequence until its entrance fits.

    The total is `steps * duration + (steps - 1) * gap + fanned * fan`, where
    `fanned` counts the extra elements sharing a step. Scaling duration and gap by
    the same factor keeps the rhythm the pacing asked for; shortening only the
    gaps would turn a deliberate slide into a hurried one with long pauses.

    Floored at 150ms, because below that the motion is a flicker and the honest
    thing is a slide that appears rather than one that twitches.
    """
    if steps <= 0:
        return duration_ms, gap_ms

    def total(duration: int, gap: int) -> int:
        return (
            steps * duration
            + max(0, steps - 1) * gap
            + fanned * min(gap, MAX_FAN_MS)
        )

    if total(duration_ms, gap_ms) <= budget_ms:
        return duration_ms, gap_ms

    # Two passes: scale, then floor. Flooring the duration at 150 can push the
    # total back over, so the gap absorbs whatever is left rather than the slide
    # silently exceeding its budget.
    scale = budget_ms / total(duration_ms, gap_ms)
    duration = max(150, int(duration_ms * scale))
    gap = max(0, int(gap_ms * scale))

    while gap > 0 and total(duration, gap) > budget_ms:
        gap -= 1

    return duration, gap


def _elements_by_role(elements: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Top-level elements grouped by semantic role, in document order.

    Top-level only, deliberately. A group's children are animated through the
    group with `staggerReveal`, and reaching inside one here would produce two
    tracks fighting over the same opacity.
    """
    grouped: dict[str, list[dict[str, Any]]] = {}
    for element in elements:
        role = element.get("semanticRole")
        if not role:
            continue
        grouped.setdefault(str(role), []).append(element)
    return grouped


def _reads_immediately(element: dict[str, Any]) -> bool:
    """Text the audience needs while the presenter is still talking (doc 04 §24.4)."""
    if element.get("type") != "text":
        return False

    content = element.get("content") or {}
    words = 0
    for block in content.get("blocks") or []:
        for span in block.get("spans") or []:
            words += len(str(span.get("text", "")).split())

    return words > READ_IMMEDIATELY_WORDS


def _preset_for(element: dict[str, Any], preset: str) -> str:
    """The preset actually used for one element.

    A group asked to animate as a whole becomes a stagger over its children —
    a group draws no content of its own, so animating it as one block moves a
    list as a slab rather than revealing it.
    """
    if element.get("type") == "group" and preset != "staggerReveal":
        return "staggerReveal"
    return preset
