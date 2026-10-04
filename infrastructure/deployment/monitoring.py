"""Idempotent API uptime and error alerts; no deck text enters these resources."""
import argparse
from urllib.parse import urlparse
from bootstrap import Cloud


def configure(cloud, email):
    root = f"https://monitoring.googleapis.com/v3/projects/{cloud.project}"
    def ensure(collection, field, name, body):
        rows = cloud.rest("GET", root + "/" + collection).get(field, [])
        existing = next((row for row in rows if row.get("displayName") == name), None)
        return existing or cloud.rest("POST", root + "/" + collection, {"displayName": name, **body})
    channel = ensure("notificationChannels", "notificationChannels", "Deckastra operator", {
        "type": "email", "labels": {"email_address": email}, "enabled": True})
    url = cloud.run("run", "services", "describe", "deckastra-api", f"--region={cloud.region}", "--format=value(status.url)").stdout.strip()
    check = ensure("uptimeCheckConfigs", "uptimeCheckConfigs", "Deckastra API readiness", {
        "monitoredResource": {"type": "uptime_url", "labels": {"project_id": cloud.project, "host": urlparse(url).hostname}},
        "httpCheck": {"path": "/ready", "port": 443, "useSsl": True, "validateSsl": True,
                      "acceptedResponseStatusCodes": [{"statusValue": 200}]}, "timeout": "10s", "period": "300s"})
    check_id = check["name"].split("/")[-1]
    ensure("alertPolicies", "alertPolicies", "Deckastra API unavailable", {
        "combiner": "OR", "enabled": True, "notificationChannels": [channel["name"]],
        "conditions": [{"displayName": "Readiness failing for five minutes", "conditionThreshold": {
            "filter": f'resource.type="uptime_url" AND metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND metric.label.check_id="{check_id}"',
            "comparison": "COMPARISON_LT", "thresholdValue": 1, "duration": "300s",
            "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_FRACTION_TRUE"}], "trigger": {"count": 2}}}],
        "alertStrategy": {"autoClose": "1800s"}})
    ensure("alertPolicies", "alertPolicies", "Deckastra API server errors", {
        "combiner": "OR", "enabled": True, "notificationChannels": [channel["name"]],
        "conditions": [{"displayName": "At least five server errors in five minutes", "conditionThreshold": {
            "filter": 'resource.type="cloud_run_revision" AND resource.label.service_name="deckastra-api" AND metric.type="run.googleapis.com/request_count" AND metric.label.response_code_class="5xx"',
            "comparison": "COMPARISON_GT", "thresholdValue": 4, "duration": "0s",
            "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM", "groupByFields": []}],
            "trigger": {"count": 1}}}], "alertStrategy": {"autoClose": "1800s"}})
    if cloud.exists("run", "services", "describe", "deckastra-budget-stop", f"--region={cloud.region}"):
        metric = "deckastra_ai_budget_stop_failure"
        if not cloud.exists("logging", "metrics", "describe", metric):
            cloud.run("logging", "metrics", "create", metric,
                      "--description=Failure to disable an AI API after a billing budget breach",
                      '--log-filter=resource.type="cloud_run_revision" AND resource.labels.service_name="deckastra-budget-stop" '
                      'AND (jsonPayload.event="ai_budget_stop_failed" OR '
                      '(jsonPayload.event="ai_budget_shutdown_complete" AND jsonPayload.success=false))')
        ensure("alertPolicies", "alertPolicies", "Deckastra AI budget shutdown failed", {
            "combiner": "OR", "enabled": True, "notificationChannels": [channel["name"]],
            "conditions": [{"displayName": "AI shutdown reported a failure", "conditionThreshold": {
                "filter": f'resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/{metric}"',
                "comparison": "COMPARISON_GT", "thresholdValue": 0, "duration": "0s",
                "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM"}],
                "trigger": {"count": 1}}}], "alertStrategy": {"autoClose": "1800s"}})
        ensure("alertPolicies", "alertPolicies", "Deckastra AI budget notifications delayed", {
            "combiner": "OR", "enabled": True, "notificationChannels": [channel["name"]],
            "conditions": [{"displayName": "Budget notification unacknowledged for fifteen minutes", "conditionThreshold": {
                "filter": 'resource.type="pubsub_subscription" AND resource.label.subscription_id="deckastra-budget-stop" '
                          'AND metric.type="pubsub.googleapis.com/subscription/oldest_unacked_message_age"',
                "comparison": "COMPARISON_GT", "thresholdValue": 900, "duration": "300s",
                "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_MAX"}],
                "trigger": {"count": 1}}}], "alertStrategy": {"autoClose": "1800s"}})
    cloud.run("services", "enable", "clouderrorreporting.googleapis.com")
    print(f"{cloud.project}: HTTPS readiness check, outage/server-error alerts and Error Reporting enabled.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--email", required=True)
    args = parser.parse_args()
    configure(Cloud(args.project, "asia-south1", "deckastra"), args.email)
