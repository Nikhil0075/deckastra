"""Free, fixed font packs. No account, model, or document upload is involved."""
import hashlib
import json
import os
import tempfile
import threading
from pathlib import Path
from urllib.request import urlopen
from fastapi import APIRouter, HTTPException
from .paths import resource_root

router = APIRouter(prefix="/v1/font-packs")
PREFIX = "fonts/noto-cjk-2.004/"
_lock = threading.Lock()


def catalog():
    path = resource_root() / "packages/renderer/font-packs/catalog.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


@router.get("/{pack}")
def download_links(pack: str):
    entry = catalog().get(pack)
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not entry or not project: raise HTTPException(404, "No such font pack.")
    from .gcs_storage import signed_url
    bucket = project + "-packs"
    return {**entry, "files": [{**file, "url": signed_url(bucket, PREFIX + file["name"])} for file in entry["files"]],
        "license_url": signed_url(bucket, PREFIX + "OFL.txt")}


def ensure_for_document(document, locale=None):
    language = (locale or document.get("metadata", {}).get("language", "en")).lower()
    pack = "japanese" if language.startswith("ja") else "korean" if language.startswith("ko") else (
        "chinese-traditional" if any(tag in language for tag in ("hant", "tw", "hk", "mo")) else "chinese") if language.startswith("zh") else None
    if not pack: return
    entry = catalog().get(pack)
    if not entry: raise RuntimeError("The required CJK font pack is not available.")
    root = Path(os.environ.get("DECKASTRA_FONT_PACK_DIR", str(Path(tempfile.gettempdir()) / "deckastra-font-packs")))
    root.mkdir(parents=True, exist_ok=True)
    with _lock:
        for file in entry["files"]:
            target = root / file["name"]
            if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == file["sha256"]: continue
            project = os.environ.get("GOOGLE_CLOUD_PROJECT")
            if project and os.environ.get("DECKASTRA_ENV") == "production":
                from .gcs_storage import client
                payload = client().bucket(project + "-packs").blob(PREFIX + file["name"]).download_as_bytes()
            else:
                api = "https://deckastra-api-zit47xh5eq-el.a.run.app"
                with urlopen(api + f"/v1/font-packs/{pack}", timeout=30) as reply: links = json.load(reply)
                url = next(item["url"] for item in links["files"] if item["name"] == file["name"])
                with urlopen(url, timeout=90) as reply: payload = reply.read(file["bytes"] + 1)
            if len(payload) != file["bytes"] or hashlib.sha256(payload).hexdigest() != file["sha256"]:
                raise RuntimeError("The font pack failed its integrity check.")
            staging = target.with_suffix(".tmp")
            staging.write_bytes(payload)
            staging.replace(target)
    os.environ["DECKASTRA_FONT_PACK_DIR"] = str(root)
