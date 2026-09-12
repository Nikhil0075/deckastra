"""Physical storage for asset bytes.

The database owns authorization and lifecycle; this module owns bytes. Two
backends implement the same five operations:

- **S3-compatible** for the deployed product. Upload URLs are short-lived and
  completion always verifies the object with HEAD before a row is created, so a
  client cannot claim a smaller object than it uploaded.
- **A local directory** for the desktop build (`DECKASTRA_ASSET_DIR`), where
  there is no S3, no network and one user.

The backends are chosen by configuration rather than by a flag a caller passes,
because every call site must get the same answer — an asset written to one
backend and looked for in the other is a broken image with no error anywhere.

**What "presigned" means locally.** There is nothing to sign. A local URL is an
ordinary authenticated API path, and the desktop's own bearer already guards it;
a second signing scheme would be a second thing to get wrong for no gain. The
contract the callers depend on — *a URL the client can use to move these bytes* —
is unchanged.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote


class ObjectStorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class ObjectMetadata:
    bytes: int
    content_type: str | None
    etag: str | None


# --------------------------------------------------------------- backend choice


def local_root() -> Path | None:
    """The directory this install keeps asset bytes in, or `None` for S3."""
    configured = os.environ.get("DECKASTRA_ASSET_DIR", "").strip()
    return Path(configured) if configured else None


def _local_path(key: str) -> Path:
    """Resolve a storage key inside the local root, refusing to leave it.

    Keys are generated server-side (`workspaces/{id}/assets/{id}`), so traversal
    is not the expected case — but this is the one function that turns a string
    from a database row into a filesystem path, and a check that only runs when
    someone remembers is not a check.
    """
    root = local_root()
    if root is None:
        raise ObjectStorageError("Local asset storage is not configured.")

    resolved = (root / key).resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise ObjectStorageError("That storage key is not inside the asset directory.")
    return resolved


def _meta_path(path: Path) -> Path:
    # Beside the blob rather than inside it: S3 carries content type out of band
    # and the local backend has to answer `metadata()` the same way.
    return path.with_name(path.name + ".meta.json")


# ------------------------------------------------------------------- S3 backend


def _client() -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:  # pragma: no cover - deployment packaging failure
        raise ObjectStorageError("Object storage support is not installed.") from error

    endpoint = os.environ.get("S3_ENDPOINT_URL", "http://localhost:9000")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID", "deckastra"),
        aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY", "deckastra_local"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def bucket() -> str:
    return os.environ.get("S3_ASSETS_BUCKET", "deckastra-assets")


# --------------------------------------------------------------------- the five


def presigned_put(key: str, content_type: str, *, expires_seconds: int = 900) -> str:
    if local_root() is not None:
        return blob_url(key)
    return str(
        _client().generate_presigned_url(
            "put_object",
            Params={"Bucket": bucket(), "Key": key, "ContentType": content_type},
            ExpiresIn=expires_seconds,
            HttpMethod="PUT",
        )
    )


def presigned_get(key: str, *, expires_seconds: int = 900) -> str:
    if local_root() is not None:
        return blob_url(key)
    return str(
        _client().generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket(), "Key": key},
            ExpiresIn=expires_seconds,
            HttpMethod="GET",
        )
    )


def blob_url(key: str) -> str:
    """The API path that serves a local blob.

    Relative on purpose. The desktop reaches its service through a proxy whose
    origin the page never learns, so an absolute URL built here would name a host
    the renderer cannot resolve — and would leak the loopback port into a document
    if one were ever stored.
    """
    return f"/v1/workspace/assets/blob/{quote(key)}"


def metadata(key: str) -> ObjectMetadata:
    if local_root() is not None:
        path = _local_path(key)
        if not path.is_file():
            raise ObjectStorageError("The uploaded object could not be verified.")
        recorded: dict[str, Any] = {}
        meta_file = _meta_path(path)
        if meta_file.is_file():
            try:
                recorded = json.loads(meta_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                recorded = {}
        return ObjectMetadata(
            bytes=path.stat().st_size,
            content_type=recorded.get("content_type"),
            etag=recorded.get("etag"),
        )

    try:
        result = _client().head_object(Bucket=bucket(), Key=key)
    except Exception as error:
        raise ObjectStorageError("The uploaded object could not be verified.") from error
    return ObjectMetadata(
        bytes=int(result.get("ContentLength") or 0),
        content_type=result.get("ContentType"),
        etag=str(result.get("ETag") or "").strip('"') or None,
    )


def delete(key: str) -> None:
    if local_root() is not None:
        path = _local_path(key)
        try:
            path.unlink(missing_ok=True)
            _meta_path(path).unlink(missing_ok=True)
        except OSError as error:
            raise ObjectStorageError(
                "The stored object could not be deleted; cleanup can be retried."
            ) from error
        return

    try:
        _client().delete_object(Bucket=bucket(), Key=key)
    except Exception as error:
        raise ObjectStorageError("The stored object could not be deleted; cleanup can be retried.") from error


# ------------------------------------------------------- local read and write


def put_local(key: str, data: bytes, content_type: str) -> ObjectMetadata:
    """Store bytes locally, recording what S3 would have recorded for us.

    Written to a sibling and moved into place: a half-written asset that
    `metadata()` then measures would be accepted at the wrong size, and the
    upload-completion check exists precisely to catch that.
    """
    path = _local_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_name(f"{path.name}.{os.getpid()}.part")
    try:
        staging.write_bytes(data)
        shutil.move(str(staging), str(path))
    except OSError as error:
        staging.unlink(missing_ok=True)
        raise ObjectStorageError("The object could not be stored.") from error

    meta = {
        "content_type": content_type.split(";", 1)[0].strip().lower(),
        # MD5, matching what S3 puts in an ETag for a single-part upload, so the
        # two backends describe an object the same way.
        "etag": hashlib.md5(data, usedforsecurity=False).hexdigest(),
    }
    _meta_path(path).write_text(json.dumps(meta), encoding="utf-8")
    return ObjectMetadata(bytes=len(data), content_type=meta["content_type"], etag=meta["etag"])


def read_local(key: str) -> tuple[bytes, str]:
    """The bytes and content type of a locally stored object."""
    path = _local_path(key)
    if not path.is_file():
        raise ObjectStorageError("That object is not stored here.")
    info = metadata(key)
    return path.read_bytes(), info.content_type or "application/octet-stream"
