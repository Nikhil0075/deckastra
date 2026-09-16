"""D5.0: can a device's transaction log be replayed onto another store?

The spike the whole of D5 waits on. If a log authored on one machine replays
onto another and produces the same document, then syncing a deck is an outbox
plus a divergence policy — upload the transactions, apply them in order, done. If
it does not, sync has to be document-level: upload a snapshot and merge it, which
is a different product with different failure modes and a conflict surface an
order of magnitude larger.

It is a spike rather than a feature, so it answers the question and writes down
what it found — including the part of the answer that is *no*.

Two stores, one after the other, which is also how it happens in life: a device
commits offline, and a server applies the same changes later. `reset_engine`
between the phases is what makes the second store genuinely separate rather than
the same rows read twice.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import store  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.ids import new_id  # noqa: E402
from deckastra_api.patch import apply_patch  # noqa: E402
from deckastra_api.schema import validate_document  # noqa: E402


def use_store(tmp_path: Path, name: str) -> None:
    """Point the process at one database and forget the other."""
    import os

    os.environ["DATABASE_URL"] = f"sqlite:///{tmp_path / f'{name}.db'}"
    db_session.reset_engine()
    db_session.create_all()


def starting_deck() -> dict:
    """A real deck to edit, with a fresh identity.

    The conformance fixture rather than a hand-built shell: a document has ten
    required properties and a theme, and a shell that satisfied the store while
    failing the validator would make this spike a test of my typing. It also
    means the log below edits a deck that already has content, animations and a
    transition, which is the case sync will actually meet.

    Its `id` *is* the presentation id (`create_presentation` reads it from there),
    so a fresh one makes a new deck on whichever store seeds it.
    """
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "packages"
            / "presentation-schema"
            / "fixtures"
            / "animation-test.mydeck.json"
        ).read_text(encoding="utf-8")
    )
    fixture["id"] = new_id("doc")
    return fixture


def seed(session, email: str, document: dict):
    """Put an existing document into this store, through the store's own path.

    Presentation identity travels for free: `create_presentation` takes the id
    from `document["id"]`, so the same starting document seeds the same
    presentation id on both sides. Version identity does not — see the test at
    the bottom of this file.
    """
    from deckastra_api.auth import provision_personal_account

    user, _workspace, project = provision_personal_account(session, email=email)
    created = store.create_presentation(
        session,
        project_id=project.id,
        document=document,
        created_by=user.id,
    )
    return user, created


def commit(session, presentation_id: str, operations: list[dict], intent: str, user_id: str):
    """Apply and record, exactly as the transactions route does."""
    loaded = store.load_presentation(session, presentation_id)
    document, inverse = apply_patch(loaded.document, operations)
    # The Python validator answers a list of errors, not a report object.
    assert validate_document(document) == [], intent

    return store.commit_transaction(
        session,
        presentation_id=presentation_id,
        operations=operations,
        inverse_operations=inverse,
        document=document,
        parent_version_id=loaded.version_id,
        expected_version_id=loaded.version_id,
        intent=intent,
        source="user",
        created_by=user_id,
    )


def a_days_editing(document: dict) -> list[tuple[str, list[dict]]]:
    """A log with the shapes that make replay hard, not a list of safe edits.

    Each of these is here because it is a way replay could fail:

    - an operation addressing something an *earlier operation in the same log*
      created, which is the case a naive "apply the final snapshot" design never
      exercises;
    - an array `move`, whose meaning depends on the array's state at that moment;
    - a `remove`, whose inverse can only be index-addressed;
    - nested structures (animation tracks, a transition with shared elements),
      which is where a path that resolves on one store and not the other would
      show up.
    """
    slide_id = document["slides"][0]["id"]

    # Templates cloned from the deck rather than written here. An element has
    # required properties this file should not be a second, drifting record of —
    # the first attempt omitted `typography` and produced a document the store
    # accepted and the validator refused.
    text_template = next(
        element for element in document["slides"][0]["elements"] if element["type"] == "text"
    )
    shape_template = next(
        element for element in document["slides"][0]["elements"] if element["type"] == "shape"
    )

    def a_text(text: str, **overrides) -> dict:
        element = copy.deepcopy(text_template)
        element["id"] = new_id("el")
        element["content"] = {
            "version": 1,
            "blocks": [
                {"id": new_id("blk"), "type": "paragraph", "spans": [{"text": text}]}
            ],
        }
        element.update(overrides)
        return element

    def a_shape(**overrides) -> dict:
        element = copy.deepcopy(shape_template)
        element["id"] = new_id("el")
        element.update(overrides)
        return element

    headline_element = a_text("Offline", semanticRole="headline")
    shape_element = a_shape()
    second_headline_element = a_text("Offline, later", semanticRole="headline")

    headline = headline_element["id"]
    shape = shape_element["id"]
    second_headline = second_headline_element["id"]
    track = new_id("anm")
    second_slide = new_id("sld")

    return [
        (
            "Add a headline",
            [
                {
                    "op": "add",
                    "path": f"/slides/id:{slide_id}/elements/-",
                    "value": headline_element,
                }
            ],
        ),
        (
            "Add a shape beside it",
            [
                {
                    "op": "add",
                    "path": f"/slides/id:{slide_id}/elements/-",
                    "value": shape_element,
                }
            ],
        ),
        # Addresses the element the first operation created.
        (
            "Retitle it",
            [
                {
                    "op": "replace",
                    "path": f"/slides/id:{slide_id}/elements/id:{headline}/transform/x",
                    "value": 200,
                }
            ],
        ),
        (
            "Bring the shape forward",
            [
                {
                    "op": "move",
                    "from": f"/slides/id:{slide_id}/elements/id:{shape}",
                    "path": f"/slides/id:{slide_id}/elements/0",
                }
            ],
        ),
        (
            "Animate the headline",
            [
                {
                    "op": "add",
                    "path": f"/slides/id:{slide_id}/animations",
                    "value": [
                        {
                            "id": track,
                            "targetId": headline,
                            "trigger": {"type": "slideEnter"},
                            "clips": [
                                {
                                    "id": new_id("clp"),
                                    "preset": "fade",
                                    "startMs": 0,
                                    "durationMs": 400,
                                }
                            ],
                        }
                    ],
                }
            ],
        ),
        (
            "Add a second slide",
            [
                {
                    "op": "add",
                    "path": "/slides/-",
                    "value": {
                        "id": second_slide,
                        "elements": [second_headline_element],
                    },
                }
            ],
        ),
        # A transition pairing elements on two slides, both created by this log.
        (
            "Morph between them",
            [
                {
                    "op": "add",
                    "path": f"/slides/id:{second_slide}/transition",
                    "value": {
                        "type": "morph",
                        "durationMs": 420,
                        "sharedElements": [
                            {
                                "sourceElementId": headline,
                                "destinationElementId": second_headline,
                                "matchMode": "positionAndScale",
                            }
                        ],
                    },
                }
            ],
        ),
        (
            "Delete the shape after all",
            [{"op": "remove", "path": f"/slides/id:{slide_id}/elements/id:{shape}"}],
        ),
    ]


def replay_once(tmp_path: Path, starting: dict, log) -> list:
    """The in-order result, on a store of its own, for comparison."""
    use_store(tmp_path, "inorder")
    with db_session.session_scope() as session:
        user, _created = seed(session, "inorder@local", copy.deepcopy(starting))
        for intent, operations in log:
            commit(session, starting["id"], operations, intent, user.id)
        return copy.deepcopy(store.load_presentation(session, starting["id"]).document["slides"])


@pytest.fixture()
def replayed(tmp_path, monkeypatch):
    """Author a log on one store, replay it on another, and hand back both."""
    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)

    # ---- the device
    use_store(tmp_path, "device")
    log: list[tuple[str, list[dict]]] = []
    device_versions: list[str] = []

    starting = starting_deck()
    presentation_id = starting["id"]
    log = a_days_editing(starting)

    with db_session.session_scope() as session:
        user, _created = seed(session, "device@local", copy.deepcopy(starting))
        for intent, operations in log:
            result = commit(session, presentation_id, operations, intent, user.id)
            device_versions.append(result.version_id)

        device_document = copy.deepcopy(
            store.load_presentation(session, presentation_id).document
        )

    # ---- the server, which has never seen this deck
    use_store(tmp_path, "cloud")
    cloud_versions: list[str] = []

    with db_session.session_scope() as session:
        # A device uploading a deck sends what it started from as well as what it
        # did, so the server seeds from the same document — same presentation id,
        # same slide id, and every path in the log therefore resolves.
        user, _created = seed(session, "cloud@local", copy.deepcopy(starting))

        for intent, operations in log:
            result = commit(session, presentation_id, operations, intent, user.id)
            cloud_versions.append(result.version_id)

        cloud_document = copy.deepcopy(
            store.load_presentation(session, presentation_id).document
        )

    return {
        "device": device_document,
        "cloud": cloud_document,
        "device_versions": device_versions,
        "cloud_versions": cloud_versions,
        "log": log,
    }


def test_a_log_replays_to_the_same_document(replayed):
    """The question D5 waits on.

    Slides, elements, animations and the transition's pairings all have to land
    identically — including the operations that address things earlier operations
    in the same log created, which is what separates replaying a *log* from
    uploading a snapshot.
    """
    device = replayed["device"]
    cloud = replayed["cloud"]

    assert [slide["id"] for slide in cloud["slides"]] == [
        slide["id"] for slide in device["slides"]
    ]
    assert cloud["slides"] == device["slides"]


def test_the_order_of_operations_is_the_document(tmp_path, monkeypatch):
    """Replaying out of order is not a slower sync, it is a different deck.

    A `move` and a `remove` both depend on the array as it stood at that moment,
    and an operation addressing an element an earlier one created cannot resolve
    before it exists. So the log is a sequence, not a set — and this is also what
    makes the equality above mean something: if any order produced the same
    document, the check would be passing on a property nothing has.
    """
    from deckastra_api.patch import PatchError

    monkeypatch.delenv("DECKASTRA_LOCAL_MODE", raising=False)
    starting = starting_deck()
    log = a_days_editing(starting)

    use_store(tmp_path, "shuffled")
    with db_session.session_scope() as session:
        user, _created = seed(session, "shuffled@local", copy.deepcopy(starting))

        # The last change first: it removes an element two later operations
        # depend on having added.
        reordered = [log[-1], *log[:-1]]

        refused = False
        try:
            for intent, operations in reordered:
                commit(session, starting["id"], operations, intent, user.id)
        except (PatchError, AssertionError, KeyError):
            refused = True

        if not refused:
            shuffled = store.load_presentation(session, starting["id"]).document
            assert shuffled["slides"] != replay_once(tmp_path, starting, log), (
                "every order produced the same document, so the equality check above "
                "is not testing anything"
            )
        else:
            assert refused


def test_version_ids_are_not_preserved_by_replay(replayed):
    """The part of the answer that is **no**, and the finding that matters.

    `commit_transaction` mints `new_id("ver")` itself; nothing lets a caller
    supply one. So a replayed change is the same *content* under a different
    *identity*, and an upload keyed on version id would re-apply every
    transaction on every retry.

    D5.2's idempotency therefore cannot key on the version id as it stands. It
    needs either a client-supplied change key recorded with the transaction, or
    an optional `version_id` on the commit path so the two chains are literally
    one chain. This test exists to keep that decision from being made by
    accident.
    """
    device = replayed["device_versions"]
    cloud = replayed["cloud_versions"]

    assert len(device) == len(cloud)
    assert device != cloud
    assert set(device).isdisjoint(cloud)
