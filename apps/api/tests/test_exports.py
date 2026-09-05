"""Export as a job (doc 04 §32.4, doc 05 §16).

These run the real exporter — a Node subprocess and, for PDF, a real Chromium.
That is slow and it is the point: the thing worth testing about an export is that
the file comes out, opens in something that is not us, and says what it degraded.
A mocked subprocess would test the mock.

Marked `slow` so the fast suite stays fast; CI runs them.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.db import session as db_session  # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which("npx") is None, reason="the exporter runs through npx"
)

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'exports.db'}")
    monkeypatch.setenv("DECKASTRA_DEV_SECRET", "test-secret")
    monkeypatch.setenv("DECKASTRA_EXPORT_DIR", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    # Re-read after the environment changed: the module caches the directory at
    # import, so a test that only set the variable would write to the real one.
    from deckastra_api import export_service

    monkeypatch.setattr(export_service, "EXPORT_ROOT", tmp_path / "artifacts")

    db_session.reset_engine()
    db_session.create_all()

    from deckastra_api.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def auth(client):
    response = client.post("/v1/dev/session", json={"email": "export@localhost"})
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def deck(client, auth):
    generated = client.post(
        "/v1/generate",
        headers=auth,
        json={"instruction": "A deck about exporting", "slide_count": 4},
    )
    assert generated.status_code == 200, generated.text
    return generated.json()["presentation_id"]


# ------------------------------------------------------------------- pptx


@pytest.mark.slow
def test_a_pptx_export_produces_a_file_a_real_reader_opens(client, auth, deck, tmp_path):
    pptx = pytest.importorskip("pptx", reason="python-pptx is the independent reader")

    started = client.post(
        f"/v1/presentations/{deck}/exports", headers=auth, json={"kind": "pptx"}
    )
    assert started.status_code == 200, started.text
    job = started.json()

    assert job["status"] == "completed"
    assert job["filename"].endswith(".pptx")
    assert job["bytes"] > 0
    # The version, not the presentation. An export is of a version (doc 04
    # §32.3), so a deck edited afterwards does not change what this file holds.
    assert job["version_id"]

    downloaded = client.get(f"/v1/exports/{job['id']}/download", headers=auth)
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument"
    )

    path = tmp_path / "downloaded.pptx"
    path.write_bytes(downloaded.content)
    assert len(pptx.Presentation(str(path)).slides) == job["report"]["slideCount"]


# -------------------------------------------------------------------- pdf


@pytest.mark.slow
def test_a_pdf_export_keeps_text_as_text(client, auth, deck, tmp_path):
    """Doc 04 §34.1's whole reason for printing rather than screenshotting."""
    pypdf = pytest.importorskip("pypdf", reason="pypdf reads the PDF back")

    started = client.post(
        f"/v1/presentations/{deck}/exports", headers=auth, json={"kind": "pdf"}
    )
    assert started.status_code == 200, started.text
    job = started.json()
    assert job["status"] == "completed"

    downloaded = client.get(f"/v1/exports/{job['id']}/download", headers=auth)
    path = tmp_path / "downloaded.pdf"
    path.write_bytes(downloaded.content)

    reader = pypdf.PdfReader(str(path))

    # One page per slide, and no extra (doc 04 §34.2, §34.3's blank-page mode).
    assert len(reader.pages) == job["report"]["slideCount"]

    # 1920×1080 logical px at 96dpi is exactly 20in × 11.25in = 1440 × 810pt.
    page = reader.pages[0]
    assert round(float(page.mediabox.width)) == 1440
    assert round(float(page.mediabox.height)) == 810

    # Selectable, searchable text — the thing a screenshot pipeline cannot give.
    assert reader.pages[0].extract_text().strip()


# ----------------------------------------------------------------- reporting


@pytest.mark.slow
def test_the_report_is_available_before_the_download(client, auth, deck):
    """Doc 04 §32.2.

    The user sees what was degraded before they hand the file to a client, not
    after. That means the report is on the status response, not streamed past
    during the job.
    """
    started = client.post(
        f"/v1/presentations/{deck}/exports", headers=auth, json={"kind": "pptx"}
    )
    job_id = started.json()["id"]

    status = client.get(f"/v1/exports/{job_id}", headers=auth)
    report = status.json()["report"]

    assert report is not None
    assert "warnings" in report and "unsupportedFeatures" in report
    assert report["slideCount"] > 0

    for warning in report["warnings"]:
        # "Unsupported" tells a reader nothing; the action is what they act on.
        assert warning["action"] in {"flattened", "rasterized", "dropped", "approximated"}
        assert warning["message"]


@pytest.mark.slow
def test_a_stub_deck_reports_what_powerpoint_cannot_carry(client, auth, deck):
    started = client.post(
        f"/v1/presentations/{deck}/exports", headers=auth, json={"kind": "pptx"}
    )
    report = started.json()["report"]

    # The stub deck has a code block and a metrics slide, so at minimum the code
    # element is flattened into a text box and said so.
    assert report["unsupportedFeatures"], "a deck with charts and code degraded nothing"


# ---------------------------------------------------------------- boundaries


def test_an_unknown_format_is_refused_before_any_work(client, auth, deck):
    response = client.post(
        f"/v1/presentations/{deck}/exports", headers=auth, json={"kind": "keynote"}
    )
    # 422 from the schema: the format is a closed set, so it never reaches the
    # exporter at all.
    assert response.status_code == 422


def test_a_stranger_cannot_export_a_deck_they_cannot_see(client, auth, deck):
    other = client.post("/v1/dev/session", json={"email": "stranger@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}

    response = client.post(
        f"/v1/presentations/{deck}/exports", headers=stranger, json={"kind": "pptx"}
    )
    # 404, not 403: a 403 on something you cannot see confirms it exists.
    assert response.status_code == 404


@pytest.mark.slow
def test_a_stranger_cannot_download_someone_elses_export(client, auth, deck):
    """Authorisation runs through the presentation, not the job's creator.

    A colleague with access to the deck should be able to read an export of it,
    and someone who lost access must not keep a door open through an export id
    they still remember.
    """
    started = client.post(
        f"/v1/presentations/{deck}/exports", headers=auth, json={"kind": "pptx"}
    )
    job_id = started.json()["id"]

    other = client.post("/v1/dev/session", json={"email": "stranger2@localhost"})
    stranger = {"Authorization": f"Bearer {other.json()['token']}"}

    assert client.get(f"/v1/exports/{job_id}", headers=stranger).status_code == 404
    assert client.get(f"/v1/exports/{job_id}/download", headers=stranger).status_code == 404


def test_an_export_that_has_not_finished_cannot_be_downloaded(client, auth, deck):
    from deckastra_api import export_service
    from deckastra_api.db.models import ExportJob

    with db_session.session_scope() as session:
        job = export_service.create_job(
            session,
            presentation_id=deck,
            version_id="ver_x",
            created_by="usr_x",
            kind="pdf",
        )
        job_id = job.id

    response = client.get(f"/v1/exports/{job_id}/download", headers=auth)
    # 409 rather than 404: the export exists, it is just not ready. A 404 would
    # send the caller looking for a job id that is perfectly valid.
    assert response.status_code == 409

    with db_session.session_scope() as session:
        assert session.get(ExportJob, job_id).status == "queued"


def test_an_artifact_that_was_cleaned_up_says_so(client, auth, deck):
    from deckastra_api import export_service
    from deckastra_api.db.models import ExportJob

    with db_session.session_scope() as session:
        job = export_service.create_job(
            session,
            presentation_id=deck,
            version_id="ver_x",
            created_by="usr_x",
            kind="pptx",
        )
        job.status = "completed"
        job.artifact_path = "/nowhere/gone.pptx"
        job_id = job.id

    response = client.get(f"/v1/exports/{job_id}/download", headers=auth)
    assert response.status_code == 409
    # Actionable: the user can re-run it, and the row is still the record that
    # the export happened.
    assert "again" in response.json()["detail"]
