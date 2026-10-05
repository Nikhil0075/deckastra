import copy
import importlib.util
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location("web_hosting", Path(__file__).parents[1] / "web_hosting.py")
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)


def test_cors_update_preserves_existing_rules_and_is_idempotent():
    original = {"origin": ["https://existing.test"], "method": ["GET"], "responseHeader": ["X-Special"]}
    class Cloud:
        project = "deckastra"
        def __init__(self):
            self.buckets = {kind: [copy.deepcopy(original)] for kind in ("assets", "exports")}
            self.patches = []
        def rest(self, method, url, body=None):
            kind = "assets" if "-assets?" in url else "exports"
            if method == "GET": return {"cors": self.buckets[kind]}
            assert method == "PATCH" and list(body) == ["cors"]
            self.patches.append(body)
            self.buckets[kind] = body["cors"]
    cloud = Cloud()
    web.ensure_bucket_cors(cloud, ["http://localhost:3000", "https://web.a.run.app"])
    assert len(cloud.patches) == 2
    for body in cloud.patches:
        assert body["cors"][0] == original
        assert body["cors"][1]["origin"] == ["http://localhost:3000", "https://web.a.run.app"]
        assert "*" not in body["cors"][1]["origin"]
    web.ensure_bucket_cors(cloud, ["http://localhost:3000", "https://web.a.run.app"])
    assert len(cloud.patches) == 2


@pytest.mark.parametrize("tag", ["main", "latest", "abc123", "x" * 40, "a" * 40 + ";command"])
def test_web_deploy_requires_exact_commit_tag(tag):
    with pytest.raises(ValueError, match="Git commit"):
        web.deploy_web(object(), tag)


@pytest.mark.parametrize("url", ["https://untrusted.test", "https://web.a.run.app,https://evil.a.run.app", "http://web.a.run.app"])
def test_host_access_only_uses_exact_discovered_cloud_origin(url):
    with pytest.raises(ValueError):
        web.configure_access(object(), url)


def test_web_image_has_cloud_identity_and_api_build_inputs():
    dockerfile = (Path(__file__).parents[1] / "docker/web.Dockerfile").read_text()
    assert "COPY infrastructure/deployment/public-auth.json" in dockerfile
    assert "COPY tsconfig.json tsconfig.base.json" in dockerfile
    assert "ARG NEXT_PUBLIC_DECKASTRA_CLOUD" in dockerfile
    assert "c.apiUrl !== process.env.NEXT_PUBLIC_API_URL" in dockerfile


def test_origin_update_preserves_configuration_and_secret_references():
    previous = {"spec": {"template": {"spec": {"containers": [{"env": [
        {"name": "DECKASTRA_VERTEX_MODELS", "value": "{}"},
        {"name": "DECKASTRA_CREDITS_ENABLED", "value": "1"},
        {"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": "deckastra-database-url", "key": "latest"}}}
    ]}]}}}}
    origins = "http://localhost:3000,https://web.a.run.app"
    values, refs = web.api_origin_env(previous, origins)
    assert values == {"DECKASTRA_VERTEX_MODELS": "{}", "DECKASTRA_CREDITS_ENABLED": "1", "DECKASTRA_WEB_ORIGINS": origins}
    assert refs == "DATABASE_URL=deckastra-database-url:latest"
    assert "DATABASE_URL" not in values
