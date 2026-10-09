"""Exercise authenticated delivery and real AI shutdown while tasks are disabled.

Uses an isolated temporary topic/subscription, removes both before restoring
only APIs which were enabled at the start. Never sends an inference request.
"""
import argparse
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid

import httpx
from bootstrap import Cloud

SERVICES = ("aiplatform.googleapis.com", "translate.googleapis.com", "texttospeech.googleapis.com")


def verify(cloud):
    api = json.loads(cloud.run("run", "services", "describe", "deckastra-api", f"--region={cloud.region}", "--format=json").stdout)
    env = {entry["name"]: entry.get("value") for entry in api["spec"]["template"]["spec"]["containers"][0]["env"]}
    if env.get("DECKASTRA_VERTEX_IMAGE_MODEL", "").strip():
        raise RuntimeError("Refusing shutdown rehearsal with image generation enabled.")
    subscriber = json.loads(cloud.run("run", "services", "describe", "deckastra-budget-stop", f"--region={cloud.region}", "--format=json").stdout)
    settings = {entry["name"]: entry.get("value") for entry in subscriber["spec"]["template"]["spec"]["containers"][0]["env"]}
    with httpx.Client(timeout=40) as http:
        assert http.get(subscriber["status"]["url"] + "/ready").status_code in (401, 403)
    number = settings["PROJECT_NUMBER"]
    root = "https://serviceusage.googleapis.com/v1/projects/" + number + "/services/"
    initial = {service: cloud.rest("GET", root + service)["state"] for service in SERVICES}
    assert set(initial.values()) == {"ENABLED"}, "Rehearse only when all AI APIs are initially enabled."
    suffix = uuid.uuid4().hex[:12]
    topic, subscription = "deckastra-budget-test-" + suffix, "deckastra-budget-test-" + suffix
    invoker = f"deckastra-budget-push@{cloud.project}.iam.gserviceaccount.com"
    url = subscriber["status"]["url"]
    baseline = datetime.now(timezone.utc).isoformat()
    created_topic = created_subscription = False
    evidence = {"project": cloud.project, "started_at": baseline, "public_access": "denied"}
    try:
        cloud.run("pubsub", "topics", "create", topic)
        created_topic = True
        cloud.run("pubsub", "subscriptions", "create", subscription, f"--topic={topic}", "--ack-deadline=300",
                  f"--push-endpoint={url}/pubsub", f"--push-auth-service-account={invoker}", f"--push-auth-token-audience={url}")
        created_subscription = True

        def publish(cost):
            current = datetime.now(timezone.utc)
            data = {"budgetDisplayName": settings["BUDGET_NAME"], "currencyCode": "INR",
                    "budgetAmountType": "SPECIFIED_AMOUNT", "costIntervalStart": current.strftime("%Y-%m-01T00:00:00Z"),
                    "budgetAmount": 5000, "costAmount": cost, "forecastThresholdExceeded": 1.2}
            message = {"data": base64.b64encode(json.dumps(data).encode()).decode(), "attributes": {
                "billingAccountId": settings["BILLING_ACCOUNT_ID"], "budgetId": settings["BUDGET_ID"], "schemaVersion": "1.0"}}
            result = cloud.rest("POST", f"https://pubsub.googleapis.com/v1/projects/{cloud.project}/topics/{topic}:publish", {"messages": [message]})
            return result["messageIds"][0]

        def wait_log(message_id, event, extra=""):
            deadline = time.monotonic() + 240
            query = (f'resource.type="cloud_run_revision" AND resource.labels.service_name="deckastra-budget-stop" '
                     f'AND timestamp>="{baseline}" AND jsonPayload.message_id="{message_id}" AND jsonPayload.event="{event}" {extra}')
            while time.monotonic() < deadline:
                rows = json.loads(cloud.run("logging", "read", query, "--limit=1", "--format=json(jsonPayload)").stdout)
                if rows:
                    return rows[0]["jsonPayload"]
                time.sleep(5)
            raise RuntimeError(f"No authenticated subscriber confirmation for {event}.")

        under_id = publish(4999.99)
        under = wait_log(under_id, "ai_budget_notification")
        assert under["decision"] == "below"
        assert all(cloud.rest("GET", root + service)["state"] == "ENABLED" for service in SERVICES)
        print(cloud.project, "PASS: forecast-only/below-budget notification leaves all AI APIs enabled", flush=True)
        stop_id = publish(5000.01)
        assert wait_log(stop_id, "ai_budget_shutdown_complete")["success"] is True
        assert all(cloud.rest("GET", root + service)["state"] == "DISABLED" for service in SERVICES)
        with httpx.Client(timeout=40) as http:
            assert http.get(api["status"]["url"] + "/ready").status_code == 200
        evidence["real_shutdown"] = "Vertex, Translation and TTS DISABLED; API ready"
        duplicate_id = publish(5000.01)
        assert wait_log(duplicate_id, "ai_budget_shutdown_complete")["success"] is True
        evidence["duplicate_delivery"] = "idempotent"
        print(cloud.project, "PASS: authenticated Pub/Sub disabled all three real AI APIs; duplicate delivery succeeds", flush=True)
    finally:
        # Delete the isolated subscription before re-enabling: a delayed test
        # retry must never turn off an API after the rehearsal finishes.
        if created_subscription:
            cloud.run("pubsub", "subscriptions", "delete", subscription)
        if created_topic:
            cloud.run("pubsub", "topics", "delete", topic)
        cloud.run("services", "enable", *(service for service, state in initial.items() if state == "ENABLED"))
        assert all(cloud.rest("GET", root + service)["state"] == state for service, state in initial.items())
        print(cloud.project, "PASS: temporary test delivery removed and original API states restored", flush=True)
    evidence["restored"] = True
    state_dir = Path(__file__).parent / "state"
    state_dir.mkdir(exist_ok=True)
    (state_dir / f"budget-stop-rehearsal-{cloud.project}.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--exercise-shutdown", required=True, action="store_true", help="Temporarily disable and restore the three AI APIs.")
    args = parser.parse_args()
    verify(Cloud(args.project, "asia-south1", "deckastra"))
