"""Importing a PowerPoint theme (Design tab review, 2026-09-26).

A brand usually arrives as a PowerPoint template. These build real packages —
one by hand with a known palette, one written by python-pptx, an independent
implementation of the format — and check what comes out, plus every refusal.
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api import office_theme  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402
from deckastra_api.schema import validate_theme  # noqa: E402

THEME = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Acme Brand">
  <a:themeElements>
    <a:clrScheme name="Acme">
      <a:dk1><a:sysClr val="windowText" lastClr="101820"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2A44"/></a:dk2>
      <a:lt2><a:srgbClr val="F3F5F9"/></a:lt2>
      <a:accent1><a:srgbClr val="C8102E"/></a:accent1>
      <a:accent2><a:srgbClr val="00A3E0"/></a:accent2>
      <a:accent3><a:srgbClr val="FFB81C"/></a:accent3>
      <a:accent4><a:srgbClr val="43B02A"/></a:accent4>
      <a:accent5><a:srgbClr val="6D2077"/></a:accent5>
      <a:accent6><a:srgbClr val="7C878E"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Acme">
      <a:majorFont><a:latin typeface="Playfair Display"/></a:majorFont>
      <a:minorFont><a:latin typeface="Lora"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>"""


def package(parts: dict[str, bytes | str]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in parts.items():
            archive.writestr(name, body)
    return out.getvalue()


def test_a_thmx_carries_its_palette_and_fonts_exactly():
    theme, notes = office_theme.theme_from_office(package({"theme/theme/theme1.xml": THEME}))
    assert validate_theme(theme) == []
    colours = theme["colors"]
    assert theme["name"] == "Acme Brand"
    assert theme["mode"] == "light"
    assert colours["background"] == "#FFFFFF"
    # The system colour, from its last saved value.
    assert colours["foreground"] == "#101820"
    assert colours["accent"] == "#C8102E"
    assert colours["secondary"] == "#00A3E0"
    assert colours["chartSeries"] == ["#C8102E", "#00A3E0", "#FFB81C", "#43B02A", "#6D2077", "#7C878E"]
    assert colours["surface"] == "#F3F5F9"
    assert theme["typography"]["h1"]["fontFamily"] == "Playfair Display"
    assert theme["typography"]["body"]["fontFamily"] == "Lora"
    # Text chosen for contrast on the accent, and said when it was not possible.
    assert office_theme.contrast(colours["accentForeground"], colours["accent"]) >= 4.5
    assert any("system colour" in note for note in notes)
    assert any("Hyperlink" in note for note in notes)


def test_a_dark_theme_swaps_the_roles():
    dark = THEME.replace('<a:sysClr val="windowText" lastClr="101820"/>', '<a:srgbClr val="F8F8F8"/>').replace(
        '<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>', '<a:lt1><a:srgbClr val="0B0F14"/></a:lt1>'
    )
    theme, _ = office_theme.theme_from_office(package({"theme/theme/theme1.xml": dark}))
    assert theme["mode"] == "dark"
    assert theme["colors"]["background"] == "#0B0F14"
    assert theme["colors"]["foreground"] == "#F8F8F8"


def test_a_real_pptx_from_an_independent_writer_imports():
    pptx = pytest.importorskip("pptx")
    out = io.BytesIO()
    pptx.Presentation().save(out)
    theme, _ = office_theme.theme_from_office(out.getvalue())
    assert validate_theme(theme) == []
    assert theme["colors"]["accent"].startswith("#") and len(theme["colors"]["accent"]) == 7


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"not a zip at all", "not a PowerPoint file"),
        (package({"word/document.xml": "<x/>"}), "no PowerPoint theme"),
        (package({"ppt/theme/theme1.xml": '<!DOCTYPE x [<!ENTITY a "aaaa">]><x/>'}), "document type"),
        (package({"ppt/theme/theme1.xml": THEME.replace("<a:clrScheme", "<a:notScheme").replace("</a:clrScheme>", "</a:notScheme>")}), "no colour scheme"),
        (b"x" * (office_theme.MAX_PACKAGE_BYTES + 1), "larger than"),
    ],
    ids=["not-a-zip", "no-theme-part", "doctype", "no-colour-scheme", "oversized"],
)
def test_what_is_not_a_theme_is_refused_by_name(data, message):
    with pytest.raises(office_theme.OfficeThemeError, match=message):
        office_theme.theme_from_office(data)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'office.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    db_session.reset_engine()
    db_session.create_all()
    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


def test_the_route_reads_the_body_and_changes_nothing(client):
    auth = {"Authorization": f"Bearer {client.post('/v1/dev/session', json={'email': 'office@localhost'}).json()['token']}"}
    deck = client.post("/v1/generate", headers=auth, json={"instruction": "Brand check", "slide_count": 2}).json()
    before = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()["version_id"]

    response = client.post(
        f"/v1/presentations/{deck['presentation_id']}/themes/import",
        headers={**auth, "Content-Type": "application/octet-stream"},
        content=package({"ppt/theme/theme1.xml": THEME}),
    )
    assert response.status_code == 200, response.text
    assert response.json()["theme"]["colors"]["accent"] == "#C8102E"
    after = client.get(f"/v1/presentations/{deck['presentation_id']}", headers=auth).json()["version_id"]
    assert after == before

    refused = client.post(
        f"/v1/presentations/{deck['presentation_id']}/themes/import",
        headers={**auth, "Content-Type": "application/octet-stream"},
        content=b"not a zip",
    )
    assert refused.status_code == 400
    assert "not a PowerPoint file" in refused.json()["detail"]
