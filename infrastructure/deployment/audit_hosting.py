"""Read-only hosting checks. Output contains resource names, never credentials."""
import argparse
import json
from pathlib import Path

import httpx

from bootstrap import Cloud
from release_checks import service_snapshot, validate_origins


def audit(cloud):
    report = {"project": cloud.project, "checks": [], "launch_pending": [
        "Finished frontend and installed desktop acceptance",
        "Published privacy/terms and Google OAuth production consent",
        "Approved paid-media model and budget (image generation remains disabled)",
    ]}
    def record(name, ok, details):
        report["checks"].append({"name": name, "ok": bool(ok), "details": details})
    api = service_snapshot(cloud, "deckastra-api")
    worker = service_snapshot(cloud, "deckastra-export-worker")
    web = service_snapshot(cloud, "deckastra-web")
    if not api:
        record("api", False, "Missing")
        return report
    url = api["status"]["url"]
    env = {row["name"]: row.get("value") for row in api["spec"]["template"]["spec"]["containers"][0].get("env", [])}
    origins = validate_origins(env.get("DECKASTRA_WEB_ORIGINS", "")).split(",")
    record("ai_disabled", not env.get("DECKASTRA_VERTEX_IMAGE_MODEL", "").strip(), "No paid media calls made")
    record("verified_cloud_auth", env.get("DECKASTRA_ENV") == "production" and env.get("DECKASTRA_OIDC_AUDIENCE") == cloud.project
           and env.get("DECKASTRA_CREDITS_ENABLED") == "1" and env.get("DECKASTRA_ACCOUNT_DELETION_ENABLED") == "1", "Identity, credits and deletion configured")
    record("worker_ready", bool(worker and worker["status"].get("latestReadyRevisionName")), "Private worker revision present" if worker else "Missing")
    with httpx.Client(timeout=45, follow_redirects=False) as http:
        response = http.get(url + "/ready")
        record("api_ready", response.status_code == 200 and response.json().get("status") == "ready", url)
        record("anonymous_denied", http.get(url + "/v1/account/credits").status_code == 401, "Credits require a verified identity")
        for origin in origins:
            response = http.options(url + "/v1/account/credits", headers={"Origin": origin,
                "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
            record("api_cors", response.status_code == 200 and response.headers.get("access-control-allow-origin") == origin, origin)
        response = http.options(url + "/v1/account/credits", headers={"Origin": "https://untrusted.invalid", "Access-Control-Request-Method": "GET"})
        record("untrusted_origin_denied", "access-control-allow-origin" not in response.headers, "Unlisted browser origins refused")
        if web:
            web_url = web["status"]["url"]
            record("web_http", http.get(web_url).status_code == 200, web_url)
            record("web_api_origin", web_url in origins, "Web service URL is allowed by API")
        else:
            report["launch_pending"].append("Web service not deployed")
    sql = json.loads(cloud.run("sql", "instances", "describe", "deckastra-postgres", "--format=json").stdout)
    backups = sql.get("settings", {}).get("backupConfiguration", {})
    record("database_backups", sql.get("state") == "RUNNABLE" and backups.get("enabled") and backups.get("pointInTimeRecoveryEnabled")
           and backups.get("backupRetentionSettings", {}).get("retainedBackups", 0) >= 7, "SQL runnable; backups/PITR and seven retained backups")
    identity = cloud.rest("GET", f"https://identitytoolkit.googleapis.com/v2/projects/{cloud.project}/config")
    if web:
        from urllib.parse import urlsplit
        record("web_auth_domain", urlsplit(web["status"]["url"]).hostname in identity.get("authorizedDomains", []), "Identity Platform authorizes web hostname")
    for kind in ("assets", "exports"):
        bucket = json.loads(cloud.run("storage", "buckets", "describe", f"gs://{cloud.project}-{kind}", "--format=json").stdout)
        record(f"private_{kind}", bucket.get("public_access_prevention") == "enforced" and bucket.get("uniform_bucket_level_access"), "Public access prevention; uniform bucket access")
        cors = cloud.rest("GET", f"https://storage.googleapis.com/storage/v1/b/{cloud.project}-{kind}?fields=cors").get("cors", [])
        for origin in origins:
            methods = {method for row in cors if origin in row.get("origin", []) for method in row.get("method", [])}
            record(f"{kind}_cors", {"GET", "HEAD", "PUT"}.issubset(methods), origin)
            with httpx.Client(timeout=30) as http:
                response = http.options(f"https://storage.googleapis.com/{cloud.project}-{kind}/hosting-cors-check", headers={
                    "Origin": origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type"})
                record(f"{kind}_browser_preflight", response.status_code == 200 and response.headers.get("access-control-allow-origin") == origin,
                       "Real XML endpoint preflight; no object uploaded")
    root = f"https://monitoring.googleapis.com/v3/projects/{cloud.project}"
    channels = cloud.rest("GET", root + "/notificationChannels").get("notificationChannels", [])
    operator = next((row for row in channels if row.get("displayName") == "Deckastra operator"), {})
    verified = operator.get("enabled") and operator.get("verificationStatus") == "VERIFIED"
    record("operator_alert_channel", operator.get("enabled"), "Operator email channel enabled")
    record("operator_alert_delivery", verified, operator.get("verificationStatus", "UNSPECIFIED") if operator else "missing channel")
    if not verified:
        report["launch_pending"].append("Operator alert receipt not demonstrated; unspecified verification status does not prove email needs verification")
    report["backend_checks_passed"] = all(row["ok"] for row in report["checks"] if row["name"] != "operator_alert_delivery")
    report["launch_ready"] = report["backend_checks_passed"] and not report["launch_pending"]
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, choices=("deckastra", "deckastra-prod"))
    parser.add_argument("--region", default="asia-south1")
    parser.add_argument("--configuration", default="deckastra")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = audit(Cloud(args.project, args.region, args.configuration))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report.get("backend_checks_passed") else 1)
