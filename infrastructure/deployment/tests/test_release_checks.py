import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

spec = importlib.util.spec_from_file_location("release_checks", Path(__file__).parents[1] / "release_checks.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def snapshot(traffic=None, origins="https://app.deckastra.test"):
    return {"spec": {"template": {"spec": {"containers": [{"env": [
        {"name": "DECKASTRA_WEB_ORIGINS", "value": origins}]}]}}}, "status": {
        "url": "https://api.test", "traffic": traffic or [{"revisionName": "api-old", "percent": 100, "latestRevision": True}]}}


@pytest.fixture
def cloud(monkeypatch):
    class Cloud:
        project, region = "deckastra", "asia-south1"
        def __init__(self):
            self.calls = []
            self.current = snapshot()
            self.current["status"]["traffic"].append({"revisionName": "api-candidate", "tag": "check-123", "url": "https://candidate.test"})
        def run(self, *args, **kwargs):
            self.calls.append(args)
            if args[:3] == ("run", "services", "describe"):
                return SimpleNamespace(returncode=0, stdout=json.dumps(self.current), stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
    monkeypatch.setitem(sys.modules, "smoke_cloud", SimpleNamespace(run_smoke=lambda *_, **__: None))
    monkeypatch.setattr(release, "check_readiness", lambda _: None)
    return Cloud()


def test_existing_origins_survive_ci_without_environment_override(monkeypatch):
    monkeypatch.delenv("DECKASTRA_WEB_ORIGINS", raising=False)
    assert release.deployment_origins("deckastra-prod", snapshot()) == "https://app.deckastra.test"
    with pytest.raises(ValueError):
        release.deployment_origins("deckastra-prod", None)


def test_explicit_origins_normalized_without_wildcard(monkeypatch):
    monkeypatch.setenv("DECKASTRA_WEB_ORIGINS", "https://web.run.app/,http://localhost:3000,https://web.run.app")
    assert release.deployment_origins("deckastra", snapshot()) == "https://web.run.app,http://localhost:3000"


@pytest.mark.parametrize("origin", ["", "*", "https://*.test", "http://public.test", "https://user:secret@web.test",
    "https://web.test/path", "https://web.test?x=1", "https://web.test#part", "https://web.test:bad",
    "https://web.\ntest", "https://web.test\\evil", "https://web.test,"])
def test_unsafe_browser_origin_fails_closed(origin):
    with pytest.raises(ValueError):
        release.validate_origins(origin)


def test_rollback_retains_split_and_resolves_latest_to_named_revision():
    previous = snapshot([{"revisionName": "api-a", "percent": 25, "latestRevision": True},
                         {"revisionName": "api-b", "percent": 75}, {"revisionName": "api-c", "percent": 0, "tag": "old-check"}])
    assert release.traffic_argument(previous) == "--to-revisions=api-a=25,api-b=75"


@pytest.mark.parametrize("traffic", [[{"latestRevision": True, "percent": 100}], [{"revisionName": "api-a", "percent": 20}]])
def test_incomplete_rollback_evidence_refused(traffic):
    with pytest.raises(ValueError):
        release.traffic_argument(snapshot(traffic))


def test_success_checks_candidate_before_promoting_that_named_revision(cloud, monkeypatch):
    seen = []
    monkeypatch.setattr(release, "check_readiness", lambda url: seen.append(url))
    monkeypatch.setattr(sys.modules["smoke_cloud"], "run_smoke", lambda _, url: seen.append("smoke:" + url))
    release.verify_and_promote(cloud, "check-123", snapshot())
    assert seen == ["https://candidate.test", "smoke:https://candidate.test", "https://api.test"]
    assert any("--to-revisions=api-candidate=100" in call for call in cloud.calls)
    assert not any("--to-latest" in call for call in cloud.calls)
    assert "--remove-tags=check-123" in cloud.calls[-1]


def test_export_or_auth_failure_never_promotes(cloud, monkeypatch):
    def fail(*_, **__): raise RuntimeError("export failed")
    monkeypatch.setattr(sys.modules["smoke_cloud"], "run_smoke", fail)
    with pytest.raises(RuntimeError, match="export failed"):
        release.verify_and_promote(cloud, "check-123", snapshot())
    assert not any(any(arg.startswith("--to-revisions=") for arg in call) for call in cloud.calls)
    assert "--remove-tags=check-123" in cloud.calls[-1]


def test_live_readiness_failure_restores_previous_traffic(cloud, monkeypatch):
    def check(url):
        if url == "https://api.test": raise RuntimeError("live failed")
    monkeypatch.setattr(release, "check_readiness", check)
    with pytest.raises(RuntimeError, match="live failed"):
        release.verify_and_promote(cloud, "check-123", snapshot())
    assert any("--to-revisions=api-old=100" in call for call in cloud.calls)


def test_ambiguous_promotion_command_failure_also_restores(cloud, monkeypatch):
    original = cloud.run
    def run(*args, **kwargs):
        result = original(*args, **kwargs)
        if "--to-revisions=api-candidate=100" in args: raise RuntimeError("promotion interrupted")
        return result
    monkeypatch.setattr(cloud, "run", run)
    with pytest.raises(RuntimeError, match="promotion interrupted"):
        release.verify_and_promote(cloud, "check-123", snapshot())
    assert any("--to-revisions=api-old=100" in call for call in cloud.calls)


def test_parallel_operator_traffic_change_is_not_overwritten(cloud, monkeypatch):
    def change(*_, **__): cloud.current["status"]["traffic"][0]["revisionName"] = "operator-revision"
    monkeypatch.setattr(sys.modules["smoke_cloud"], "run_smoke", change)
    with pytest.raises(RuntimeError, match="changed during verification"):
        release.verify_and_promote(cloud, "check-123", snapshot())
    assert not any(any(arg.startswith("--to-revisions=") for arg in call) for call in cloud.calls)


def test_permission_failure_is_not_a_first_deployment(cloud, monkeypatch):
    monkeypatch.setattr(cloud, "run", lambda *_, **__: SimpleNamespace(returncode=1, stderr="PERMISSION_DENIED", stdout=""))
    with pytest.raises(RuntimeError, match="Cannot inspect"):
        release.service_snapshot(cloud, "deckastra-api")
