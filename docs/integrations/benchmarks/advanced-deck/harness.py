"""Drive the real assistant routes with the advanced deck. Local-only: no paid calls.

Usage: python harness.py setup            -> creates DB, deck, assets; writes state.json
       python harness.py run TASK [k=v...] -> one assistant run, recorded to runs/
"""
import json, os, sys, time, uuid
from pathlib import Path

HERE = Path(__file__).parent
WORK = HERE / "work"
WORK.mkdir(exist_ok=True)
ROOT = Path(r"D:\Presentation_app")
sys.path[:0] = [str(ROOT / "apps/api"), str(ROOT / "agents")]

# --- isolated, local-only environment (no Google, no Anthropic, no paid ledger)
local = json.loads(Path(os.environ.get("DECKASTRA_ASSISTANT_CONFIG", r"C:\Users\ROG\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\Deckastra\assistant\local-config.json")).read_text(encoding="utf-8-sig"))
for key in ("DECKASTRA_MODEL_SERVER_CMD", "DECKASTRA_ASSISTANT_PACK", "DECKASTRA_MODEL_PACK", "DECKASTRA_MODEL_DIR", "DECKASTRA_ASSISTANT_HARDWARE", "DECKASTRA_ASSISTANT_RUNTIME"):
    os.environ[key] = local[key]
for key in list(os.environ):
    if key.startswith(("DECKASTRA_VERTEX", "DECKASTRA_GOOGLE", "GOOGLE_", "ANTHROPIC")) or key in ("DECKASTRA_SPEECH", "DECKASTRA_TRANSLATION", "DECKASTRA_ASSISTANT_QUALIFICATION", "DECKASTRA_INTELLIGENCE", "DECKASTRA_SPEECH_USD_PER_MILLION"):
        del os.environ[key]
os.environ.update(
    DATABASE_URL=f"sqlite:///{(WORK / 'assistant.db').as_posix()}",
    DECKASTRA_ASSET_DIR=str(WORK / "assets"), DECKASTRA_EXPORT_DIR=str(WORK / "exports"),
    DECKASTRA_DEV_SECRET="harness-secret", DECKASTRA_ASSISTANT_MODE=os.environ.get("HARNESS_MODE", "local"),
    DECKASTRA_ASSISTANT_COST_LEDGER=str(WORK / "ledger.sqlite"),
)

from fastapi.testclient import TestClient  # noqa: E402
from deckastra_api.db import session as db_session  # noqa: E402

STATE = WORK / "state.json"


def app_client():
    from deckastra_api import assistant_routes
    assistant_routes.start_dispatcher = lambda: __import__("threading").Event()
    from deckastra_api.main import app
    return TestClient(app)


def setup():
    db_session.reset_engine(); db_session.create_all()
    from deckastra_api import object_storage, assets, store
    from deckastra_api.assistant_assets import fingerprints
    from deckastra_api.db.session import session_scope
    deck = json.loads((HERE / "advanced/advanced.mydeck.json").read_text(encoding="utf-8"))
    ids = json.loads((HERE / "advanced/ids.json").read_text())
    with app_client() as client:
        token = client.post("/v1/dev/session", json={"email": "harness@localhost"}).json()["token"]
        auth = {"Authorization": f"Bearer {token}"}
        account = client.get("/v1/account", headers=auth).json()
        ws = account["workspaces"][0]; project = ws["projects"][0]["id"]
        with session_scope() as session:
            def put(name, ctype, kind="image", asset_id=None):
                data = (HERE / "advanced" / name).read_bytes()
                key = f"workspaces/{ws['id']}/assets/{uuid.uuid4().hex}/{name}"
                object_storage.put(key, data, ctype)
                from PIL import Image
                size = Image.open(HERE / "advanced" / name).size if ctype.startswith("image/") else (None, None)
                row = assets.register(session, workspace_id=ws["id"], created_by=account.get("user", {}).get("id", "harness"), storage_key=key, kind=kind, filename=name, content_type=ctype, size_bytes=len(data), width=size[0], height=size[1])
                if asset_id:
                    session.flush()
                    row.id = asset_id
                row.sha256, row.dhash64 = fingerprints(data, ctype)
                session.flush()
                return row
            img = put("adoption.png", "image/png", asset_id=ids["IMG_ID"])
            deco = put("swoosh.png", "image/png", asset_id=ids["DECO_ID"])
            for entry in deck["assets"]:
                for row in (img, deco):
                    if entry["id"] == row.id:
                        entry.update(storageKey=row.storage_key, byteSize=row.bytes)
            small = put("adoption-small.png", "image/png"); copy = put("adoption-copy.png", "image/png")
            csv = put("revenue.csv", "text/csv", kind="document"); pdf = put("market-brief.pdf", "application/pdf", kind="document")
            user_id = session.execute(__import__("sqlalchemy").text("select id from users limit 1")).scalar()
            loaded = store.create_presentation(session, project_id=project, document=deck, created_by=user_id)
            state = dict(token=token, presentation_id=loaded.presentation_id if hasattr(loaded, "presentation_id") else deck["id"], version_id=loaded.version_id, project=project, workspace=ws["id"],
                         csv=csv.id, pdf=pdf.id, small=small.id, copy=copy.id, **ids)
    STATE.write_text(json.dumps(state, indent=1))
    print(json.dumps(state, indent=1))


def head(client, auth, pid):
    return client.get(f"/v1/presentations/{pid}/head", headers=auth).json()["version_id"]


def run(task, **kw):
    state = json.loads(STATE.read_text())
    auth = {"Authorization": f"Bearer {state['token']}"}
    with app_client() as client:
        pid = state["presentation_id"]
        version = head(client, auth, pid)
        scope = kw.pop("scope", {"kind": "slide", "slide_ids": [state["faults"]], "element_ids": []})
        body = {"task": task, "presentation_id": pid, "expected_version_id": kw.pop("expected_version_id", version), "operation_key": uuid.uuid4().hex, "scope": scope, **kw}
        started = time.monotonic()
        created = client.post("/v1/assistant/runs", headers=auth, json=body)
        record = {"task": task, "request": body, "create_status": created.status_code, "create": created.json()}
        if created.status_code == 202:
            run_id = created.json()["id"]
            first_event = None
            while True:
                current = client.get(f"/v1/assistant/runs/{run_id}", headers=auth).json()
                if first_event is None:
                    first_event = time.monotonic() - started
                if current["status"] not in ("queued", "running"):
                    break
                time.sleep(1)
            record.update(final=current, seconds=round(time.monotonic() - started, 2), first_poll_s=round(first_event, 3),
                          events=client.get(f"/v1/assistant/runs/{run_id}/events", headers=auth).json()["events"])
            result = current.get("result") or {}
            if result.get("proposal_id") or result.get("id"):
                pass
            record["head_after"] = head(client, auth, pid)
            record["proposals"] = client.get(f"/v1/presentations/{pid}/proposals", headers=auth).json()
        name = f"{task}-{time.strftime('%H%M%S')}.json"
        (WORK / "runs").mkdir(exist_ok=True)
        (WORK / "runs" / name).write_text(json.dumps(record, indent=1, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({k: record.get(k) for k in ("task", "create_status", "seconds")}, ensure_ascii=False))
        final = record.get("final") or record["create"]
        print("status:", final.get("status"), "| error:", (final.get("error") or final.get("detail") or "")[:1500])
        res = (final.get("result") or {})
        print("result keys:", list(res.keys()), "| summary:", str(res.get("summary"))[:400])
        print("events:", [e.get("status") + ":" + str(e.get("message") or e.get("reason") or "")[:80] for e in record.get("events", [])])
        print("budget:", json.dumps(final.get("budget"))[:600] if final.get("budget") else None)
        return record


if __name__ == "__main__":
    if sys.argv[1] == "setup":
        setup()
    else:
        kwargs = json.loads(os.environ.get('HARNESS_ARGS', '{}'))
        run(sys.argv[-1], **kwargs)
