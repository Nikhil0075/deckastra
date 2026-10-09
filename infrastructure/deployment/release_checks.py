"""Bound releases to a tested revision; never roll a database back implicitly."""
import json
import os
import time
from urllib.parse import urlsplit

import httpx


def service_snapshot(cloud, service):
    result = cloud.run("run", "services", "describe", service, f"--region={cloud.region}", "--format=json", check=False)
    if result.returncode:
        # Permission/network errors must not masquerade as a first deployment.
        if ("NOT_FOUND" in result.stderr or "not found" in result.stderr.lower()
                or f"Cannot find service [{service}]" in result.stderr):
            return None
        raise RuntimeError(f"Cannot inspect existing {service}; deployment stopped.")
    return json.loads(result.stdout)


def validate_origins(value):
    origins = []
    for item in value.split(","):
        item = item.strip().rstrip("/")
        parsed = urlsplit(item)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        try:
            parsed.port
        except ValueError as error:
            raise ValueError("Invalid origin port") from error
        if (any(character.isspace() for character in item) or not parsed.hostname or "\\" in item
                or parsed.username or parsed.password or parsed.path
                or parsed.query or parsed.fragment or "*" in item
                or parsed.scheme not in ({"http", "https"} if local else {"https"})):
            raise ValueError("Origins must be exact HTTPS origins (HTTP allowed for loopback only).")
        if item not in origins:
            origins.append(item)
    if not origins:
        raise ValueError("At least one explicit web origin is required.")
    return ",".join(origins)


def deployment_origins(project, previous):
    explicit = os.environ.get("DECKASTRA_WEB_ORIGINS")
    if explicit is not None:
        return validate_origins(explicit)
    if previous:
        containers = previous.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
        env = containers[0].get("env", []) if containers else []
        value = next((row.get("value") for row in env if row.get("name") == "DECKASTRA_WEB_ORIGINS"), None)
        if value is not None:
            return validate_origins(value)
    if project == "deckastra":
        return "http://localhost:3000"
    raise ValueError("Production origins must be explicit or preserved from the existing service.")


def traffic_argument(snapshot):
    shares = {}
    for row in snapshot["status"]["traffic"]:
        percent = row.get("percent", 0)
        if percent:
            revision = row.get("revisionName")
            if not revision:
                raise ValueError("Previous traffic must resolve to named revisions.")
            shares[revision] = shares.get(revision, 0) + percent
    if sum(shares.values()) != 100:
        raise ValueError("Previous traffic allocation must sum to 100%.")
    return "--to-revisions=" + ",".join(f"{name}={percent}" for name, percent in sorted(shares.items()))


def check_readiness(url):
    # Bounded cold-start retry, no redirect following to a different host.
    with httpx.Client(timeout=30, follow_redirects=False) as http:
        for attempt in range(6):
            try:
                response = http.get(url + "/ready")
                if response.status_code == 200 and response.json().get("status") == "ready":
                    return
            except (httpx.HTTPError, ValueError):
                pass
            if attempt < 5:
                time.sleep(5)
    raise RuntimeError("Release readiness check failed.")


def restore_worker(cloud, previous_worker):
    """Put the export worker back on the revisions it ran before this release.

    The worker cannot be staged behind a tag like the API: it serves no
    requests, it polls the shared queue, so any revision that is running is
    live. It is therefore deployed live and verified through the candidate API,
    and a failed release has to take it back explicitly. Before this existed a
    failed release left a new worker beside the old API (2026-10-09).
    """
    if not previous_worker:
        print("WARNING: first worker deployment failed verification; there is no previous revision to restore.", flush=True)
        return
    cloud.run("run", "services", "update-traffic", "deckastra-export-worker", f"--region={cloud.region}",
              traffic_argument(previous_worker))


def verify_and_promote(cloud, candidate_tag, previous, previous_worker=None):
    """Verify the API candidate against the new worker, then promote; on failure undo both.

    The smoke test's export is processed by the worker this release deployed,
    which is the point: a worker fix must be able to ship even when the
    previous worker is the thing that is broken, so verifying against the old
    worker would deadlock exactly the release that repairs it.
    """
    from smoke_cloud import run_smoke
    restore = traffic_argument(previous) if previous else None
    promotion_attempted = False
    try:
        candidate = service_snapshot(cloud, "deckastra-api")
        row = next((row for row in candidate["status"]["traffic"] if row.get("tag") == candidate_tag), None)
        if not row or not row.get("url") or not row.get("revisionName"):
            raise RuntimeError("Candidate revision/tag URL not found; traffic remains unchanged.")
        url = row["url"]
        check_readiness(url)
        run_smoke(cloud, url=url)
        current = service_snapshot(cloud, "deckastra-api")
        if previous and traffic_argument(current) != restore:
            raise RuntimeError("Serving traffic changed during verification; refusing to overwrite it.")
        promotion_attempted = True
        cloud.run("run", "services", "update-traffic", "deckastra-api", f"--region={cloud.region}",
                  f"--to-revisions={row['revisionName']}=100")
        check_readiness(candidate["status"]["url"])
    except Exception:
        try:
            if promotion_attempted and restore:
                cloud.run("run", "services", "update-traffic", "deckastra-api", f"--region={cloud.region}", restore)
        finally:
            # Whatever happened to the API, the worker returns with it: a
            # release is both services or neither.
            restore_worker(cloud, previous_worker)
        raise
    finally:
        result = cloud.run("run", "services", "update-traffic", "deckastra-api", f"--region={cloud.region}",
                           f"--remove-tags={candidate_tag}", check=False)
        if result.returncode:
            print("WARNING: temporary candidate tag cleanup failed; remove it in Cloud Run.", flush=True)
