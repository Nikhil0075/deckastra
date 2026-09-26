"""Cross-language conformance for the patch applier.

There are two implementations of patch application: `@deckastra/transactions` in
TypeScript (used by the editor and the agents) and `deckastra_api.patch` in Python
(used by the store to replay a document from a snapshot). Two implementations of
one behaviour is exactly the drift this project otherwise refuses to allow.

This is what makes it safe. The same generated patches run through both, and the
resulting documents and inverses must match byte for byte. If they ever disagree,
CI fails — so the duplication is enforced to agree rather than hoped to.

It shells out to Node deliberately: comparing against a Python re-description of
the TypeScript behaviour would test nothing.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.patch import PatchError, apply_patch  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNNER = REPO_ROOT / "scripts" / "apply_patch_reference.ts"
FIXTURE = (
    REPO_ROOT
    / "packages"
    / "presentation-schema"
    / "fixtures"
    / "technical-deck.mydeck.json"
)

npx = shutil.which("npx") or shutil.which("npx.cmd")

pytestmark = pytest.mark.skipif(
    npx is None or not RUNNER.exists(),
    reason="Node toolchain unavailable; the TypeScript reference cannot be run.",
)


def load_document() -> dict:
    with FIXTURE.open(encoding="utf-8") as handle:
        return json.load(handle)


def run_reference_batch(batch: list[tuple[dict, list[dict]]]) -> list[dict]:
    """Apply a batch of patches with the TypeScript implementation.

    Batched because starting Node costs far more than applying a patch: one
    invocation per case turned this suite into a minute of process startup, and a
    slow test is a test people skip.
    """
    payload = json.dumps(
        [{"document": document, "operations": operations} for document, operations in batch]
    )
    result = subprocess.run(
        [npx, "--yes", "tsx", str(RUNNER)],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=REPO_ROOT,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Reference runner failed: {result.stderr[-2000:]}")
    return json.loads(result.stdout)


def canonical(value: object) -> str:
    """Compare on canonical bytes, not on dict equality.

    Key *order* is part of what the two implementations must agree on: the
    canonical serializer is what version diffing and content hashing are built on,
    so an applier that produced the same data in a different order would break
    both while passing a naive equality check.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def cases(document: dict) -> list[tuple[str, list[dict]]]:
    slide = document["slides"][0]["id"]
    other = document["slides"][2]["id"]
    element = document["slides"][0]["elements"][0]["id"]

    return [
        ("replace a scalar", [{"op": "replace", "path": f"/slides/id:{slide}/keyMessage", "value": "x"}]),
        ("add a new key", [{"op": "add", "path": f"/slides/id:{slide}/name", "value": "Renamed"}]),
        (
            "add over an existing key",
            [{"op": "add", "path": f"/slides/id:{slide}/keyMessage", "value": "overwritten"}],
        ),
        ("remove a slide", [{"op": "remove", "path": f"/slides/id:{other}"}]),
        ("append a slide", [{"op": "add", "path": "/slides/-", "value": {"id": "sld_TEST", "elements": []}}]),
        ("insert a slide", [{"op": "add", "path": "/slides/1", "value": {"id": "sld_TEST2", "elements": []}}]),
        ("move a slide forward", [{"op": "move", "from": f"/slides/id:{slide}", "path": "/slides/3"}]),
        ("move a slide backward", [{"op": "move", "from": f"/slides/id:{other}", "path": "/slides/0"}]),
        ("copy a slide", [{"op": "copy", "from": f"/slides/id:{slide}", "path": "/slides/-"}]),
        (
            "nested element edit",
            [{"op": "replace", "path": f"/slides/id:{slide}/elements/id:{element}/transform/x", "value": 321}],
        ),
        ("remove a nested element", [{"op": "remove", "path": f"/slides/id:{slide}/elements/id:{element}"}]),
        (
            "numeric index into a span",
            [
                {
                    "op": "replace",
                    "path": f"/slides/id:{slide}/elements/id:{element}/content/blocks/0/spans/0/text",
                    "value": "Rewritten",
                }
            ],
        ),
        (
            "multi-operation patch",
            [
                {"op": "replace", "path": f"/slides/id:{slide}/keyMessage", "value": "one"},
                {"op": "remove", "path": f"/slides/id:{other}"},
                {"op": "add", "path": "/slides/0", "value": {"id": "sld_TEST3", "elements": []}},
                {"op": "move", "from": f"/slides/id:{slide}", "path": "/slides/2"},
            ],
        ),
        (
            "satisfied test then write",
            [
                {"op": "test", "path": "/schemaVersion", "value": document["schemaVersion"]},
                {"op": "replace", "path": f"/slides/id:{slide}/keyMessage", "value": "after test"},
            ],
        ),
        (
            "escaped key",
            [{"op": "add", "path": "/theme/colors/custom", "value": {"brand/primary~alt": "#fff"}}],
        ),
        (
            # The shape `deleteSlideOperations` emits (editor Phase 2): morph pairs
            # carry no id, so a slide losing a pair's half has its whole
            # `sharedElements` array replaced by the survivors, id-addressed,
            # before the slide itself is removed in the same patch.
            "replace an id-addressed array, then remove a slide",
            [
                {
                    "op": "add",
                    "path": f"/slides/id:{slide}/transition",
                    "value": {
                        "type": "morph",
                        "durationMs": 400,
                        "sharedElements": [{"sourceElementId": element, "destinationElementId": element}],
                    },
                },
                {"op": "replace", "path": f"/slides/id:{slide}/transition/sharedElements", "value": []},
                {"op": "remove", "path": f"/slides/id:{other}"},
            ],
        ),
    ]


REJECTED_CASES: list[tuple[str, list[dict]]] = [
    ("missing id", [{"op": "replace", "path": "/slides/id:sld_NOPE00000000000000000000/name", "value": "x"}]),
    ("index past the end", [{"op": "add", "path": "/slides/99", "value": {"id": "sld_X", "elements": []}}]),
    ("insert past the end via move", [{"op": "move", "from": "/slides/0", "path": "/slides/99"}]),
    ("unsatisfied test", [{"op": "test", "path": "/schemaVersion", "value": "9.9.9"}]),
    ("root path", [{"op": "replace", "path": "/", "value": {}}]),
    ("property that does not exist", [{"op": "replace", "path": "/slides/0/nope/deeper", "value": 1}]),
]


@pytest.fixture(scope="module")
def reference_results() -> dict[str, dict]:
    """Every reference result, from one Node invocation."""
    document = load_document()
    accepted = cases(document)
    batch = [(document, operations) for _, operations in accepted + REJECTED_CASES]
    results = run_reference_batch(batch)
    labels = [label for label, _ in accepted + REJECTED_CASES]
    return dict(zip(labels, results, strict=True))


@pytest.mark.parametrize("label,operations", cases(load_document()), ids=lambda v: v if isinstance(v, str) else "")
def test_both_implementations_produce_identical_results(
    label: str, operations: list[dict], reference_results: dict[str, dict]
):
    document = load_document()

    reference = reference_results[label]
    assert "error" not in reference, f"{label}: TypeScript rejected a patch Python accepted"

    mine, inverse = apply_patch(document, operations)

    assert canonical(mine) == canonical(reference["document"]), f"{label}: documents differ"
    assert canonical(inverse) == canonical(reference["inverse"]), f"{label}: inverses differ"


@pytest.mark.parametrize("label,operations", REJECTED_CASES, ids=lambda v: v if isinstance(v, str) else "")
def test_both_implementations_reject_the_same_patches(
    label: str, operations: list[dict], reference_results: dict[str, dict]
):
    document = load_document()

    with pytest.raises(PatchError):
        apply_patch(document, operations)

    # The TypeScript side must refuse it too. An applier that accepts what the
    # other rejects is the more dangerous half of a drift: it writes a document
    # the other cannot read.
    assert reference_results[label].get("error"), (
        f"{label}: TypeScript accepted a patch Python rejected"
    )


def test_inverses_round_trip_in_python():
    document = load_document()
    slide = document["slides"][0]["id"]

    for _, operations in cases(document):
        try:
            after, inverse = apply_patch(document, operations)
        except PatchError:
            continue
        restored, _ = apply_patch(after, inverse)
        assert canonical(restored) == canonical(document)

    # And the specific shape the store depends on: replaying forward from a
    # snapshot must reproduce the head exactly.
    operations = [{"op": "replace", "path": f"/slides/id:{slide}/keyMessage", "value": "replayed"}]
    after, _ = apply_patch(document, operations)
    replayed, _ = apply_patch(document, operations)
    assert canonical(after) == canonical(replayed)
