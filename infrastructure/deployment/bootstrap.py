"""Provision Deckastra's Google Cloud foundation with explicit project/account.

Secrets stay in Secret Manager. Local state contains resource names only.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError


class Cloud:
    def __init__(self, project, region, configuration):
        self.project, self.region, self.configuration = project, region, configuration

    def run(self, *args, data=None, check=True):
        cmd = ["gcloud", *args, f"--project={self.project}", f"--configuration={self.configuration}", "--quiet"]
        # gcloud is a .cmd on Windows. Resolve its executable shim explicitly.
        import shutil
        cmd[0] = shutil.which("gcloud.cmd") or shutil.which("gcloud") or "gcloud"
        result = subprocess.run(cmd, input=data, capture_output=True, text=True, encoding="utf-8")
        if check and result.returncode:
            # Never include stdout: secret reads and identity tokens travel there.
            raise RuntimeError(f"gcloud {' '.join(args[:3])} failed: {result.stderr[-2000:]}")
        return result

    def exists(self, *args):
        return self.run(*args, check=False).returncode == 0

    def secret(self, name, value):
        if self.exists("secrets", "describe", name):
            return
        self.run("secrets", "create", name, "--replication-policy=automatic", "--data-file=-", data=value)

    def member(self, account, role):
        self.run("projects", "add-iam-policy-binding", self.project, f"--member=serviceAccount:{account}", f"--role={role}", "--condition=None")

    def rest(self, method, url, body=None):
        token = self.run("auth", "print-access-token").stdout.strip()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "X-Goog-User-Project": self.project}
        request = Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            with urlopen(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"{method} {url}: {error.code} {error.read().decode()[:2000]}") from error


def provision(cloud, foundation_only=False, size="small"):
    from release_checks import service_snapshot, deployment_origins, validate_origins
    from web_hosting import ensure_bucket_cors
    project, region = cloud.project, cloud.region
    print(f"Provisioning {project} in {region}", flush=True)
    services = ["run", "artifactregistry", "cloudbuild", "sqladmin", "secretmanager", "iamcredentials", "identitytoolkit",
                "aiplatform", "translate", "texttospeech", "monitoring", "cloudtrace", "telemetry", "billingbudgets", "sts"]
    cloud.run("services", "enable", *(f"{s}.googleapis.com" for s in services))
    deployed_api = service_snapshot(cloud, "deckastra-api")
    web_origins = (deployment_origins(project, deployed_api) if deployed_api else
                   validate_origins(os.environ.get("DECKASTRA_WEB_ORIGINS", "http://localhost:3000")))
    if not cloud.exists("artifacts", "repositories", "describe", "deckastra", f"--location={region}"):
        cloud.run("artifacts", "repositories", "create", "deckastra", f"--location={region}", "--repository-format=docker")
    accounts = {}
    for service in ("api", "export-worker", "migrate", "web", "build"):
        name = f"deckastra-{service}"
        email = f"{name}@{project}.iam.gserviceaccount.com"
        if not cloud.exists("iam", "service-accounts", "describe", email):
            cloud.run("iam", "service-accounts", "create", name, f"--display-name=Deckastra {service}")
        accounts[service] = email
    for service in ("api", "export-worker", "migrate"):
        cloud.member(accounts[service], "roles/cloudsql.client")
        cloud.member(accounts[service], "roles/logging.logWriter")
    for role in ("roles/aiplatform.user", "roles/cloudtranslate.user", "roles/serviceusage.serviceUsageConsumer", "roles/cloudtrace.agent", "roles/telemetry.tracesWriter"):
        cloud.member(accounts["api"], role)
    for role in ("roles/artifactregistry.writer", "roles/logging.logWriter", "roles/serviceusage.serviceUsageConsumer"):
        cloud.member(accounts["build"], role)
    for name, permissions in (("deckastraIdentityCleanup", "firebaseauth.users.delete"),
                              ("deckastraStorageCleanup", "storage.objects.delete,storage.objects.list")):
        if not cloud.exists("iam", "roles", "describe", name):
            cloud.run("iam", "roles", "create", name, f"--title={name}", f"--permissions={permissions}", "--stage=GA")
    # The API takes the worker's background work in the small size (exports,
    # imports, account erasure), so it holds the worker's rights too. Granted in
    # every size, so switching size never needs an IAM change: without them the
    # first small deploy failed its smoke test, unable to save the PDF (2026-10-11).
    for service in ("export-worker", "api"):
        cloud.member(accounts[service], f"projects/{project}/roles/deckastraIdentityCleanup")
    for kind in ("assets", "exports", "packs", "build-source"):
        bucket = f"{project}-{kind}"
        if not cloud.exists("storage", "buckets", "describe", f"gs://{bucket}"):
            cloud.run("storage", "buckets", "create", f"gs://{bucket}", f"--location={region}", "--uniform-bucket-level-access", "--public-access-prevention")
        bindings = []
        if kind == "assets":
            bindings = [(accounts["api"], "roles/storage.objectAdmin"), (accounts["export-worker"], "roles/storage.objectViewer"),
                        (accounts["export-worker"], "roles/storage.objectCreator"),
                        (accounts["export-worker"], f"projects/{project}/roles/deckastraStorageCleanup")]
        elif kind == "exports":
            bindings = [(accounts["api"], "roles/storage.objectAdmin"), (accounts["export-worker"], "roles/storage.objectAdmin")]
        elif kind == "build-source":
            bindings = [(accounts["build"], "roles/storage.objectViewer")]
        elif kind == "packs":
            bindings = [(accounts["api"], "roles/storage.objectViewer"), (accounts["export-worker"], "roles/storage.objectViewer")]
        for email, role in bindings:
            cloud.run("storage", "buckets", "add-iam-policy-binding", f"gs://{bucket}", f"--member=serviceAccount:{email}", f"--role={role}")
        if kind in ("assets", "exports"):
            ensure_bucket_cors(cloud, web_origins.split(","), kinds=(kind,))
        if kind in ("exports", "build-source"):
            with tempfile.TemporaryDirectory() as temporary:
                policy = Path(temporary) / "lifecycle.json"
                policy.write_text(json.dumps({"rule": [{"action": {"type": "Delete"}, "condition": {"age": 30 if kind == "exports" else 5}}]}))
                cloud.run("storage", "buckets", "update", f"gs://{bucket}", f"--lifecycle-file={policy}")
    cloud.run("iam", "service-accounts", "add-iam-policy-binding", accounts["api"],
        f"--member=serviceAccount:{accounts['api']}", "--role=roles/iam.serviceAccountTokenCreator")
    print("Service identities, private buckets and container registry ready", flush=True)
    cloud.secret("deckastra-db-password", secrets.token_urlsafe(32))
    cloud.secret("deckastra-upload-secret", secrets.token_urlsafe(48))
    cloud.secret("deckastra-device-secret", secrets.token_urlsafe(48))
    for name, users in (("deckastra-db-password", ("api", "export-worker", "migrate")),
                        ("deckastra-upload-secret", ("api",)), ("deckastra-device-secret", ("api",))):
        for service in users:
            cloud.run("secrets", "add-iam-policy-binding", name, f"--member=serviceAccount:{accounts[service]}", "--role=roles/secretmanager.secretAccessor")
    instance = "deckastra-postgres"
    if not foundation_only and not cloud.exists("sql", "instances", "describe", instance):
        cloud.run("sql", "instances", "create", instance, "--database-version=POSTGRES_16", f"--region={region}",
            "--edition=ENTERPRISE", f"--tier={SIZES[size]['db_tier']}", "--storage-size=10GB", "--storage-type=SSD",
            "--backup-start-time=20:00", "--enable-point-in-time-recovery", "--retained-backups-count=7", "--async")
    state = {"project": project, "region": region, "instance": instance, "accounts": accounts,
             "connection_name": f"{project}:{region}:{instance}", "ai_enabled": False}
    state_dir = Path(__file__).parent / "state"
    state_dir.mkdir(exist_ok=True)
    (state_dir / f"{project}.json").write_text(json.dumps(state, indent=2))
    print("Foundation ready." if foundation_only else "Cloud SQL creation requested. Run the database step once the instance is RUNNABLE.", flush=True)


def identity(cloud):
    root = f"https://identitytoolkit.googleapis.com/v2/projects/{cloud.project}"
    cloud.rest("POST", f"{root}/identityPlatform:initializeAuth", {})
    config = cloud.rest("GET", f"{root}/config")
    domains = list(dict.fromkeys([*config.get("authorizedDomains", []), "localhost", "127.0.0.1", f"{cloud.project}.firebaseapp.com", f"{cloud.project}.web.app"]))
    cloud.rest("PATCH", f"{root}/config?updateMask=signIn.email,authorizedDomains", {
        "signIn": {"email": {"enabled": True, "passwordRequired": False}}, "authorizedDomains": domains})
    print("Identity Platform initialized; verified email-link sign-in enabled", flush=True)


def database(cloud):
    instance = "deckastra-postgres"
    status = json.loads(cloud.run("sql", "instances", "describe", instance, "--format=json").stdout)
    if status.get("state") != "RUNNABLE":
        raise RuntimeError(f"Cloud SQL is {status.get('state')}; wait for RUNNABLE.")
    if not cloud.exists("sql", "databases", "describe", "deckastra", f"--instance={instance}"):
        cloud.run("sql", "databases", "create", "deckastra", f"--instance={instance}")
    password = cloud.run("secrets", "versions", "access", "latest", "--secret=deckastra-db-password").stdout.strip()
    users = json.loads(cloud.run("sql", "users", "list", f"--instance={instance}", "--format=json").stdout)
    if not any(user["name"] == "deckastra" for user in users):
        cloud.run("sql", "users", "create", "deckastra", f"--instance={instance}", f"--password={password}")
    url = f"postgresql+psycopg://deckastra:{quote(password, safe='')}@/deckastra?host=/cloudsql/{cloud.project}:{cloud.region}:{instance}"
    cloud.secret("deckastra-database-url", url)
    for service in ("api", "export-worker", "migrate"):
        cloud.run("secrets", "add-iam-policy-binding", "deckastra-database-url",
            f"--member=serviceAccount:deckastra-{service}@{cloud.project}.iam.gserviceaccount.com", "--role=roles/secretmanager.secretAccessor")
    print("Database and connection secret ready", flush=True)


# How much is kept running (2026-10-11). "small" is for testing and demos with a
# handful of people: no always-on worker (the API does exports while it is up),
# the smallest database tier, and a US$1 daily cap on paid AI. "scaled" is the
# shape for real traffic: a dedicated worker kept warm and a dedicated-vCPU
# database. Measured on 2026-10-11, the scaled shape costs about INR 9,700 a
# month per environment before anyone uses it; small costs about INR 1,000.
SIZES = {
    "small": {"db_tier": "db-f1-micro", "api_memory": "2Gi", "worker_min": "0", "exports_in_api": "1", "daily_usd": "1",
              # The demo period (2026-10-12): 300 free credits a month, and a
              # dollar a day per account and per request, so one short video
              # clip fits. The global US$1 a day still bounds the whole cloud.
              "free_credits": "300", "account_daily_usd": "1", "request_max_usd": "1.00"},
    "scaled": {"db_tier": "db-custom-1-3840", "api_memory": "1Gi", "worker_min": "1", "exports_in_api": "0", "daily_usd": "10",
               "free_credits": "60", "account_daily_usd": "0.30", "request_max_usd": "0.30"},
}

# Paid media, pinned and priced (approved 2026-10-12). Each model was confirmed
# available in the project and each price read from Google's own pages that
# day. A price set above the list price only over-holds credits; one below it
# would let real spend pass the caps, so when in doubt the number goes up.
MEDIA = {
    # Text-to-Speech, Chirp 3 HD: US$30 per million characters.
    "DECKASTRA_SPEECH": "google",
    "DECKASTRA_SPEECH_USD_PER_MILLION": "30",
    # Gemini 3.1 Flash Lite Image: US$0.25 in, US$30 per million image tokens
    # out, about US$0.034 a picture. The image rate is its own field
    # (`image_output`); text output is held at the same figure, since Google
    # lists only the image rate for this model and the higher number is safe.
    # Gemini 2.5 Flash Image was shut down on 2 Oct 2026.
    "DECKASTRA_VERTEX_IMAGE_MODEL": "gemini-3.1-flash-lite-image",
    "DECKASTRA_VERTEX_PRICES": json.dumps({"gemini-3.1-flash-lite-image": {"input": 0.25, "output": 30, "image_output": 30}}),
    # Veo 3.1 Fast, listed at US$0.08-0.12 a second for 720p-1080p; held at
    # US$0.15. Veo is regional, so it is called in us-central1.
    "DECKASTRA_VERTEX_VIDEO_MODEL": "veo-3.1-fast-generate-001",
    "DECKASTRA_VERTEX_VIDEO_LOCATION": "us-central1",
    "DECKASTRA_VEO_USD_PER_SECOND": "0.15",
}


def deploy(cloud, tag, size="small"):
    project, region = cloud.project, cloud.region
    shape = SIZES[size]
    from release_checks import service_snapshot, deployment_origins, verify_and_promote, traffic_argument, restore_worker
    previous = service_snapshot(cloud, "deckastra-api")
    previous_worker = service_snapshot(cloud, "deckastra-export-worker")
    origins = deployment_origins(project, previous)
    # Validate rollback evidence for both services before any migration: a
    # release that cannot be undone must not start.
    for snapshot in (previous, previous_worker):
        if snapshot:
            traffic_argument(snapshot)
    image = f"{region}-docker.pkg.dev/{project}/deckastra"
    common = [f"--region={region}", f"--set-cloudsql-instances={project}:{region}:deckastra-postgres"]
    cloud.run("run", "jobs", "deploy", "deckastra-migrate", *common, f"--image={image}/migrate:{tag}",
        f"--service-account=deckastra-migrate@{project}.iam.gserviceaccount.com", "--set-secrets=DATABASE_URL=deckastra-database-url:latest", "--max-retries=0", "--task-timeout=600s")
    cloud.run("run", "jobs", "execute", "deckastra-migrate", f"--region={region}", "--wait")
    with tempfile.TemporaryDirectory() as temporary:
        env_file = Path(temporary) / "api-env.json"
        env = {"DECKASTRA_ENV": "production",
            "GOOGLE_CLOUD_PROJECT": project, "DECKASTRA_VERTEX_PROJECT": project, "DECKASTRA_VERTEX_LOCATION": "global",
            "DECKASTRA_GOOGLE_DESKTOP_CLIENT_ID": json.loads((Path(__file__).parent / "public-auth.json").read_text(encoding="utf-8"))[project]["googleDesktopClientId"],
            "DECKASTRA_VERTEX_IDENTITY": "attached", **MEDIA,
            "DECKASTRA_TRANSLATION": "google", "DECKASTRA_TRANSLATION_USD_PER_MILLION": "20",
            "DECKASTRA_ASSISTANT_MAX_COST_USD": shape["request_max_usd"], "DECKASTRA_GLOBAL_DAILY_USD": shape["daily_usd"],
            "DECKASTRA_ACCOUNT_DAILY_USD": shape["account_daily_usd"], "DECKASTRA_DEVICE_DAILY_USD": shape["account_daily_usd"],
            "DECKASTRA_FREE_MONTHLY_CREDITS": shape["free_credits"],
            "DECKASTRA_EXPORTS_IN_API": shape["exports_in_api"],
            "DECKASTRA_CREDITS_ENABLED": "1", "DECKASTRA_ACCOUNT_DELETION_ENABLED": "1", "DECKASTRA_TELEMETRY_GCP": "1", "DECKASTRA_GCS_ASSETS_BUCKET": f"{project}-assets",
            "DECKASTRA_GCS_EXPORTS_BUCKET": f"{project}-exports", "DECKASTRA_GCS_SERVICE_ACCOUNT": f"deckastra-api@{project}.iam.gserviceaccount.com",
            "DECKASTRA_OIDC_ISSUER": f"https://securetoken.google.com/{project}", "DECKASTRA_OIDC_AUDIENCE": project,
            "DECKASTRA_WEB_ORIGINS": origins}
        env_file.write_text(json.dumps(env))
        # Existing service traffic stays on its old revision until readiness succeeds.
        existing = previous is not None
        candidate_tag = "check-" + secrets.token_hex(6)
        args = ["--tag=" + candidate_tag, "--no-traffic"] if existing else ["--tag=" + candidate_tag]
        cloud.run("run", "deploy", "deckastra-api", *common, f"--image={image}/api:{tag}", f"--env-vars-file={env_file}",
            f"--service-account=deckastra-api@{project}.iam.gserviceaccount.com", "--allow-unauthenticated", "--cpu=1", f"--memory={shape['api_memory']}",
            "--min-instances=0", "--max-instances=3", "--concurrency=8", "--timeout=900", "--no-cpu-throttling",
            "--startup-probe=httpGet.path=/ready,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=3,failureThreshold=24",
            "--set-secrets=DATABASE_URL=deckastra-database-url:latest,DECKASTRA_UPLOAD_SECRET=deckastra-upload-secret:latest,DECKASTRA_DEVICE_SECRET=deckastra-device-secret:latest,DECKASTRA_GOOGLE_DESKTOP_SECRET=deckastra-google-desktop-secret:latest", *args)
        worker_env = {key: env[key] for key in ("GOOGLE_CLOUD_PROJECT", "DECKASTRA_GCS_ASSETS_BUCKET", "DECKASTRA_GCS_EXPORTS_BUCKET")}
        worker_env["DECKASTRA_SERVICE"] = "export-worker"
        worker_env.update(DECKASTRA_ENV="production", DECKASTRA_ACCOUNT_DELETION_ENABLED="1", DECKASTRA_VERTEX_IDENTITY="attached")
        worker_file = Path(temporary) / "worker-env.json"
        worker_file.write_text(json.dumps(worker_env))
        # The worker polls the shared queue, so it cannot wait behind a tag: it
        # goes live here and is verified through the candidate API's smoke test.
        # If anything after this point fails, it is put back (restore_worker).
        try:
            cloud.run("run", "deploy", "deckastra-export-worker", *common, f"--image={image}/export-worker:{tag}",
                f"--env-vars-file={worker_file}", f"--service-account=deckastra-export-worker@{project}.iam.gserviceaccount.com",
                "--no-allow-unauthenticated", "--cpu=1", "--memory=2Gi", f"--min-instances={shape['worker_min']}", "--max-instances=1", "--concurrency=1",
                "--no-cpu-throttling", "--liveness-probe=httpGet.path=/health,periodSeconds=30,timeoutSeconds=5,failureThreshold=3",
                "--set-secrets=DATABASE_URL=deckastra-database-url:latest")
        except Exception:
            try:
                restore_worker(cloud, previous_worker)
            finally:
                cloud.run("run", "services", "update-traffic", "deckastra-api", f"--region={region}",
                          f"--remove-tags={candidate_tag}", check=False)
            raise
        verify_and_promote(cloud, candidate_tag, previous, previous_worker)
    print(cloud.run("run", "services", "describe", "deckastra-api", f"--region={region}", "--format=value(status.url)").stdout.strip(), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("provision", "database", "deploy", "identity"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="asia-south1")
    parser.add_argument("--configuration", default="deckastra")
    parser.add_argument("--tag", default="dev")
    parser.add_argument("--foundation-only", action="store_true")
    parser.add_argument("--size", choices=tuple(SIZES), default=os.environ.get("DECKASTRA_HOSTING_SIZE", "small"),
                        help="small: testing and demos; scaled: real traffic. Changing it does not resize an existing database.")
    args = parser.parse_args()
    cloud = Cloud(args.project, args.region, args.configuration)
    if args.action == "provision":
        provision(cloud, args.foundation_only, args.size)
    elif args.action == "database":
        database(cloud)
    elif args.action == "identity":
        identity(cloud)
    else:
        deploy(cloud, args.tag, args.size)
