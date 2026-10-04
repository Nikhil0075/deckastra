"""Wire each existing monthly budget to a private, fail-closed AI shutdown.

This responds to reported billing; it is not a real-time monetary ceiling.
Only the owner can re-enable the AI APIs after resolving the breach.
"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

from bootstrap import Cloud

SOURCE = Path(__file__).parent / "budget-stop"


def list_budgets(cloud, root):
    budgets, token = [], ""
    while True:
        data = cloud.rest("GET", root + "?scope=" + quote("projects/" + cloud.project, safe="")
                          + "&pageSize=100" + ("&pageToken=" + quote(token, safe="") if token else ""))
        budgets.extend(data.get("budgets", []))
        token = data.get("nextPageToken", "")
        if not token:
            return budgets


def configure(cloud, billing_account, configure_native_cap=False):
    number = cloud.run("projects", "describe", cloud.project, "--format=value(projectNumber)").stdout.strip()
    root = f"https://billingbudgets.googleapis.com/v1/billingAccounts/{billing_account}/budgets"
    budgets = list_budgets(cloud, root)
    matching = [b for b in budgets if b.get("budgetFilter", {}).get("projects") == [f"projects/{number}"]
                and b.get("budgetFilter", {}).get("calendarPeriod") == "MONTH"
                and not b.get("spendCap") and not b.get("budgetFilter", {}).get("services")]
    if len(matching) != 1:
        raise RuntimeError("Expected exactly one existing project-scoped monthly budget.")
    budget = matching[0]
    amount = budget["amount"]["specifiedAmount"]
    if amount["currencyCode"] != "INR" or amount["units"] != "5000" or amount.get("nanos", 0):
        raise RuntimeError("Expected the existing INR 5000 monthly budget; no amount is changed.")
    budget_id = budget["name"].split("/")[-1]
    # The evaluated model lacks fixed quota. Google's native spend cap is a
    # separate provider-enforced stop on gross Vertex usage (Preview).
    vertex_service = "services/C7E2-9256-1C43"
    cap_name = f"{cloud.project}-vertex-spend-cap"
    cap = next((b for b in budgets if b.get("displayName") == cap_name), None)
    if cap is None and configure_native_cap:
        cap = cloud.rest("POST", root, {
            "displayName": cap_name,
            "budgetFilter": {"projects": [f"projects/{number}"], "services": [vertex_service],
                             "calendarPeriod": "MONTH", "creditTypesTreatment": "EXCLUDE_ALL_CREDITS"},
            "amount": {"specifiedAmount": {"currencyCode": "INR", "units": "5000"}},
            "thresholdRules": [{"thresholdPercent": percentage, "spendBasis": "CURRENT_SPEND"}
                               for percentage in (0.5, 0.8, 1.0)],
            "notificationsRule": {"enableProjectLevelRecipients": True, "disableDefaultIamRecipients": False},
            "spendCap": {"inputState": "CONFIGURED"},
        })
    # Preview cap readbacks are inconsistent across GET/ListBudgets/SDK.
    # Check the canonical response when available and verify the Console.
    # A subscriber redeploy never recreates, lifts or changes a native cap.
    if cap is not None and (cap.get("budgetFilter", {}).get("projects") != [f"projects/{number}"]
            or cap.get("budgetFilter", {}).get("services") != [vertex_service]
            or cap.get("spendCap", {}).get("outputState") not in ("CONFIGURED", "ENFORCED")
            or cap.get("amount", {}).get("specifiedAmount") != {"currencyCode": "INR", "units": "5000"}):
        raise RuntimeError("Native Vertex spend cap does not match the expected active configuration.")
    if cap is not None:
        print(f"{cloud.project}: native INR 5000 gross Vertex monthly cap {cap['spendCap']['outputState']}; confirm in Console", flush=True)
    else:
        print(f"{cloud.project}: native cap not returned by Preview API; verify existing cap in Console", flush=True)
    cloud.run("services", "enable", "pubsub.googleapis.com", "apikeys.googleapis.com")
    runtime = f"deckastra-budget-stop@{cloud.project}.iam.gserviceaccount.com"
    invoker = f"deckastra-budget-push@{cloud.project}.iam.gserviceaccount.com"
    for name, email in (("deckastra-budget-stop", runtime), ("deckastra-budget-push", invoker)):
        if not cloud.exists("iam", "service-accounts", "describe", email):
            cloud.run("iam", "service-accounts", "create", name)
    role = "deckastraAiBudgetStop"
    permissions = "serviceusage.services.disable,serviceusage.services.get,serviceusage.operations.get"
    if not cloud.exists("iam", "roles", "describe", role):
        cloud.run("iam", "roles", "create", role, "--title=Deckastra AI budget shutdown",
                  f"--permissions={permissions}", "--stage=GA")
    cloud.member(runtime, f"projects/{cloud.project}/roles/{role}")
    cloud.member(runtime, "roles/serviceusage.serviceUsageConsumer")
    cloud.member(runtime, "roles/logging.logWriter")
    topic = "deckastra-budget-stop"
    topic_name = f"projects/{cloud.project}/topics/{topic}"
    if not cloud.exists("pubsub", "topics", "describe", topic):
        cloud.run("pubsub", "topics", "create", topic)
    cloud.run("pubsub", "topics", "add-iam-policy-binding", topic,
              "--member=serviceAccount:billing-budget-alert@system.gserviceaccount.com", "--role=roles/pubsub.publisher")
    tag = hashlib.sha256(b"".join((SOURCE / name).read_bytes() for name in
                                ("Dockerfile", "requirements.txt", "policy.py", "server.py"))).hexdigest()[:16]
    image = f"{cloud.region}-docker.pkg.dev/{cloud.project}/deckastra/budget-stop:{tag}"
    if not cloud.exists("artifacts", "docker", "images", "describe", image):
        print(f"{cloud.project}: building isolated budget-stop image {tag}", flush=True)
        cloud.run("builds", "submit", str(SOURCE), f"--config={SOURCE / 'cloudbuild.yaml'}",
                  f"--substitutions=_REGION={cloud.region},_TAG={tag}", "--suppress-logs",
                  f"--service-account=projects/{cloud.project}/serviceAccounts/deckastra-build@{cloud.project}.iam.gserviceaccount.com",
                  f"--gcs-source-staging-dir=gs://{cloud.project}-build-source/budget-stop")
    service = "deckastra-budget-stop"
    settings = {"PROJECT_NUMBER": number, "BILLING_ACCOUNT_ID": billing_account, "BUDGET_ID": budget_id,
                "BUDGET_NAME": budget["displayName"], "BUDGET_AMOUNT": "5000"}
    cloud.run("run", "deploy", service, f"--region={cloud.region}", f"--image={image}",
              f"--service-account={runtime}", "--no-allow-unauthenticated", "--min-instances=0", "--max-instances=1",
              "--concurrency=1", "--cpu=1", "--memory=256Mi", "--timeout=300s",
              "--set-env-vars=" + ",".join(f"{key}={value}" for key, value in settings.items()))
    cloud.run("run", "services", "add-iam-policy-binding", service, f"--region={cloud.region}",
              f"--member=serviceAccount:{invoker}", "--role=roles/run.invoker")
    cloud.run("iam", "service-accounts", "add-iam-policy-binding", invoker,
              f"--member=serviceAccount:service-{number}@gcp-sa-pubsub.iam.gserviceaccount.com",
              "--role=roles/iam.serviceAccountTokenCreator")
    url = cloud.run("run", "services", "describe", service, f"--region={cloud.region}", "--format=value(status.url)").stdout.strip()
    subscription = "deckastra-budget-stop"
    if not cloud.exists("pubsub", "subscriptions", "describe", subscription):
        cloud.run("pubsub", "subscriptions", "create", subscription, f"--topic={topic}", "--ack-deadline=300",
                  "--expiration-period=never", "--min-retry-delay=10s", "--max-retry-delay=600s",
                  f"--push-endpoint={url}/pubsub", f"--push-auth-service-account={invoker}", f"--push-auth-token-audience={url}")
    else:
        cloud.run("pubsub", "subscriptions", "modify-push-config", subscription,
                  f"--push-endpoint={url}/pubsub", f"--push-auth-service-account={invoker}", f"--push-auth-token-audience={url}")
    # Preserve thresholds, filters, credit treatment, recipients and the amount.
    cloud.rest("PATCH", "https://billingbudgets.googleapis.com/v1/" + budget["name"] + "?updateMask=notificationsRule",
               {"name": budget["name"], "etag": budget["etag"], "notificationsRule":
                {**budget.get("notificationsRule", {}), "pubsubTopic": topic_name, "schemaVersion": "1.0"}})
    # Public auth keys can call only the two Auth APIs, never Firebase AI.
    keys = json.loads(cloud.run("services", "api-keys", "list", "--format=json(name,displayName)").stdout)
    for key in keys:
        if key.get("displayName") != "Browser key (auto created by Firebase)":
            continue
        cloud.run("services", "api-keys", "update", key["name"],
                  "--api-target=service=identitytoolkit.googleapis.com", "--api-target=service=securetoken.googleapis.com")
    print(f"{cloud.project}: private budget subscriber ready; reported INR 5000 breach disables Vertex, Translation and TTS.", flush=True)
    return {"project": cloud.project, "budget": budget["name"], "vertex_spend_cap": cap["name"] if cap else None, "image": image, "url": url}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--billing-account", required=True)
    parser.add_argument("--configure-native-cap", action="store_true", help="Create a missing native Vertex cap during initial setup; verify it in Console.")
    args = parser.parse_args()
    configure(Cloud(args.project, "asia-south1", "deckastra"), args.billing_account, args.configure_native_cap)
