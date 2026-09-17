"""Handing a headless render the deck's pictures (2026-09-17).

`apps/worker` passed no `resolveAssetUrl`, so every export and every preview drew
the renderer's labelled placeholder: a PDF of a deck of photographs arrived with
dashed boxes in it and nothing anywhere said so. The editor's fix does not carry
over — it answers a same-origin path the desktop proxy authenticates, or fetches
bytes with a bearer token — because the render host has no session, no browser
origin and no network at all.

So the bytes are handed in, and *this* is where authorization happens. What the
tests below pin down is that:

- the scope is the presentation's own workspace, so a document citing an id from
  somewhere else resolves to nothing;
- one unreadable or oversized file degrades that picture rather than failing the
  export of the other thirty-nine slides;
- and the reason travels with the entry, because "too large to embed" and "this
  asset does not exist" are different things to tell a person and an omission
  cannot tell them apart.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import assets as asset_service  # noqa: E402
from deckastra_api import object_storage  # noqa: E402
from deckastra_api.db.models import (  # noqa: E402
    Asset,
    Base,
    Presentation,
    Project,
    User,
    Workspace,
)
from deckastra_api.ids import new_id  # noqa: E402

#: A one-pixel PNG. The renderer never sees these bytes in this suite — the
#: browser's verdict is `apps/worker/tests/assets.browser.test.ts` — so what
#: matters here is only that they are a real file of a real size.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """A database and a local asset directory, as a desktop install has."""
    monkeypatch.setenv("DECKASTRA_ASSET_DIR", str(tmp_path / "assets"))
    engine = create_engine(f"sqlite:///{tmp_path / 'render-assets.db'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def workspace_with_deck(session: Session, *, name: str) -> tuple[str, str]:
    """A user, a workspace, a project and an empty presentation. Returns both ids."""
    user_id = new_id("usr")
    session.add(User(id=user_id, email=f"{name}@localhost", name=name))
    session.flush()
    workspace_id = new_id("wsp")
    session.add(Workspace(id=workspace_id, name=name, owner_id=user_id))
    session.flush()
    project_id = new_id("prj")
    session.add(
        Project(id=project_id, workspace_id=workspace_id, name=name, created_by=user_id)
    )
    session.flush()
    presentation_id = new_id("doc")
    session.add(
        Presentation(
            id=presentation_id,
            project_id=project_id,
            title=name,
            schema_version="1.1",
        )
    )
    session.flush()
    return workspace_id, presentation_id


def stored_image(
    session: Session, *, workspace_id: str, data: bytes = PNG, content_type: str = "image/png"
) -> Asset:
    """An asset row with real bytes behind it."""
    asset_id = new_id("ast")
    key = f"workspaces/{workspace_id}/assets/{asset_id}.png"
    object_storage.put_local(key, data, content_type)
    asset = Asset(
        id=asset_id,
        workspace_id=workspace_id,
        created_by=new_id("usr"),
        kind="image",
        storage_key=key,
        filename="picture.png",
        content_type=content_type,
        bytes=len(data),
    )
    session.add(asset)
    session.flush()
    return asset


def document_citing(asset_id: str) -> dict:
    """The smallest document that cites an image — a manifest entry and an element."""
    return {
        "id": new_id("doc"),
        "assets": [{"id": asset_id, "type": "image", "storageKey": "unused-by-this-path"}],
        "slides": [
            {
                "id": new_id("sld"),
                "elements": [{"id": new_id("el"), "type": "image", "assetId": asset_id}],
            }
        ],
    }


def test_supplies_the_bytes_of_an_image_this_deck_may_read(store):
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        asset = stored_image(session, workspace_id=workspace_id)
        session.commit()

        supplied = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document_citing(asset.id)
        )

    assert len(supplied) == 1
    entry = supplied[0]
    assert entry["assetId"] == asset.id
    assert entry["storageKey"] == asset.storage_key
    assert entry["mimeType"] == "image/png"
    # The bytes, not a URL: the render host has no network and no session, and a
    # URL is the one thing it certainly cannot use.
    assert base64.b64decode(entry["data"]) == PNG
    assert "problem" not in entry


def test_will_not_read_another_workspaces_asset(store):
    # `Asset.workspace_id` scopes an upload to the workspace holding it, and this
    # is the function that would quietly undo that: it is handed a document, and a
    # document is content. A deck moved without its files (D5.5) must not keep
    # reading them, and neither must one that simply names an id it saw somewhere.
    with Session(store) as session:
        _, presentation_id = workspace_with_deck(session, name="ours")
        theirs, _ = workspace_with_deck(session, name="theirs")
        stranger = stored_image(session, workspace_id=theirs)
        session.commit()

        supplied = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document_citing(stranger.id)
        )

    # Nothing at all, and specifically no `problem` naming it — saying "that file
    # is too large" about an asset in someone else's workspace would confirm it
    # exists, which is the rule every 404 in this product keeps.
    assert supplied == []


def test_names_a_file_it_cannot_read_rather_than_failing_the_export(store):
    # One unreadable file must not fail a forty-slide export. The report says
    # which picture is missing and the rest of the deck is still worth having.
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        asset = stored_image(session, workspace_id=workspace_id)
        session.commit()
        Path(object_storage.local_root() / asset.storage_key).unlink()

        supplied = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document_citing(asset.id)
        )

    assert len(supplied) == 1
    assert "data" not in supplied[0]
    assert "could not be read" in supplied[0]["problem"]


def test_refuses_a_file_larger_than_a_render_embeds(store):
    # A data URL is base64 in an HTML string Chromium parses in one go, so it is
    # memory in three places at once. The row's own size is enough to decide, so
    # an oversized file is never read into this process at all.
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        asset = stored_image(session, workspace_id=workspace_id)
        asset.bytes = asset_service.MAX_RENDER_ASSET_BYTES + 1
        session.commit()

        supplied = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document_citing(asset.id)
        )

    assert "data" not in supplied[0]
    assert "limit" in supplied[0]["problem"]


def test_stops_at_the_total_one_render_embeds(store):
    # Per-file alone is not a bound: forty acceptable photographs are one page
    # Chromium is asked to parse hundreds of megabytes of base64 for.
    each = asset_service.MAX_RENDER_ASSET_BYTES
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        rows = []
        for _ in range(8):
            asset = stored_image(session, workspace_id=workspace_id)
            asset.bytes = each
            rows.append(asset)
        session.commit()

        document = document_citing(rows[0].id)
        for asset in rows[1:]:
            document["slides"][0]["elements"].append(
                {"id": new_id("el"), "type": "image", "assetId": asset.id}
            )

        supplied = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document
        )

    embedded = [one for one in supplied if "data" in one]
    refused = [one for one in supplied if "problem" in one]
    assert len(supplied) == 8
    # Some, not all — an empty result would pass "stopped at the total" while
    # meaning the renderer never gets a picture.
    assert embedded and refused
    assert any("a single render can embed" in one["problem"] for one in refused)


def test_refuses_something_stored_as_a_document(store):
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        asset = stored_image(session, workspace_id=workspace_id, content_type="application/pdf")
        session.commit()

        supplied = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document_citing(asset.id)
        )

    assert "data" not in supplied[0]
    assert "application/pdf" in supplied[0]["problem"]


def test_answers_the_same_payload_twice(store):
    # Doc 04 §32.3 wants a byte-stable artifact, so "which image was dropped once
    # the budget ran out" must not depend on the order rows came back in.
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        first = stored_image(session, workspace_id=workspace_id)
        second = stored_image(session, workspace_id=workspace_id)
        session.commit()

        document = document_citing(first.id)
        document["slides"][0]["elements"].append(
            {"id": new_id("el"), "type": "image", "assetId": second.id}
        )

        once = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document
        )
        twice = asset_service.inline_for_render(
            session, presentation_id=presentation_id, document=document
        )

    assert [one["assetId"] for one in once] == sorted([first.id, second.id])
    assert once == twice


def test_a_deck_citing_nothing_reads_nothing(store):
    with Session(store) as session:
        workspace_id, presentation_id = workspace_with_deck(session, name="ours")
        stored_image(session, workspace_id=workspace_id)
        session.commit()

        supplied = asset_service.inline_for_render(
            session,
            presentation_id=presentation_id,
            document={"id": new_id("doc"), "assets": [], "slides": []},
        )

    assert supplied == []
