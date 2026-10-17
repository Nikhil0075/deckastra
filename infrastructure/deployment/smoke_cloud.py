"""Exercise hosted auth, credits and export without printing credentials."""
import json
import argparse
import secrets
import time
import uuid
import io
import zipfile
from pathlib import Path

import httpx
from bootstrap import Cloud


def _paused(reply):
    """Switched off by the monthly budget stop: deliberate, so reported, not failed."""
    try:
        body = reply.json()
    except ValueError:
        return False
    return reply.status_code in (502, 503) and "budget stop" in str(body.get("detail", ""))


def check_ai_services(http, url, headers):
    """One bounded check per cloud capability (release 8, 2026-10-17).

    Translation and speech are called for real with a word or two, which costs
    a fraction of a US cent of the disposable account's credits and proves the
    API is enabled, the service account may call it and the credits are
    charged. Pictures and video are priced but never generated: a generation
    would pay for media on every deploy. Every failure must be JSON with a
    reason; a body the desktop could not parse fails the check outright.
    """
    results = {}

    def outcome(name, reply, ok):
        assert reply.headers.get("content-type", "").startswith("application/json"),             f"{name}: answered {reply.status_code} with {reply.headers.get('content-type')!r}, which the desktop cannot read"
        if ok(reply):
            results[name] = "ok"
        elif _paused(reply):
            results[name] = "paused by the budget stop"
        else:
            raise AssertionError(f"{name}: {reply.status_code} {reply.text[:300]}")

    outcome("translation", http.post(url + "/v1/assistant/translate", headers=headers,
            json={"items": [{"id": "t", "text": "Hello"}], "source": "en", "target": "hi"}),
            lambda r: r.status_code == 200 and r.json()["translations"].get("t"))
    outcome("voices", http.get(url + "/v1/speech/voices?locale=en-US", headers=headers),
            lambda r: r.status_code == 200 and r.json().get("voices"))
    outcome("speech", http.post(url + "/v1/assistant/speech", headers=headers,
            json={"text": "Deck check.", "locale": "en-US"}),
            lambda r: r.status_code == 200 and r.json()["audio"]["data"])
    for task in ("image", "translation"):
        outcome(f"{task} quote", http.post(url + "/v1/assistant/quote", headers=headers,
                json={"task": task, "units": 10, "prompt": "A blue square"}),
                lambda r: r.status_code == 200 and r.json()["credit_cost"] >= 0)
    capabilities = http.get(url + "/v1/account/capabilities", headers=headers).json()["tasks"]
    results["video price"] = "ok" if capabilities["video"].get("usd_per_second") else "missing"
    assert results["video price"] == "ok", f"Video has no per-second price: {capabilities['video']}"
    print("AI services: " + ", ".join(f"{name} {state}" for name, state in results.items()))
    return results


def run_smoke(cloud, url=None):
    url = url or cloud.run("run", "services", "describe", "deckastra-api", f"--region={cloud.region}", "--format=value(status.url)").stdout.strip()
    config = cloud.rest("GET", f"https://identitytoolkit.googleapis.com/v2/projects/{cloud.project}/config")
    key = config["client"]["apiKey"]
    email = f"cloud-check-{uuid.uuid4().hex}@example.invalid"
    password = secrets.token_urlsafe(32)
    identity = cloud.rest("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{cloud.project}/accounts?key={key}",
        {"email": email, "password": password, "emailVerified": True, "returnSecureToken": True})
    uid = identity["localId"]
    # Only the disposable identity and Deckastra ids are written for cleanup.
    state = Path(__file__).parent / "state" / f"smoke-{cloud.project}.json"
    try:
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps({"uid": uid, "email": email}))
        with httpx.Client(timeout=90) as http:
            login = http.post(f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={key}",
                json={"email": email, "password": password, "returnSecureToken": True})
            assert login.status_code == 200, f"Sign-in status {login.status_code}"
            headers = {"Authorization": "Bearer " + login.json()["idToken"]}
            assert http.get(url + "/ready").status_code == 200
            assert http.get(url + "/v1/account/credits").status_code == 401
            balance = http.get(url + "/v1/account/credits", headers=headers)
            assert balance.status_code == 200, f"Credit API status {balance.status_code}"
            # A new account starts with the configured monthly allowance
            # (DECKASTRA_FREE_MONTHLY_CREDITS, 300 in the small size since
            # 2026-10-12), not a figure written into this check.
            granted = balance.json()
            assert granted["monthly_allowance"] >= 60 and granted["remaining_credits"] == granted["monthly_allowance"], f"Credits: {granted}"
            made = http.post(url + "/v1/presentations", headers=headers, json={"title": "Disposable cloud check"})
            assert made.status_code == 201, f"Create status {made.status_code}: {made.text[:200]}"
            deck = made.json()
            design = http.get(url + f"/v1/presentations/{deck['presentation_id']}/design-check", headers=headers)
            assert design.status_code == 200 and isinstance(design.json()["findings"], list), f"Design Check status {design.status_code}"
            state.write_text(json.dumps({"uid": uid, "email": email, "presentation_id": deck["presentation_id"]}))
            export = http.post(url + f"/v1/presentations/{deck['presentation_id']}/exports", headers=headers, json={"kind": "pdf"})
            assert export.status_code == 202, f"Export create status {export.status_code}"
            job = export.json()
            for _ in range(60):
                time.sleep(3)
                status = http.get(url + f"/v1/exports/{job['id']}", headers=headers).json()
                if status["status"] in {"completed", "failed", "cancelled"}:
                    break
            assert status["status"] == "completed", f"Export status: {status}"
            download = http.get(url + f"/v1/exports/{job['id']}/download", headers=headers, follow_redirects=True)
            assert download.status_code == 200 and download.content.startswith(b"%PDF")
            package_export = http.post(url + f"/v1/presentations/{deck['presentation_id']}/exports", headers=headers, json={"kind": "mydeck"})
            assert package_export.status_code == 202, f"Package export status {package_export.status_code}"
            package_job = package_export.json()["id"]
            for _ in range(60):
                time.sleep(2)
                package_status = http.get(url + f"/v1/exports/{package_job}", headers=headers).json()
                if package_status["status"] in {"completed", "failed", "cancelled"}: break
            assert package_status["status"] == "completed", package_status.get("error")
            payload = http.get(url + f"/v1/exports/{package_job}/download", headers=headers, follow_redirects=True).content
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                assert archive.namelist()[0] == "mimetype"
                assert archive.getinfo("mimetype").compress_type == zipfile.ZIP_STORED
                assert json.loads(archive.read("manifest.json"))["format"] == "mydeck"
            account = http.get(url + "/v1/account", headers=headers).json()
            project = account["workspaces"][0]["projects"][0]["id"]
            imported = http.post(url + f"/v1/projects/{project}/imports", headers=headers, json={"size_bytes": len(payload), "copy": True})
            assert imported.status_code == 201
            upload = imported.json()
            assert http.put(upload["upload_url"], headers=upload["headers"], content=payload).status_code == 200
            assert http.post(url + f"/v1/imports/{upload['id']}/complete", headers=headers).status_code == 202
            for _ in range(60):
                time.sleep(2)
                imported_status = http.get(url + f"/v1/imports/{upload['id']}", headers=headers).json()
                if imported_status["status"] in {"completed", "existing", "failed"}: break
            assert imported_status["status"] == "completed", imported_status.get("error")
            assert imported_status["presentation_id"] != deck["presentation_id"]
            fonts = http.get(url + "/v1/font-packs/japanese")
            assert fonts.status_code == 200 and len(fonts.json()["files"]) == 2
            # The AI gate, checked without spending anything. Image generation
            # is on since 2026-10-12, so the old check (expect a refusal for a
            # real image request) would now generate and pay for a picture on
            # every deploy. Instead: an unsigned call is refused, a malformed
            # device is refused before any provider is reached, and the
            # account's capabilities say the configured media are available.
            ask = {"task": "image", "system": "Create an image", "messages": [{"role": "user", "content": "Blue abstract background"}], "image_output": True}
            assert http.post(url + "/v1/assistant/infer", json=ask).status_code == 401
            assert http.post(url + "/v1/assistant/infer", headers={**headers, "X-Deckastra-Device": "x" * 129}, json=ask).status_code == 422
            offered = http.get(url + "/v1/account/capabilities", headers=headers)
            assert offered.status_code == 200, f"Capabilities status {offered.status_code}"
            tasks = offered.json()["tasks"]
            assert tasks["image"]["available"] and tasks["video"]["available"], f"Media not configured: {tasks}"
            check_ai_services(http, url, {**headers, "X-Deckastra-Device": str(uuid.uuid4())})
            deletion = http.request("DELETE", url + "/v1/account", headers=headers, json={"confirm": "DELETE"})
            assert deletion.status_code == 202, f"Deletion status {deletion.status_code}"
            receipt = deletion.json()["id"]
            state.write_text(json.dumps({"uid": uid, "email": email, "presentation_id": deck["presentation_id"], "deletion_receipt": receipt}))
            assert http.get(url + "/v1/account/credits", headers=headers).status_code == 401
            assert http.get(url + f"/v1/account/deletions/{receipt}").json()["status"] == "queued"
            print("PASS: verified identity, auth, monthly credits, deterministic Design Check, queued PDF and .mydeck export/import copy, private GCS downloads, CJK pack links, AI gate and per-service checks, account deletion queue and immediate bearer-token denial.")
    finally:
        cloud.rest("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{cloud.project}/accounts:delete", {"localId": uid})
        print("Disposable Identity Platform user removed; database cleanup ids saved in ignored state.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="asia-south1")
    parser.add_argument("--configuration", default="deckastra")
    args = parser.parse_args()
    run_smoke(Cloud(args.project, args.region, args.configuration))
