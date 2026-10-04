"""Use the editor's TypeScript Design Check; never reproduce its geometry in Python."""
import json
import os
from pathlib import Path
import shlex
import subprocess
from .auth import Principal, Role, current_principal, resolve_presentation_access
from .db.session import get_session
from . import store
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

router = APIRouter(prefix="/v1")


def check(document, slide_id=None, locale=None, *, action=None, scope=None):
    configured = os.environ.get("DECKASTRA_DESIGN_CHECK_CMD")
    if configured:
        command = [p.strip('"') for p in shlex.split(configured, posix=os.name != "nt")]
    else:
        root = Path(__file__).resolve().parents[3]
        bundled = root / "apps/desktop/dist/worker/assistant-design-check.cjs"
        sources = [root / path for path in ("scripts/assistant-design-check.ts", "packages/editor-ui/src/lib/design-check.ts", "packages/editor-ui/src/lib/locale-lens.ts", "packages/renderer/src/scene.ts", "packages/renderer/src/layout-check.ts")]
        if bundled.is_file() and all(bundled.stat().st_mtime >= source.stat().st_mtime for source in sources):
            command = [os.environ.get("DECKASTRA_WORKER_NODE", "node"), str(bundled)]
        else:
            command = [os.environ.get("DECKASTRA_WORKER_NODE", "node"), str(root / "node_modules/tsx/dist/cli.mjs"), str(root / "scripts/assistant-design-check.ts")]
    environment = dict(os.environ)
    environment["ELECTRON_RUN_AS_NODE"] = "1"
    try:
        result = subprocess.run(command, input=json.dumps({"document": document, "slide_id": slide_id, "locale": locale, "action": action, "scope": scope}), text=True, encoding="utf-8", capture_output=True, timeout=20, env=environment, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if result.returncode:
            raise ValueError("Design Check worker failed.")
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired as exc:
        # A slow or busy machine, not a missing runtime: telling someone to
        # configure a command that is already working sends them the wrong way.
        raise HTTPException(503, "Design Check took more than 20 seconds on this computer, so the job stopped before changing anything. Try again when the computer is less busy, or choose fewer slides.") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "Design Check runtime unavailable. Configure DECKASTRA_DESIGN_CHECK_CMD.") from exc


def regressions(before, after):
    def identity(finding):
        elements = tuple(sorted([finding.get("elementId", ""), finding["relatedElementId"]])) if finding.get("relatedElementId") else (finding.get("elementId"),)
        return (finding["code"], finding["slideId"], elements)
    known = {identity(f) for f in before["findings"]}
    severe = {"W103", "W104", "W110", "A102"}
    return [f for f in after["findings"] if identity(f) not in known and (f["severity"] == "error" or f["code"] in severe)]


@router.get("/presentations/{presentation_id}/design-check")
def design_check(presentation_id: str, slide_id: str | None = None, principal: Principal = Depends(current_principal), session: Session = Depends(get_session)):
    resolve_presentation_access(session, user_id=principal.user_id, presentation_id=presentation_id, require=Role.VIEWER)
    loaded = store.load_presentation(session, presentation_id)
    if slide_id and not any(s["id"] == slide_id for s in loaded.document["slides"]):
        raise HTTPException(404, "No such slide.")
    return {**check(loaded.document, slide_id), "version_id": loaded.version_id}
