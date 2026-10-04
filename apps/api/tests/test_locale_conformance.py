"""The Python locale model agrees with the TypeScript one.

`deckastra_api/locales.py` walks a document for its text slots and hashes their
words, so the server can translate a deck. `packages/presentation-schema/src/locales.ts`
is the definition. Two implementations of one rule are held together here the
way the patch appliers are: by running the real TypeScript over the same input
and comparing, never by comparing Python with a description of itself.

The hash and the allowlist need no Node at all — they come down the generated
pipeline in `locale-rules.json` — so those checks run everywhere.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from deckastra_api import locales

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "packages" / "presentation-schema" / "fixtures"
RUNNER = REPO_ROOT / "scripts" / "locale_slots_reference.ts"
npx = shutil.which("npx") or shutil.which("npx.cmd")


def _fixtures() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(FIXTURES.glob("*.mydeck.json"))]


def test_hash_samples_match_the_typescript_definition():
    rules = json.loads(locales.RULES_PATH.read_text(encoding="utf-8"))
    assert rules["hashSamples"], "the generated rules carry no samples"
    for sample in rules["hashSamples"]:
        assert locales.text_hash(sample["text"]) == sample["hash"], sample["text"]


def test_every_enumerated_slot_is_on_the_generated_allowlist():
    for document in _fixtures():
        for slot in locales.locale_slots(document):
            assert locales.is_localizable_path(slot.path), slot.path
    assert not locales.is_localizable_path("/slides/id:sld_A/elements/id:el_B/transform/x")


def test_rich_text_and_a_string_with_the_same_words_hash_the_same():
    rich = {"version": 1, "blocks": [{"id": "blk_A", "type": "paragraph", "spans": [{"text": "Hel"}, {"text": "lo", "bold": True}]}]}
    assert locales.text_hash(rich) == locales.text_hash("Hello")


@pytest.mark.skipif(npx is None or not RUNNER.exists(), reason="Node toolchain unavailable")
def test_slots_match_the_typescript_enumeration_on_every_fixture():
    documents = _fixtures()
    result = subprocess.run(
        [npx, "--yes", "tsx", str(RUNNER)],
        input=json.dumps(documents),
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=REPO_ROOT,
        timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    reference = json.loads(result.stdout)
    assert len(reference) == len(documents)
    for document, expected in zip(documents, reference, strict=True):
        mine = [{"path": slot.path, "kind": slot.kind, "hash": locales.text_hash(slot.value)} for slot in locales.locale_slots(document)]
        assert mine == expected, document["metadata"]["title"]
    # The comparison covered every kind of slot the multilingual fixture has.
    assert sum(len(slots) for slots in reference) > 50
