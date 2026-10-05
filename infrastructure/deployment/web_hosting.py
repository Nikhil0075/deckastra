"""Host an explicit frontend build and connect its Cloud Run origin.

No custom domain, OAuth publication or model enablement is implicit.
"""
import argparse
import re
import secrets
from urllib.parse import urlsplit

import httpx

from bootstrap import Cloud
from release_checks import service_snapshot, validate_origins, traffic_argument, verify_and_promote


def ensure_bucket_cors(cloud, origins, kinds=("assets", "exports")):
    for kind in kinds:
        bucket_url = f"https://storage.googleapis.com/storage/v1/b/{cloud.project}-{kind}"
        cors = cloud.rest("GET", bucket_url + "?fields=cors").get("cors", [])
        missing = []
        for origin in origins:
            allowed = {method for row in cors if origin in row.get("origin", []) for method in row.get("method", [])}
            if not {"GET", "HEAD", "PUT"}.issubset(allowed):
                missing.append(origin)
        if missing:
            cloud.rest("PATCH", bucket_url + "?fields=cors", {"cors": [*cors, {
                "origin": missing, "method": ["GET", "HEAD", "PUT"],
                "responseHeader": ["Content-Type", "Content-Length", "Content-Disposition", "ETag"], "maxAgeSeconds": 3600}]})


def configure_access(cloud, web_url):
    origin = validate_origins(web_url)
    if "," in origin or not urlsplit(origin).hostname.endswith(".a.run.app"):
        raise ValueError("Expected the discovered Cloud Run web service URL.")
    previous = service_snapshot(cloud, "deckastra-api")
    if not previous:
        raise RuntimeError("Deploy the backend before hosting the web app.")
    traffic_argument(previous)
    # An operator shell override must not erase deployed origins here.
    env = previous["spec"]["template"]["spec"]["containers"][0].get("env", [])
    old = next((row.get("value") for row in env if row.get("name") == "DECKASTRA_WEB_ORIGINS"), "")
    origins = validate_origins(old + "," + origin) if old else origin
    root = f"https://identitytoolkit.googleapis.com/v2/projects/{cloud.project}/config"
    identity = cloud.rest("GET", root)
    domains = list(dict.fromkeys([*identity.get("authorizedDomains", []), urlsplit(origin).hostname]))
    if domains != identity.get("authorizedDomains", []):
        cloud.rest("PATCH", root + "?updateMask=authorizedDomains", {"authorizedDomains": domains})
    ensure_bucket_cors(cloud, origins.split(","))
    if origin not in old.split(","):
        candidate = "check-" + secrets.token_hex(6)
        container = previous["spec"]["template"]["spec"]["containers"][0]
        cloud.run("run", "deploy", "deckastra-api", f"--region={cloud.region}", f"--image={container['image']}",
                  f"--update-env-vars=^|^DECKASTRA_WEB_ORIGINS={origins}", "--no-traffic", f"--tag={candidate}")
        verify_and_promote(cloud, candidate, previous)
    with httpx.Client(timeout=45) as http:
        response = http.options(previous["status"]["url"] + "/v1/account/credits", headers={"Origin": origin,
            "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
        if response.status_code != 200 or response.headers.get("access-control-allow-origin") != origin:
            raise RuntimeError("Web/API preflight failed.")
    print("Web origin connected to API, private buckets and Identity Platform.", flush=True)


def deploy_web(cloud, tag):
    if not re.fullmatch(r"[a-f0-9]{40}", tag):
        raise ValueError("Use an exact Git commit SHA image tag.")
    previous = service_snapshot(cloud, "deckastra-web")
    restore = traffic_argument(previous) if previous else None
    candidate_tag = "web-check-" + secrets.token_hex(6)
    args = ["--no-traffic"] if previous else []
    promotion_attempted = False
    try:
        cloud.run("run", "deploy", "deckastra-web", f"--region={cloud.region}",
            f"--image={cloud.region}-docker.pkg.dev/{cloud.project}/deckastra/web:{tag}",
            f"--service-account=deckastra-web@{cloud.project}.iam.gserviceaccount.com", "--allow-unauthenticated",
            "--cpu=1", "--memory=512Mi", "--min-instances=0", "--max-instances=2", "--concurrency=20", "--timeout=60",
            "--startup-probe=httpGet.path=/,periodSeconds=5,timeoutSeconds=3,failureThreshold=24", f"--tag={candidate_tag}", *args)
        candidate = service_snapshot(cloud, "deckastra-web")
        row = next(row for row in candidate["status"]["traffic"] if row.get("tag") == candidate_tag)
        with httpx.Client(timeout=45, follow_redirects=False) as http:
            response = http.get(row["url"])
            if response.status_code != 200 or "text/html" not in response.headers.get("content-type", ""):
                raise RuntimeError("Web candidate did not serve HTML.")
        configure_access(cloud, candidate["status"]["url"])
        current = service_snapshot(cloud, "deckastra-web")
        if previous and traffic_argument(current) != restore:
            raise RuntimeError("Web traffic changed during verification; refusing to overwrite it.")
        promotion_attempted = True
        cloud.run("run", "services", "update-traffic", "deckastra-web", f"--region={cloud.region}", f"--to-revisions={row['revisionName']}=100")
        with httpx.Client(timeout=45, follow_redirects=False) as http:
            if http.get(candidate["status"]["url"]).status_code != 200:
                raise RuntimeError("Promoted web service failed.")
        print(candidate["status"]["url"], flush=True)
    except Exception:
        if promotion_attempted and restore:
            cloud.run("run", "services", "update-traffic", "deckastra-web", f"--region={cloud.region}", restore)
        raise
    finally:
        result = cloud.run("run", "services", "update-traffic", "deckastra-web", f"--region={cloud.region}",
                          f"--remove-tags={candidate_tag}", check=False)
        if result.returncode:
            print("WARNING: remove the temporary web candidate tag in Cloud Run.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, choices=("deckastra", "deckastra-prod"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--region", default="asia-south1")
    parser.add_argument("--configuration", default="deckastra")
    args = parser.parse_args()
    deploy_web(Cloud(args.project, args.region, args.configuration), args.tag)
