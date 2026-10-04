"""Private Cloud Storage with attached identity and IAM-signed download URLs."""
from __future__ import annotations

import os
from datetime import timedelta
from functools import lru_cache

import google.auth
from google.auth.transport.requests import Request
from google.cloud import storage


@lru_cache(maxsize=1)
def client():
    return storage.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT"))


def blob(bucket: str, key: str):
    if not bucket or not key or key.startswith("/") or ".." in key.split("/"):
        raise ValueError("Invalid storage object.")
    return client().bucket(bucket).blob(key)


def signed_url(bucket: str, key: str, *, method="GET", content_type=None, expires=900):
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    credentials.refresh(Request())
    account = os.environ.get("DECKASTRA_GCS_SERVICE_ACCOUNT", "").strip()
    if not account:
        raise ValueError("DECKASTRA_GCS_SERVICE_ACCOUNT is required for IAM signing.")
    return blob(bucket, key).generate_signed_url(
        version="v4", expiration=timedelta(seconds=expires), method=method,
        content_type=content_type, service_account_email=account,
        access_token=credentials.token,
    )


def upload_export(path, *, job_id: str, kind: str, content_type: str) -> str:
    bucket = os.environ["DECKASTRA_GCS_EXPORTS_BUCKET"]
    key = f"exports/{job_id}.{kind}"
    blob(bucket, key).upload_from_filename(str(path), content_type=content_type)
    return f"gs://{bucket}/{key}"


def export_url(reference: str) -> str:
    bucket, separator, key = reference.removeprefix("gs://").partition("/")
    if not reference.startswith("gs://") or not separator or bucket != os.environ.get("DECKASTRA_GCS_EXPORTS_BUCKET"):
        raise ValueError("Invalid export storage reference.")
    item = blob(bucket, key)
    if not item.exists():
        raise FileNotFoundError("The export has expired. Run it again.")
    return signed_url(bucket, key)
