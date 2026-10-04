"""Private Cloud Run subscriber. IAM authenticates the Pub/Sub push identity."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import re
import time

import google.auth
from google.auth.transport.requests import AuthorizedSession
from policy import SERVICES, decision

EXPECTED = {
    "billingAccountId": os.environ["BILLING_ACCOUNT_ID"],
    "budgetId": os.environ["BUDGET_ID"],
    "schemaVersion": "1.0",
    "displayName": os.environ["BUDGET_NAME"],
    "amount": os.environ["BUDGET_AMOUNT"],
}
PROJECT_NUMBER = os.environ["PROJECT_NUMBER"]
assert PROJECT_NUMBER.isdecimal()
ROOT = "https://serviceusage.googleapis.com/v1/"


def stop_services():
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    errors = []
    with AuthorizedSession(credentials) as http:
        for service in SERVICES:
            try:
                name = f"projects/{PROJECT_NUMBER}/services/{service}"
                state = http.get(ROOT + name, timeout=20)
                state.raise_for_status()
                if state.json()["state"] != "DISABLED":
                    response = http.post(ROOT + name + ":disable", timeout=25,
                                         json={"disableDependentServices": False, "checkIfServiceHasUsage": "SKIP"})
                    response.raise_for_status()
                    operation = response.json()
                    deadline = time.monotonic() + 60
                    while not operation.get("done"):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("operation_pending")
                        operation_name = operation["name"]
                        if not re.fullmatch(r"operations/[A-Za-z0-9._-]+", operation_name):
                            raise RuntimeError("unexpected_operation_name")
                        time.sleep(2)
                        response = http.get(ROOT + operation_name, timeout=20)
                        response.raise_for_status()
                        operation = response.json()
                    if operation.get("error"):
                        raise RuntimeError("disable_operation_failed")
                    state = http.get(ROOT + name, timeout=20)
                    state.raise_for_status()
                    if state.json()["state"] != "DISABLED":
                        raise RuntimeError("disable_not_confirmed")
                print(json.dumps({"event": "ai_budget_service_disabled", "service": service}), flush=True)
            except Exception as error:
                # Never log tokens, full billing messages or response bodies.
                errors.append(service)
                print(json.dumps({"severity": "ERROR", "event": "ai_budget_stop_failed", "service": service,
                                  "error_type": type(error).__name__}), flush=True)
    return not errors


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.reply(200 if self.path == "/ready" else 404)

    def do_POST(self):
        if self.path != "/pubsub":
            return self.reply(404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 20000:
                return self.reply(413)
            envelope = json.loads(self.rfile.read(length))
            outcome = decision(envelope, EXPECTED)
            message_id = str(envelope.get("message", {}).get("messageId", "")) if isinstance(envelope, dict) and isinstance(envelope.get("message"), dict) else ""
            if not re.fullmatch(r"[0-9]{1,128}", message_id):
                message_id = "unknown"
        except (ValueError, TypeError):
            outcome = "invalid"
            message_id = "unknown"
        print(json.dumps({"event": "ai_budget_notification", "decision": outcome, "message_id": message_id}), flush=True)
        success = outcome != "stop" or stop_services()
        if outcome == "stop":
            print(json.dumps({"event": "ai_budget_shutdown_complete", "success": success, "message_id": message_id}), flush=True)
        self.reply(204 if success else 503)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
