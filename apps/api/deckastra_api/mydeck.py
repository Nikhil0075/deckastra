"""Validate an exchange container completely before creating any rows or objects."""
import hashlib
import io
import json
import re
import stat
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath

from . import assets
from .schema import validate_document

MIME = "application/vnd.deckastra.mydeck+zip"
MAX_ENTRIES, MAX_TOTAL, MAX_ASSET, MAX_RATIO = 2000, 1024 ** 3, 200 * 1024 ** 2, 100


class PackageError(ValueError):
    pass


@dataclass
class Package:
    document: dict
    files: dict
    assets: list
    extras: dict


def safe_path(name):
    return (isinstance(name, str) and bool(name) and "\\" not in name and ":" not in name and "\x00" not in name
        and not name.startswith("/") and all(part not in ("", ".", "..") for part in name.split("/")))


def _json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PackageError("M005: Duplicate JSON key.")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(PackageError("M005: Non-finite JSON value.")))
    except (UnicodeError, ValueError) as error:
        raise PackageError("M005: Invalid package JSON.") from error


def sniff(data):
    """Restricted byte signatures: names and manifest MIME types confer no trust."""
    signatures = [(b"\x89PNG\r\n\x1a\n", "image/png", "image"), (b"\xff\xd8\xff", "image/jpeg", "image"),
        (b"GIF87a", "image/gif", "image"), (b"GIF89a", "image/gif", "image"), (b"OggS", "audio/ogg", "audio"),
        (b"ID3", "audio/mpeg", "audio"), (b"fLaC", "audio/flac", "audio"), (b"wOFF", "font/woff", "font"),
        (b"wOF2", "font/woff2", "font"), (b"OTTO", "font/otf", "font"), (b"\x00\x01\x00\x00", "font/ttf", "font"),
        (b"%PDF-", "application/pdf", "document")]
    for prefix, mime, kind in signatures:
        if data.startswith(prefix):
            return mime, kind
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp", "image"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE": return "audio/wav", "audio"
    if data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"): return "audio/mpeg", "audio"
    # No SVG/HTML/executable or arbitrary text is admitted as an asset.
    raise PackageError("M011: Unsupported or disguised asset bytes.")


def read_package(data):
    if len(data) > MAX_TOTAL: raise PackageError("M003: Package size limit exceeded.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if not entries or entries[0].filename != "mimetype" or entries[0].header_offset != 0 or entries[0].compress_type != zipfile.ZIP_STORED:
                raise PackageError("M001: The first entry must be a stored mimetype.")
            if len(entries) > MAX_ENTRIES or sum(e.file_size for e in entries) > MAX_TOTAL:
                raise PackageError("M003: Package size limit exceeded.")
            names = set()
            for entry in entries:
                if not safe_path(entry.filename) or stat.S_ISLNK(entry.external_attr >> 16) or entry.is_dir():
                    raise PackageError("M004: Unsafe package path or link.")
                if entry.filename in names: raise PackageError("M005: Duplicate archive entry.")
                names.add(entry.filename)
                if entry.flag_bits & 1 or entry.compress_type not in (0, 8): raise PackageError("M003: Unsupported archive encoding.")
                if entry.file_size > MAX_ASSET or entry.file_size / max(1, entry.compress_size) > MAX_RATIO:
                    raise PackageError("M003: Unsafe compression ratio or entry size.")
            if archive.read("mimetype") != MIME.encode(): raise PackageError("M001: Invalid mimetype.")
            if not {"document.json", "manifest.json"} <= names: raise PackageError("M006: Missing manifest or document.")
            if archive.getinfo("manifest.json").file_size > 4 * 1024 ** 2 or archive.getinfo("document.json").file_size > 12 * 1024 ** 2:
                raise PackageError("M003: JSON size limit exceeded.")
            manifest = _json(archive.read("manifest.json"))
            if not isinstance(manifest, dict) or manifest.get("format") != "mydeck": raise PackageError("M006: Invalid manifest.")
            if manifest.get("formatVersion") != 1: raise PackageError("M007: Made by a newer or unsupported Deckastra; update to open it.")
            files, specs = {}, manifest.get("files")
            if not isinstance(specs, list) or len(specs) > MAX_ENTRIES: raise PackageError("M006: Invalid file manifest.")
            seen = set()
            for spec in specs:
                if not isinstance(spec, dict): raise PackageError("M006: Invalid file metadata.")
                path = spec.get("path")
                if not safe_path(path) or path in seen or path in {"mimetype", "manifest.json"} or path not in names:
                    raise PackageError("M006: Missing, duplicate or invalid manifest file.")
                seen.add(path)
                payload = archive.read(path)
                if spec.get("bytes") != len(payload) or spec.get("sha256") != hashlib.sha256(payload).hexdigest():
                    raise PackageError("M008: Package hash or size mismatch.")
                files[path] = payload
            if "document.json" not in files or any(name not in seen and name not in {"mimetype", "manifest.json"} and not name.startswith("extras/") for name in names):
                raise PackageError("M006: Unlisted package file.")
            document = _json(files["document.json"])
            if not isinstance(document, dict) or not re.fullmatch(r"1\.\d+\.\d+", str(document.get("schemaVersion"))):
                raise PackageError("M007: Unsupported document schema; update Deckastra.")
            if manifest.get("schemaVersion") != document.get("schemaVersion") or manifest.get("presentationId") != document.get("id"):
                raise PackageError("M006: Document identity does not match its manifest.")
            errors = validate_document(document)
            if errors: raise PackageError("M009: Invalid document: " + "; ".join(errors))
            packaged_assets, ids = [], set()
            for spec in specs:
                if spec["path"].startswith("assets/"):
                    asset_id = spec.get("assetId")
                    if not isinstance(asset_id, str) or not re.fullmatch(r"ast_[0-9A-HJKMNP-TV-Z]{26}", asset_id) or asset_id in ids:
                        raise PackageError("M006: Invalid or duplicate packaged asset.")
                    mime, kind = sniff(files[spec["path"]])
                    if spec.get("contentType") != mime: raise PackageError("M011: Asset content type does not match its bytes.")
                    if kind == "image":
                        from PIL import Image
                        try:
                            with Image.open(io.BytesIO(files[spec["path"]])) as image: image.verify()
                        except Exception as error:
                            raise PackageError("M011: Invalid image bytes.") from error
                    if kind == "font":
                        from fontTools.ttLib import TTFont
                        try:
                            face = TTFont(io.BytesIO(files[spec["path"]]), lazy=False)
                            if "cmap" not in face: raise ValueError("Missing character map")
                            face.close()
                        except Exception as error:
                            raise PackageError("M011: Invalid font bytes.") from error
                    ids.add(asset_id)
                    packaged_assets.append((asset_id, spec, mime, kind))
            if not assets.referenced_ids(document) <= ids: raise PackageError("M010: A cited asset is missing from the package.")
            # Unknown extras remain opaque and never execute in the renderer.
            extras = {name: archive.read(name) for name in names if name.startswith("extras/")}
            return Package(document, files, packaged_assets, extras)
    except PackageError:
        raise
    except (zipfile.BadZipFile, KeyError, OSError, RuntimeError, RecursionError, TypeError) as error:
        raise PackageError("M002: Invalid or corrupt ZIP container.") from error
