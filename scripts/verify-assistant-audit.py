#!/usr/bin/env python
"""Verify engine jobs against the advanced deck over HTTP, without paid inference.

--frozen uses the packaged Windows service. --keep-running leaves a development
HTTP service available for browser verification until interrupted. Evidence and
the isolated database live under docs/integrations/benchmarks/audit-remediation.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "agents"), str(ROOT / "apps/api")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frozen", action="store_true")
    parser.add_argument("--keep-running", action="store_true")
    parser.add_argument("--local-config", default=os.environ.get("DECKASTRA_ASSISTANT_CONFIG"))
    args = parser.parse_args()
    run_dir = ROOT / "docs/integrations/benchmarks/audit-remediation" / ("frozen" if args.frozen else "web")
    run_dir.mkdir(parents=True, exist_ok=True)
    fixture_dir = ROOT / "docs/integrations/benchmarks/advanced-deck/advanced"
    if not args.local_config: parser.error("Set --local-config to the installed assistant configuration")
    config = json.loads(Path(args.local_config).read_text(encoding="utf-8-sig"))
    environment = {**os.environ, **config}
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DECKASTRA_INTELLIGENCE", "DECKASTRA_ENV", "DECKASTRA_LOCAL_MODE"):
        environment.pop(key, None)
    secret = secrets.token_urlsafe(32)
    environment.update(DATABASE_URL=f"sqlite:///{(run_dir / 'deckastra.db').as_posix()}", DECKASTRA_ASSET_DIR=str(run_dir / "assets"), DECKASTRA_EXPORT_DIR=str(run_dir), DECKASTRA_DEV_SECRET=secret, DECKASTRA_WEB_ORIGINS="http://localhost:3019,http://127.0.0.1:3019", PYTHONPATH=os.pathsep.join([str(ROOT / "agents"), str(ROOT / "apps/api"), str(ROOT / "integrations")]))
    if args.frozen:
        environment["DECKASTRA_LOCAL_SECRET"] = secret
        environment["DECKASTRA_DESIGN_CHECK_CMD"] = f'"{shutil.which("node")}" "{ROOT / "apps/desktop/dist/worker/assistant-design-check.cjs"}"'
        command = [str(ROOT / "apps/desktop/dist/sidecar/deckastra-service/deckastra-service.exe"), "--data-dir", str(run_dir)]
    else:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        command = [sys.executable, "-m", "uvicorn", "deckastra_api.main:app", "--host", "127.0.0.1", "--port", str(port)]
        os.environ.update(environment)
        from deckastra_api.db import session as db
        db.create_all()
    log = (run_dir / "server.log").open("w", encoding="utf-8")
    process = subprocess.Popen(command, env=environment, cwd=ROOT, stdout=subprocess.PIPE if args.frozen else log, stderr=log, text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        if args.frozen:
            lines = queue.Queue()
            threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True).start()
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                try: record = json.loads(lines.get(timeout=1))
                except (queue.Empty, ValueError): continue
                if record.get("ready"): port = record["port"]; break
            else: raise RuntimeError("Packaged service did not become ready")
            environment["DECKASTRA_LOCAL_MODE"] = "1"
        url = f"http://127.0.0.1:{port}"
        client = httpx.Client(base_url=url, timeout=45)
        for attempt in range(100):
            try:
                if client.get("/health").status_code == 200: break
            except httpx.HTTPError: pass
            if process.poll() is not None: raise RuntimeError("HTTP service exited before readiness")
            time.sleep(.1)
        else: raise RuntimeError("HTTP service did not become ready")
        token = secret if args.frozen else client.post("/v1/dev/session", json={"email": "dev@localhost"}).json()["token"]
        client.headers["Authorization"] = "Bearer " + token
        account = client.get("/v1/account").json()
        workspace = account["workspaces"][0]
        project_id = workspace["projects"][0]["id"]
        os.environ.update(environment)
        from deckastra_api import store, assets, object_storage
        from deckastra_api.db.session import session_scope
        from deckastra_api.assistant_assets import fingerprints
        from deckastra_api.ids import new_id
        document = json.loads((fixture_dir / "advanced.mydeck.json").read_text(encoding="utf-8"))
        ids = json.loads((fixture_dir / "ids.json").read_text())
        document["id"] = new_id("doc")
        with session_scope() as session:
            for name, asset_id in (("adoption.png", ids["IMG_ID"]), ("swoosh.png", ids["DECO_ID"])):
                from PIL import Image
                data = (fixture_dir / name).read_bytes()
                key = f"workspaces/{workspace['id']}/assets/audit/{name}"
                object_storage.put(key, data, "image/png")
                asset = session.get(__import__("deckastra_api.db.models", fromlist=["Asset"]).Asset, asset_id)
                if asset is None:
                    width, height = Image.open(fixture_dir / name).size
                    asset = assets.register(session, workspace_id=workspace["id"], created_by=account["user"]["id"], storage_key=key, kind="image", filename=name, content_type="image/png", size_bytes=len(data), width=width, height=height)
                    session.flush(); asset.id = asset_id
                    asset.sha256, asset.dhash64 = fingerprints(data, "image/png")
                for entry in document.get("assets", []):
                    if entry["id"] == asset_id: entry.update(storageKey=key, byteSize=len(data), fileName=name)
            loaded = store.create_presentation(session, project_id=project_id, document=document, created_by=account["user"]["id"])
        version = loaded.version_id
        evidence = {"transport": "HTTP", "frozen": args.frozen, "presentation_id": document["id"], "slide_count": 21, "api_url": url, "runs": []}
        for task, sid in (("tidy", ids["faults"]), ("motion", ids["data"])):
            started = time.monotonic()
            created = client.post("/v1/assistant/runs", json={"task": task, "presentation_id": document["id"], "expected_version_id": version, "operation_key": str(uuid.uuid4()), "scope": {"kind": "slide", "slide_ids": [sid], "element_ids": []}})
            assert created.status_code == 202, created.text
            first_progress = time.monotonic() - started
            run_id = created.json()["id"]
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                result = client.get(f"/v1/assistant/runs/{run_id}").json()
                if result["status"] not in {"queued", "running"}: break
                time.sleep(.1)
            assert result["status"] == "completed", result
            assert result["budget"]["used_cost_usd"] == 0 and result["budget"]["reserved_cost_usd"] == 0
            events = client.get(f"/v1/assistant/runs/{run_id}/events").json()["events"]
            assert any(event.get("provider") == "engine" for event in events) or result["result"].get("provider") == "engine"
            evidence["runs"].append({"task": task, "queued_seconds": first_progress, "terminal_seconds": time.monotonic() - started, "result": result, "events": events})
            if result["result"].get("status") == "applied": version = result["result"]["version_id"]
        history = client.get("/v1/assistant/runs", params={"presentation_id": document["id"]}).json()["runs"]
        assert all(run["result"] is None for run in history)
        evidence["history_bytes"] = len(json.dumps(history).encode())
        evidence["capabilities"] = client.get("/v1/assistant/capabilities", params={"presentation_id": document["id"]}).json()
        (run_dir / "evidence.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"verified": True, "api_url": url, "presentation_id": document["id"], "evidence": str(run_dir / "evidence.json")} ), flush=True)
        if args.keep_running:
            process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        log.close()


if __name__ == "__main__": main()
