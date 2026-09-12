"""The API consumes the emitted schema, including the known/future boundary."""

import copy
import json

from deckastra_api.schema import REPO_ROOT, validate_document


def test_known_element_rejection_and_future_element_preservation():
    fixture = REPO_ROOT / "packages/presentation-schema/fixtures/animation-test.mydeck.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))
    assert validate_document(document) == []

    line = next(e for e in document["slides"][1]["elements"] if e["type"] == "line")
    line["start"] = line.pop("from")
    line["end"] = line.pop("to")
    assert validate_document(document)

    line["type"] = "hologram"
    line["semanticRole"] = "futureRole"
    line["futurePayload"] = {"keep": [1, {"density": 0.4}]}
    original = copy.deepcopy(document)
    assert validate_document(document) == []
    assert json.loads(json.dumps(document)) == original
