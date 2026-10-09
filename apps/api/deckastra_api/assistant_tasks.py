"""Assistant computation on immutable snapshots; persistence belongs to the runner."""
from __future__ import annotations
import base64
import copy
import io
import os
import subprocess
import tempfile
from pathlib import Path
from collections import Counter
from typing import Any
from fastapi import HTTPException
from deckastra_agents.router import ModelRequest, ModelError
from . import agent_service, author_service, assistant_design, locales, speech, motion
from .patch import apply_patch


class UserFacingError(ModelError):
    """A refusal written for the person, shown as it stands.

    Everything else a job raises is classified before it is shown, because a
    model's text and the repair prompts sent back to it are not addressed to the
    person and may carry content from the deck or a source.
    """


def scope_errors(before, after, scope, task, locale=None):
    """Compare actual changed content, including wholesale/reparented operations."""
    errors = []
    if task == "translation":
        if {k: v for k, v in before.items() if k != "locales"} != {k: v for k, v in after.items() if k != "locales"}:
            errors.append("Translation jobs may only change locale overlays; source content is preserved.")
        for tag in set(before.get("locales", {})) | set(after.get("locales", {})):
            if locale and tag != locale and before.get("locales", {}).get(tag) != after.get("locales", {}).get(tag):
                errors.append("Translation jobs may only change the requested locale.")
        target = after.get("locales", {}).get(locale, {}) if locale else {}
        old_entries = before.get("locales", {}).get(locale, {}).get("entries", {})
        if any(entry != old_entries.get(path) and entry.get("reviewStatus") != "draft" for path, entry in target.get("entries", {}).items()):
            errors.append("Changed machine translation entries must remain draft until reviewed.")
    if scope["kind"] != "deck":
        old_assets = {asset["id"]: asset for asset in before.get("assets", [])}
        new_assets = {asset["id"]: asset for asset in after.get("assets", [])}
        if any(new_assets.get(asset_id) != entry for asset_id, entry in old_assets.items()):
            errors.append("Scoped edits cannot remove or rewrite existing asset manifest entries.")
        referenced = set(author_service._asset_ids([s for s in after["slides"] if s["id"] in scope["slide_ids"]]))
        if not (set(new_assets) - set(old_assets)) <= referenced:
            errors.append("New manifest entries must be referenced inside the selected scope.")
        for key in set(before) | set(after):
            if key not in {"slides", "assets", "locales"} and before.get(key) != after.get(key):
                errors.append(f"Out-of-scope document property: {key}")
        for locale in set(before.get("locales", {})) | set(after.get("locales", {})):
            old_overlay = before.get("locales", {}).get(locale, {})
            new_overlay = after.get("locales", {}).get(locale, {})
            exempt = {"entries", "status"} if task == "translation" else {"entries"}
            old_settings = {k: v for k, v in old_overlay.items() if k not in exempt}
            new_settings = {k: v for k, v in new_overlay.items() if k not in exempt}
            creating_translation = task == "translation" and not old_overlay and set(new_settings) <= {"locale", "direction"} and new_overlay.get("status") == "draft"
            if old_settings != new_settings and not creating_translation:
                errors.append("Scoped translations cannot change overlay settings.")
            old_entries, new_entries = old_overlay.get("entries", {}), new_overlay.get("entries", {})
            for path in set(old_entries) | set(new_entries):
                if old_entries.get(path) == new_entries.get(path):
                    continue
                if not any(path.startswith(f"/slides/id:{sid}/") for sid in scope["slide_ids"]):
                    errors.append(f"Out-of-scope translation: {path}")
                elif scope["kind"] == "elements" and not any(f"/id:{eid}/" in path for eid in scope["element_ids"]):
                    errors.append(f"Out-of-scope element translation: {path}")
        wanted = set(scope["slide_ids"])
        old = {s["id"]: s for s in before["slides"]}
        new = {s["id"]: s for s in after["slides"]}
        if [s["id"] for s in before["slides"]] != [s["id"] for s in after["slides"]]:
            errors.append("Scoped edits cannot add, remove or reorder slides.")
        for slide_id in set(old) | set(new):
            if slide_id not in wanted and old.get(slide_id) != new.get(slide_id):
                errors.append(f"Out-of-scope slide: {slide_id}")
        if scope["kind"] == "elements":
            ids = set(scope["element_ids"])
            def prune(value):
                if isinstance(value, list):
                    return [prune(v) for v in value if not isinstance(v, dict) or v.get("id") not in ids]
                if isinstance(value, dict):
                    return {k: prune(v) for k, v in value.items()}
                return value
            if prune(before["slides"]) != prune(after["slides"]):
                errors.append("The patch changes objects outside the selected elements.")
    if task == "motion":
        def without_motion(value):
            value = copy.deepcopy(value)
            for slide in value.get("slides", []):
                slide.pop("animations", None)
            return value
        if without_motion(before) != without_motion(after):
            errors.append("Motion jobs may only change animation tracks; geometry, text and data are preserved.")
    return errors


def compute(request, snapshot, client, budget, emit):
    return _compute(request, snapshot, client, budget, emit)


def _compute(request, snapshot, client, budget, emit):
    document = snapshot["document"]
    task = request["task"]
    if task == "tidy":
        emit({"status": "working", "provider": "engine", "message": "Applying the editor's deterministic design fixes"})
        before = assistant_design.check(document, action="fix_all", scope=request["scope"])
        operations = before["operations"]
        candidate, _ = apply_patch(document, operations) if operations else (document, [])
        errors = author_service.check(document, operations) if operations else []
        errors += scope_errors(document, candidate, request["scope"], task)
        after = assistant_design.check(candidate)
        errors += [f["message"] for f in assistant_design.regressions({"findings": before["baseline_findings"]}, after)]
        if errors:
            raise UserFacingError("The automatic layout fixes would have created new problems, so nothing was changed. Use Design Check to fix these findings one at a time.")
        remaining = [f for f in after["findings"] if request["scope"]["kind"] == "deck" or f["slideId"] in request["scope"]["slide_ids"]]
        return {"operations": operations, "summary": f"Prepared {len(operations)} deterministic layout adjustments.", "warnings": [f["message"] for f in remaining], "findings": remaining, "provider": "engine"}
    if task == "motion":
        return plan_motion(request, document)
    if task == "image":
        answer = client.complete(ModelRequest(task_type="media", stage="image", system="Create one image for a presentation. Follow the brief; omit text unless explicitly requested.", messages=[{"role": "user", "content": request["instruction"]}], max_tokens=4096, image_output=True), budget)
        images = [p["inlineData"] for p in answer.provider_parts if "inlineData" in p]
        if len(images) != 1:
            raise UserFacingError("The image model did not return exactly one picture, so nothing was added. Any usage is recorded in the run; try again with a simpler description.")
        raw = base64.b64decode(images[0]["data"], validate=True)
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 16_000_000 or len(raw) > 20_000_000:
                raise UserFacingError("Generated image exceeds the asset limit.")
            output = io.BytesIO()
            image.convert("RGB").save(output, "PNG")
            return {"media": [{"base64": base64.b64encode(output.getvalue()).decode(), "kind": "image", "content_type": "image/png", "extension": "png", "width": image.width, "height": image.height, "provider": answer.model}]}
    if task == "video":
        emit({"status": "working", "provider": "vertex", "message": "Generating one bounded video clip"})
        result = client.generate(request["instruction"], duration_seconds=request["video_duration_seconds"],
                                 aspect_ratio=request["video_aspect_ratio"], budget=budget)
        if len(result.data) > 32 * 1024 * 1024:
            raise UserFacingError("Generated video exceeds the 32MB clip limit.")
        poster = video_poster(result.data)
        return {"media": [
            {"base64": base64.b64encode(result.data).decode(), "kind": "video", "content_type": "video/mp4",
             "extension": "mp4", "width": result.width, "height": result.height,
             "duration_ms": result.duration_ms, "provider": result.model},
            {"base64": base64.b64encode(poster).decode(), "kind": "image", "content_type": "image/png",
             "extension": "png", "width": result.width, "height": result.height,
             "provider": "poster-frame"},
        ], "summary": "Generated one muted video clip and a deterministic poster frame."}
    if task == "speech":
        if speech.selected_speech_provider() == "google":
            voice = request["voice"]
            if voice == "default":
                available = [item["name"] for item in speech.voices(request["locale"]) if "-Chirp3-HD-" in item["name"]]
                if not available:
                    raise UserFacingError("No Google Chirp 3 HD voice is available for this language. Choose a supported language or configure a matching voice.")
                voice = available[0]
            if "-Chirp3-HD-" not in voice:
                raise UserFacingError("Assistant speech pricing is configured for Chirp 3 HD. Choose a Chirp3-HD voice to keep cost reservations accurate.")
            request = {**request, "voice": voice}
        jobs = []
        for slide in document["slides"]:
            if request["scope"]["kind"] != "deck" and slide["id"] not in request["scope"]["slide_ids"]:
                continue
            for cue in slide.get("narration", {}).get("cues", []):
                script = locales.script_entry(document, slide["id"], cue, request["locale"])
                if isinstance(script, dict):
                    script = script.get(request.get("locale"), script.get("source", ""))
                if script:
                    take = cue.get("takes", {}).get(request["locale"], {})
                    if take.get("textHash") == locales.text_hash(script) and (request["voice"] == "default" or take.get("voice") == request["voice"]):
                        continue
                    jobs.append((slide["id"], cue, script))
        if not jobs:
            return {"media": [], "warnings": ["No unvoiced or changed narration scripts were found in the requested scope."]}
        if len(jobs) > 40:
            raise UserFacingError("Choose a smaller scope: one speech job supports up to forty cues.")
        rate = float(__import__("os").environ.get("DECKASTRA_SPEECH_USD_PER_MILLION", "nan"))
        import math, uuid
        if speech.selected_speech_provider() != "stub" and (not math.isfinite(rate) or rate < 0):
            raise UserFacingError("Configure DECKASTRA_SPEECH_USD_PER_MILLION before paid narration.")
        media = []
        for slide_id, cue, script in jobs:
            budget.check_clock()
            cache_key = speech.cache_key(script, request["locale"], request["voice"], 1, speech.selected_speech_provider())
            cached = snapshot.get("speech_cached", lambda key: None)(cache_key)
            if cached:
                media.append({**cached, "slide_id": slide_id, "cue_id": cue["id"]})
                continue
            operation = uuid.uuid4().hex
            charge = 0 if speech.selected_speech_provider() == "stub" else len(script) * rate / 1_000_000
            if charge:
                budget.reserve_cost(operation, charge)
            if snapshot.get("speech_charge"):
                try:
                    snapshot["speech_charge"](len(script))
                except Exception:
                    if charge:
                        budget.reconcile_cost(operation, charge, 0)
                    raise
            try:
                result = speech.synthesize(script, locale=request["locale"], voice=request["voice"], accounted=True)
            except speech.SpeechError as exc:
                import httpx
                cause = exc.__cause__
                if charge and isinstance(cause, httpx.HTTPStatusError) and cause.response.status_code in (400, 401, 403, 404, 429):
                    budget.reconcile_cost(operation, charge, 0)
                raise
            if charge:
                budget.reconcile_cost(operation, charge, charge)
            media.append({"base64": base64.b64encode(result.data).decode(), "kind": "audio", "extension": result.extension, "content_type": result.content_type, "duration_ms": result.duration_ms, "provider": speech.selected_speech_provider(), "voice": result.voice, "text_hash": locales.text_hash(script), "slide_id": slide_id, "cue_id": cue["id"]})
            if snapshot.get("speech_save"):
                snapshot["speech_save"](cache_key, media[-1], operation if charge else None)
            if sum(len(item["base64"]) for item in media) > 32_000_000:
                raise UserFacingError("Generated narration exceeds the bounded job media limit.")
        return {"media": media}
    registry = agent_service.build_registry(lambda: document)
    raise UserFacingError("This assistant job is no longer available.")


def video_poster(data: bytes) -> bytes:
    """Extract the first useful frame with the same audited ffmpeg used by MP4 export."""
    executable = os.environ.get("DECKASTRA_FFMPEG", "ffmpeg").strip() or "ffmpeg"
    with tempfile.TemporaryDirectory(prefix="deckastra-poster-") as folder:
        source, target = Path(folder) / "clip.mp4", Path(folder) / "poster.png"
        source.write_bytes(data)
        command = [executable, "-y", "-loglevel", "error", "-ss", "0.25", "-i", str(source),
                   "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", str(target)]
        completed = subprocess.run(command, capture_output=True, timeout=60, windows_startupinfo=(
            (lambda info: (setattr(info, "dwFlags", info.dwFlags | subprocess.STARTF_USESHOWWINDOW),
                           setattr(info, "wShowWindow", subprocess.SW_HIDE), info)[2])(subprocess.STARTUPINFO())
            if os.name == "nt" else None))
        if completed.returncode or not target.is_file():
            raise UserFacingError("The generated clip could not produce its required poster frame.")
        poster = target.read_bytes()
        if len(poster) > 8 * 1024 * 1024:
            raise UserFacingError("The generated clip's poster frame exceeds the image limit.")
        return poster


def plan_motion(request, document):
    """Plan entrances with the product's motion planner without destroying authored motion.

    `animate_slide` writes a slide's whole track list, so a slide that already has
    tracks is skipped unless the person asked to replace them. A replacement keeps
    the slide's click count by default: narration cues are addressed to click
    steps, and a plan with fewer clicks leaves those lines playing nowhere (W323).
    Motion changes only animation tracks, so any finding the plan adds is the
    plan's doing and refuses it, warnings included.
    """
    scope = request["scope"]
    if scope["kind"] == "elements":
        raise HTTPException(422, "Motion planning supports slide or deck scope. Select a slide.")
    replace = bool(request.get("motion_replace"))
    operations, warnings, replaced = [], [], []
    for slide in document["slides"]:
        if scope["kind"] != "deck" and slide["id"] not in scope["slide_ids"]:
            continue
        existing = slide.get("animations") or []
        label = slide.get("name") or slide["id"]
        if existing and not replace:
            warnings.append(f'Kept the {len(existing)} existing animation tracks on "{label}". Choose to replace existing animation to re-plan this slide.')
            continue
        clicks = sum(1 for track in existing if (track.get("trigger") or {}).get("type") == "click")
        click_reveals = request.get("motion_click_reveals")
        animated = copy.deepcopy(slide)
        roles = list(dict.fromkeys(e.get("semanticRole") for e in slide["elements"] if e.get("semanticRole") and e.get("semanticRole") != "decoration"))
        planned_warnings = motion.animate_slide(animated, {"sequence": roles, "entrance": request.get("motion_entrance", "fade"), "pacing": request.get("motion_pacing", "measured"), "click_reveals": clicks if click_reveals is None else click_reveals})
        # The planner sequences by role, so bullets sharing one role are one step and
        # it can return fewer clicks than asked. Unless the person chose a count,
        # a slide that would lose its clicks keeps its own motion.
        planned_clicks = sum(1 for track in animated.get("animations") or [] if (track.get("trigger") or {}).get("type") == "click")
        if click_reveals is None and planned_clicks < clicks:
            warnings.append(f'Kept the existing animation on "{label}": the planner can rebuild {planned_clicks} of its {clicks} click reveals.')
            continue
        warnings += planned_warnings
        if animated.get("animations") != slide.get("animations"):
            operations.append({"op": "replace" if "animations" in slide else "add", "path": f"/slides/id:{slide['id']}/animations", "value": animated.get("animations", [])})
            if existing:
                replaced.append(label)
    if not operations:
        return {"operations": [], "summary": "No slides were changed." if warnings else "No motion changes were needed.", "warnings": warnings, "provider": "engine"}
    errors = author_service.check(document, operations)
    candidate, _ = apply_patch(document, operations) if not errors else (document, [])
    errors += scope_errors(document, candidate, scope, "motion")
    if errors:
        raise HTTPException(422, "The motion planner could not produce a valid plan for these slides; nothing was changed.")
    def identities(check):
        return Counter((f["code"], f["slideId"], f.get("elementId"), f["message"]) for f in check["findings"])
    added = identities(assistant_design.check(candidate)) - identities(assistant_design.check(document))
    if added:
        details = [message for (_, _, _, message) in added][:3]
        raise HTTPException(422, "The motion plan was not proposed because it would introduce new issues: " + " ".join(details))
    result = {"operations": operations, "summary": f"Prepared motion for {len(operations)} slides with the product's 2.5-second entrance budget.", "warnings": warnings, "provider": "engine"}
    if replaced:
        result["requires_review"] = "Replaces existing animation on " + ", ".join(f'"{label}"' for label in replaced)
    return result
