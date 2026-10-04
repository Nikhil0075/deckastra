"""Install approved Google sign-in credentials without logging secrets.

Input files live in ignored state only. The web secret is moved to Secret
Manager and removed locally after both project configurations verify.
"""
import json
from pathlib import Path
from bootstrap import Cloud


def main():
    state = Path(__file__).parent / "state"
    public_path = Path(__file__).parent / "public-auth.json"
    if (state / "oauth-web.json").exists():
        credential = json.loads((state / "oauth-web.json").read_text(encoding="utf-8"))
        desktop = json.loads((state / "oauth-desktop.json").read_text(encoding="utf-8"))["client_id"]
    else:
        saved = json.loads(public_path.read_text(encoding="utf-8"))["deckastra"]
        credential = {"client_id": saved["googleWebClientId"], "client_secret": Cloud("deckastra", "asia-south1", "deckastra").run(
            "secrets", "versions", "access", "latest", "--secret=deckastra-google-web-secret").stdout.strip()}
        desktop = saved["googleDesktopClientId"]
    public = {}
    for project in ("deckastra", "deckastra-prod"):
        cloud = Cloud(project, "asia-south1", "deckastra")
        cloud.secret("deckastra-google-web-secret", credential["client_secret"])
        config = cloud.rest("GET", f"https://identitytoolkit.googleapis.com/v2/projects/{project}/config")
        key = config["client"]["apiKey"]
        endpoint = f"https://identitytoolkit.googleapis.com/v2/projects/{project}/defaultSupportedIdpConfigs"
        provider = {"enabled": True, "clientId": credential["client_id"], "clientSecret": credential["client_secret"]}
        existing = cloud.rest("GET", endpoint).get("defaultSupportedIdpConfigs", [])
        if any(item["name"].endswith("/google.com") for item in existing):
            # Preserve the desktop audience configured through the console.
            cloud.rest("PATCH", endpoint + "/google.com?updateMask=enabled,clientId,clientSecret", provider)
        else:
            cloud.rest("POST", endpoint + "?idpId=google.com", provider)
        verified = cloud.rest("GET", endpoint + "/google.com")
        assert verified["enabled"] and verified["clientId"] == credential["client_id"]
        domains = list(dict.fromkeys([*config.get("authorizedDomains", []), "localhost", "127.0.0.1"]))
        cloud.rest("PATCH", f"https://identitytoolkit.googleapis.com/v2/projects/{project}/config?updateMask=authorizedDomains", {"authorizedDomains": domains})
        public[project] = {"projectId": project, "authDomain": project + ".firebaseapp.com", "apiKey": key,
                          "googleWebClientId": credential["client_id"], "googleDesktopClientId": desktop,
                          "apiUrl": cloud.run("run", "services", "describe", "deckastra-api", "--region=asia-south1", "--format=value(status.url)").stdout.strip()}
        print(project + ": Google provider enabled; public client configured; secret stored in Secret Manager.", flush=True)
    destination = Path(__file__).resolve().parents[2] / "infrastructure/deployment/public-auth.json"
    destination.write_text(json.dumps(public, indent=2), encoding="utf-8")
    # A subsequent run uses Secret Manager, never a checked-in private credential.
    (state / "oauth-web.json").unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # API errors can echo request fields; never print their bodies here.
        print("Identity configuration failed: " + type(error).__name__)
        raise SystemExit(1)
