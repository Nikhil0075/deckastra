import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deckastra_api import font_packs


def test_verified_cjk_cache_works_offline_and_tampered_cache_is_refused(tmp_path, monkeypatch):
    payload = b"verified fixture font"
    pack = {"files": [{"name": "japanese-400.woff2", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}]}
    monkeypatch.setattr(font_packs, "catalog", lambda: {"japanese": pack})
    monkeypatch.setenv("DECKASTRA_FONT_PACK_DIR", str(tmp_path))
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    def offline(*args, **kwargs): raise OSError("offline")
    monkeypatch.setattr(font_packs, "urlopen", offline)
    cached = tmp_path / "japanese-400.woff2"
    cached.write_bytes(payload)
    font_packs.ensure_for_document({"metadata": {"language": "ja"}})
    cached.write_bytes(b"tampered")
    with pytest.raises(OSError, match="offline"):
        font_packs.ensure_for_document({"metadata": {"language": "ja"}})
