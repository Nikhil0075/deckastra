"""Create keyless CI trust, bound to immutable repository and owner IDs."""
import argparse
import json
from urllib.request import Request, urlopen
from bootstrap import Cloud


def configure(cloud, repository):
    with urlopen(Request(f"https://api.github.com/repos/{repository}", headers={"Accept": "application/vnd.github+json", "User-Agent": "Deckastra-deployment"})) as response:
        repo = json.load(response)
    repo_id, owner_id = str(repo["id"]), str(repo["owner"]["id"])
    number = cloud.run("projects", "describe", cloud.project, "--format=value(projectNumber)").stdout.strip()
    pool = "deckastra-github"
    if not cloud.exists("iam", "workload-identity-pools", "describe", pool, "--location=global"):
        cloud.run("iam", "workload-identity-pools", "create", pool, "--location=global", "--display-name=Deckastra GitHub")
    condition = f"assertion.repository_id == '{repo_id}' && assertion.repository_owner_id == '{owner_id}' && assertion.ref == 'refs/heads/main'"
    mapping = "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref"
    provider = "github"
    if not cloud.exists("iam", "workload-identity-pools", "providers", "describe", provider, f"--workload-identity-pool={pool}", "--location=global"):
        cloud.run("iam", "workload-identity-pools", "providers", "create-oidc", provider, "--location=global", f"--workload-identity-pool={pool}",
            "--issuer-uri=https://token.actions.githubusercontent.com", f"--attribute-mapping={mapping}", f"--attribute-condition={condition}")
    name = "deckastra-deploy"
    email = f"{name}@{cloud.project}.iam.gserviceaccount.com"
    if not cloud.exists("iam", "service-accounts", "describe", email):
        cloud.run("iam", "service-accounts", "create", name)
    cloud.run("iam", "service-accounts", "add-iam-policy-binding", email,
        f"--member=principalSet://iam.googleapis.com/projects/{number}/locations/global/workloadIdentityPools/{pool}/attribute.repository_id/{repo_id}",
        "--role=roles/iam.workloadIdentityUser")
    for role in ("roles/run.admin", "roles/cloudbuild.builds.editor", "roles/serviceusage.serviceUsageConsumer"):
        cloud.member(email, role)
    for service in ("api", "web", "export-worker", "migrate", "build"):
        cloud.run("iam", "service-accounts", "add-iam-policy-binding", f"deckastra-{service}@{cloud.project}.iam.gserviceaccount.com",
            f"--member=serviceAccount:{email}", "--role=roles/iam.serviceAccountUser")
    cloud.run("storage", "buckets", "add-iam-policy-binding", f"gs://{cloud.project}-build-source", f"--member=serviceAccount:{email}", "--role=roles/storage.objectAdmin")
    # gcloud verifies bucket metadata before uploading source; object permissions
    # alone do not include storage.buckets.get. Scope this to the source bucket.
    cloud.run("storage", "buckets", "add-iam-policy-binding", f"gs://{cloud.project}-build-source", f"--member=serviceAccount:{email}", "--role=roles/storage.legacyBucketReader")
    cloud.run("artifacts", "repositories", "add-iam-policy-binding", "deckastra", f"--location={cloud.region}",
        f"--member=serviceAccount:{email}", "--role=roles/artifactregistry.reader")
    print(json.dumps({"repository": repository, "repository_id": repo_id, "project_number": number,
        "provider": f"projects/{number}/locations/global/workloadIdentityPools/{pool}/providers/{provider}", "service_account": email}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    configure(Cloud(args.project, "asia-south1", "deckastra"), args.repository)
