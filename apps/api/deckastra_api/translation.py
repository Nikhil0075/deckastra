"""Translating a deck (integration plan 01 §3.7).

The output of translation is **a proposal**, never a write. A machine
translation of forty slides is exactly the kind of change a person should read
before it is theirs, and the risk tier — computed on the server from the
operations, like every other change — says so: a large overlay arrives pending.
That is "agents propose, humans stay in control" applied to words.

What is translated is the slot list `locales.py` reads off the document, in
three scopes: what has no translation yet (`missing`), what has one whose source
changed (`outdated`), or every slot on some slides. Nothing else is touched;
an overlay can only ever replace words.

**Providers are chosen, never fallen back to.** Slide text sent to a cloud
service is a privacy decision, and making it silently because a preferred
provider was missing takes it on someone's behalf.

- `stub` — keyless, deterministic, and visibly not a translation: every result
  is the source text marked `[hi-IN]`. It lets the whole path run in a checkout
  and in CI without presenting generated text as a real translation.
- `google` — Cloud Translation, for an operator who configured it.

Unset means a checkout uses the stub. An installed product refuses until Cloud
Translation is explicitly configured.

**Protected spans** — numbers, URLs, e-mail addresses, code spans,
`{{placeholders}}` and the caller's do-not-translate terms — are replaced with
tokens before anything is sent and restored after. A translator that drops or
invents a token has changed a number on a slide, so that one slot is refused and
reported rather than written.

There is deliberately no general text-model translator. A person's coding
agent can author locale overlays through MCP, while the app's paid translation
path stays a bounded Cloud Translation service.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import httpx
from deckastra_agents.router import ModelUnavailable

from . import locales
from . import google_credentials

TRANSLATION_ENV = "DECKASTRA_TRANSLATION"
PROVIDERS = ("stub", "google")
#: How many slots go to a translator in one request: enough to preserve useful
#: slide context while keeping a failed provider call bounded.
BATCH = 40


class TranslationError(RuntimeError):
    """A translator answered, and the answer could not be used."""


@dataclass
class Item:
    id: str
    text: str
    #: Characters the slot has room for, when the slot has a box. A model is
    #: asked to stay within it; the real judgement is the render's overflow check.
    budget: int | None = None


class Translator(Protocol):
    name: str
    origin: str

    def translate(self, items: list[Item], *, source: str, target: str) -> dict[str, str]: ...


# ---------------------------------------------------------------- protection

_PROTECTED = re.compile(
    r"\{\{[^{}]{1,80}\}\}"  # placeholders
    r"|`[^`\n]{1,200}`"  # code spans
    r"|\[pause(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\]"  # narration pauses, kept for the voice
    r"|https?://[^\s<>\"]+"  # URLs
    r"|[\w.+-]+@[\w-]+(?:\.[\w-]+)+"  # e-mail
    # A word with a digit in it is a name, kept whole: "Q3", "H2O", "COVID-19",
    # "iPhone15". Masking only its digits left "Q⟦1⟧", which a live Google
    # translation read as "first quarter" and dropped the token from.
    r"|(?<!\w)(?=[\w-]*\d)(?=[\w-]*[^\W\d_])\w+(?:-\w+)*(?!\w)"
    r"|[$€£₹¥]?\d[\d,.:]*(?:\s?%|[kKmMbB]\b)?"  # numbers, money, percentages, times
)
_TOKEN = re.compile(r"⟦(\d+)⟧")


def mask(text: str, glossary: list[str] | None = None) -> tuple[str, list[str]]:
    """Replace protected spans with ⟦n⟧ tokens. Returns the masked text and the spans."""
    spans: list[str] = []

    def keep(match: re.Match[str]) -> str:
        spans.append(match.group(0))
        return f"⟦{len(spans) - 1}⟧"

    masked = text
    for term in sorted({term for term in (glossary or []) if term.strip()}, key=len, reverse=True):
        masked = re.sub(rf"(?<!\w){re.escape(term)}(?!\w)", keep, masked)
    # Numbers and the rest are found in what the glossary left, so a term with a
    # digit in it ("Web3") is kept whole rather than split.
    parts = re.split(r"(⟦\d+⟧)", masked)
    masked = "".join(part if _TOKEN.fullmatch(part) else _PROTECTED.sub(keep, part) for part in parts)
    return masked, spans


def unmask(text: str, spans: list[str]) -> str:
    """Put the spans back. Refuses an answer that lost, duplicated or invented a token."""
    found = [int(number) for number in _TOKEN.findall(text)]
    if sorted(found) != list(range(len(spans))):
        raise TranslationError("The translation changed a protected value (a number, link or kept term).")
    return _TOKEN.sub(lambda match: spans[int(match.group(1))], text)


# ------------------------------------------------------------------ providers


class StubTranslator:
    """Keyless and deterministic: the source text, marked with the target language."""

    name = "stub"
    origin = "stub"

    def translate(self, items: list[Item], *, source: str, target: str) -> dict[str, str]:
        return {item.id: f"[{target}] {item.text}" for item in items}


#: The few languages Cloud Translation lists *with* a region or script, because
#: the two variants translate differently. Everything else it lists by the bare
#: language code, and a regional tag such as ``hi-IN`` is not on its list.
_GOOGLE_REGIONAL = {"zh-cn": "zh-CN", "zh-tw": "zh-TW", "pt-pt": "pt-PT", "fr-ca": "fr-CA", "fa-af": "fa-AF", "mni-mtei": "mni-Mtei", "pa-arab": "pa-Arab", "ms-arab": "ms-Arab"}


def google_language(tag: str) -> str:
    """A deck's language tag as Cloud Translation names the language.

    ``hi-IN`` → ``hi``, ``ar-EG`` → ``ar``, ``zh-Hant-TW`` → ``zh-TW``,
    ``pt-PT`` stays. Sending the deck's tag through unchanged is a request for
    a language Google does not list, answered with a 400 the person would read
    as "translation is broken".
    """
    parts = [part for part in tag.replace("_", "-").split("-") if part]
    if not parts:
        return tag
    primary = parts[0].lower()
    lowered = "-".join(part.lower() for part in parts)
    if lowered in _GOOGLE_REGIONAL:
        return _GOOGLE_REGIONAL[lowered]
    if primary == "zh":
        rest = {part.lower() for part in parts[1:]}
        return "zh-TW" if rest & {"hant", "tw", "hk", "mo"} else "zh-CN"
    for part in parts[1:]:
        candidate = f"{primary}-{part.lower()}"
        if candidate in _GOOGLE_REGIONAL:
            return _GOOGLE_REGIONAL[candidate]
    return primary


def google_auth_headers(token: str) -> dict[str, str]:
    """Bearer auth, plus the project to bill when the token is a person's own.

    A token from ``gcloud auth print-access-token`` belongs to a user, not a
    service account, and Google refuses such calls with "requires a quota
    project" unless the request names one. Its own examples send this header.
    """
    headers = {"Authorization": f"Bearer {token}"}
    project = google_credentials.project()
    if project:
        headers["x-goog-user-project"] = project
    return headers


class GoogleTranslator:
    """Cloud Translation (plan 01 §3.7, plan 04).

    v3 with a project and an OAuth access token, which is where glossaries live;
    or v2 with an API key, for an operator who has only that. The masking above
    applies either way. Configured by environment, never by a deck.
    """

    name = "google"
    origin = "machine"

    def __init__(self) -> None:
        self.key = os.environ.get("DECKASTRA_GOOGLE_API_KEY", "").strip()
        # A token, or one minted from a credentials file (google_credentials.py).
        self.token = google_credentials.bearer_token() or ""
        self.project = google_credentials.project()
        self.location = os.environ.get("DECKASTRA_GOOGLE_LOCATION", "global").strip() or "global"
        self.glossary = os.environ.get("DECKASTRA_GOOGLE_GLOSSARY", "").strip()
        if not self.key and not (self.token and self.project):
            raise ModelUnavailable(
                "Google translation is chosen and not configured. Set DECKASTRA_GOOGLE_CREDENTIALS "
                "(scripts/setup-google-cloud.ps1 makes one), DECKASTRA_GOOGLE_API_KEY, or "
                "GOOGLE_CLOUD_PROJECT with DECKASTRA_GOOGLE_ACCESS_TOKEN. Nothing was sent."
            )

    def translate(self, items: list[Item], *, source: str, target: str) -> dict[str, str]:
        texts = [item.text for item in items]
        from .paid_services import billed
        try:
            with billed("translation", sum(map(len, texts)), "DECKASTRA_TRANSLATION_USD_PER_MILLION"), httpx.Client(timeout=30) as http:
                if self.token and self.project:
                    body: dict[str, Any] = {
                        "contents": texts,
                        "mimeType": "text/plain",
                        "sourceLanguageCode": google_language(source),
                        "targetLanguageCode": google_language(target),
                    }
                    if self.glossary:
                        body["glossaryConfig"] = {
                            "glossary": f"projects/{self.project}/locations/{self.location}/glossaries/{self.glossary}"
                        }
                    response = http.post(
                        f"https://translation.googleapis.com/v3/projects/{self.project}/locations/{self.location}:translateText",
                        json=body,
                        headers=google_auth_headers(self.token),
                    )
                    response.raise_for_status()
                    data = response.json()
                    results = data.get("glossaryTranslations") or data.get("translations") or []
                    translated = [entry.get("translatedText", "") for entry in results]
                else:
                    response = http.post(
                        "https://translation.googleapis.com/language/translate/v2",
                        params={"key": self.key},
                        json={"q": texts, "source": google_language(source), "target": google_language(target), "format": "text"},
                    )
                    response.raise_for_status()
                    translated = [entry.get("translatedText", "") for entry in response.json()["data"]["translations"]]
        except (httpx.HTTPError, KeyError, ValueError) as error:
            raise TranslationError(f"Google translation failed: {error}") from error
        return {item.id: text for item, text in zip(items, translated, strict=False)}


class GatewayTranslator:
    """Cloud Translation through the desktop's private signed-in bridge."""

    name = "google"
    origin = "machine"

    def translate(self, items: list[Item], *, source: str, target: str) -> dict[str, str]:
        from deckastra_agents.gateway_client import GatewayClient
        try:
            return GatewayClient().translate(items, source=source, target=target)
        except ModelUnavailable as error:
            raise TranslationError(str(error)) from error


def selected_translator_name() -> str:
    """Which provider this install translates with, without building it."""
    choice = os.environ.get(TRANSLATION_ENV, "").strip().lower()
    if choice and choice not in PROVIDERS:
        raise ModelUnavailable(
            f"{TRANSLATION_ENV} is set to {choice!r}, which this build does not recognise. "
            f"Use one of: {', '.join(PROVIDERS)}. Nothing was sent anywhere."
        )
    if choice:
        if choice == "stub" and _installed_product():
            raise ModelUnavailable("The keyless stand-in translator is for development; it is not in an installed product.")
        return choice
    if _installed_product():
        raise ModelUnavailable(
            "Translation is not configured. Set DECKASTRA_TRANSLATION=google and configure Google Cloud Translation."
        )
    return "stub"


def _installed_product() -> bool:
    return os.environ.get("DECKASTRA_DISTRIBUTION", "").strip() == "1" or os.environ.get("DECKASTRA_ENV") == "production"


def translation_status() -> dict[str, Any]:
    """What Translate will do here, for the Languages panel to say before anyone presses it."""
    try:
        name = selected_translator_name()
    except ModelUnavailable as error:
        return {"provider": "none", "available": False, "reason": str(error)}
    reasons = {
        "stub": "Development stand-in: every translation is the source text marked with the language. Nothing is sent.",
        "google": "Translated by Google Cloud Translation. Slide text is sent to Google.",
    }
    return {"provider": name, "available": True, "reason": reasons[name]}


def build_translator() -> Translator:
    """Build the explicitly selected translation service."""
    name = selected_translator_name()
    if name == "stub":
        return StubTranslator()
    from . import local_mode
    if local_mode.enabled() and os.environ.get("DECKASTRA_GATEWAY_URL"):
        return GatewayTranslator()
    return GoogleTranslator()


def characters_to_translate(document: dict[str, Any], slots: list[locales.Slot], glossary: list[str] | None = None) -> int:
    """Billable masked characters, shared by quoting and execution."""
    total = 0
    for slot in slots:
        if isinstance(slot.value, str):
            total += len(mask(slot.value, glossary)[0])
        else:
            for block in slot.value.get("blocks") or []:
                text = "".join(str(span.get("text", "")) for span in block.get("spans") or [])
                if text.strip():
                    total += len(mask(text, glossary)[0])
    return total


# ------------------------------------------------------------------- the plan


@dataclass
class TranslationPlan:
    operations: list[dict[str, Any]]
    translated: list[str] = field(default_factory=list)
    refused: list[dict[str, str]] = field(default_factory=list)
    simplified: int = 0
    characters: int = 0


Scope = Literal["missing", "outdated", "slides"]


def slots_to_translate(
    document: dict[str, Any],
    locale: str,
    scope: Scope,
    slide_ids: list[str] | None = None,
) -> list[locales.Slot]:
    entries = (((document.get("locales") or {}).get(locale) or {}).get("entries")) or {}
    chosen: list[locales.Slot] = []
    for slot in locales.locale_slots(document):
        if not locales.worth_translating(slot.value):
            continue
        entry = entries.get(slot.path)
        if scope == "missing" and entry is None:
            chosen.append(slot)
        elif scope == "outdated" and entry is not None and entry.get("sourceHash") != locales.text_hash(slot.value):
            chosen.append(slot)
        elif scope == "slides" and slot.slide_id is not None and slot.slide_id in set(slide_ids or []):
            chosen.append(slot)
    return chosen


def _budget(document: dict[str, Any], slot: locales.Slot) -> int | None:
    """Characters a text box has room for: width over an average glyph, times its lines."""
    if not slot.element_id or not (slot.path.endswith("/content") or slot.path.endswith("/text")):
        return None
    for slide in document.get("slides") or []:
        if slide.get("id") != slot.slide_id:
            continue
        stack = list(slide.get("elements") or [])
        while stack:
            element = stack.pop()
            if element.get("id") == slot.element_id:
                transform = element.get("transform") or {}
                size = (element.get("typography") or {}).get("fontSize")
                if not isinstance(size, (int, float)) or size <= 0:
                    return None
                per_line = max(1, int(float(transform.get("width", 0)) / (size * 0.52)))
                lines = max(1, int(float(transform.get("height", 0)) / (size * 1.3)))
                return per_line * lines
            stack.extend(element.get("children") or [])
    return None


def plan_translation(
    document: dict[str, Any],
    locale: str,
    slots: list[locales.Slot],
    translator: Translator,
    *,
    glossary: list[str] | None = None,
) -> TranslationPlan:
    """Translate `slots` and return the operations that write them as overlay entries.

    Rich text is translated a block at a time and rebuilt with the block's own
    id, type and paragraph style. A block whose spans were formatted differently
    comes back as one run carrying its first span's marks — a translation
    reorders words, so formatting cannot follow them one for one — and the count
    is reported so the review says so.
    """
    source = locales.source_locale(document)
    plan = TranslationPlan(operations=[])
    # One translatable unit per string slot or per rich-text block.
    units: list[tuple[str, int | None, Item, list[str]]] = []
    for slot in slots:
        if isinstance(slot.value, str):
            masked, spans = mask(slot.value, glossary)
            units.append((slot.path, None, Item(id=f"u{len(units)}", text=masked, budget=_budget(document, slot)), spans))
        else:
            for index, block in enumerate(slot.value.get("blocks") or []):
                text = "".join(str(span.get("text", "")) for span in block.get("spans") or [])
                if not text.strip():
                    continue
                masked, spans = mask(text, glossary)
                units.append((slot.path, index, Item(id=f"u{len(units)}", text=masked, budget=_budget(document, slot)), spans))
    plan.characters = sum(len(item.text) for _path, _index, item, _spans in units)

    answers: dict[str, str] = {}
    for start in range(0, len(units), BATCH):
        batch = [item for _path, _index, item, _spans in units[start : start + BATCH]]
        answers.update(translator.translate(batch, source=source, target=locale))

    restored: dict[tuple[str, int | None], str] = {}
    failed_paths: set[str] = set()
    for path, index, item, spans in units:
        answer = answers.get(item.id)
        try:
            if answer is None:
                raise TranslationError("The translator returned nothing for it.")
            restored[(path, index)] = unmask(answer, spans)
        except TranslationError as error:
            failed_paths.add(path)
            plan.refused.append({"path": path, "reason": str(error)})

    overlay = (document.get("locales") or {}).get(locale)
    if not document.get("locales"):
        plan.operations.append({"op": "add", "path": "/locales", "value": {locale: {"locale": locale, "status": "draft", "entries": {}}}})
        existing: dict[str, Any] = {}
    elif overlay is None:
        plan.operations.append({"op": "add", "path": f"/locales/{locale}", "value": {"locale": locale, "status": "draft", "entries": {}}})
        existing = {}
    else:
        existing = overlay.get("entries") or {}

    for slot in slots:
        if slot.path in failed_paths:
            continue
        if isinstance(slot.value, str):
            value: Any = restored.get((slot.path, None))
            if value is None:
                continue
        else:
            blocks = []
            for index, block in enumerate(slot.value.get("blocks") or []):
                spans = block.get("spans") or []
                text = restored.get((slot.path, index))
                if text is None:
                    blocks.append(block)
                    continue
                marks = {key: value for key, value in (spans[0] if spans else {}).items() if key != "text"}
                if len(spans) > 1:
                    plan.simplified += 1
                blocks.append({**{key: v for key, v in block.items() if key != "spans"}, "spans": [{**marks, "text": text}]})
            value = {**slot.value, "blocks": blocks}
        entry = {"value": value, "sourceHash": locales.text_hash(slot.value), "origin": translator.origin, "reviewStatus": "draft"}
        plan.operations.append(
            {"op": "replace" if slot.path in existing else "add", "path": locales.entry_path(locale, slot.path), "value": entry}
        )
        plan.translated.append(slot.path)
    return plan
