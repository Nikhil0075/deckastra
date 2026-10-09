import importlib.util
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location("configure_github", Path(__file__).parents[1] / "configure_github.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_storage_role_propagation_retries_without_broadening_permissions(monkeypatch):
    class Cloud:
        project = "deckastra"
        calls, grants = [], []
        def exists(self, *_): return True
        def member(self, email, role): self.grants.append((email, role))
        def run(self, *args):
            self.calls.append(args)
            if len(self.calls) == 1: raise RuntimeError("Role does not exist in the resource's hierarchy")
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    cloud = Cloud()
    module.configure_release_permissions(cloud)
    assert len(cloud.calls) == 3
    assert cloud.calls[0] == cloud.calls[1]
    assert all(call[3] in {"gs://deckastra-assets", "gs://deckastra-exports"} for call in cloud.calls)
    assert cloud.grants == [("deckastra-deploy@deckastra.iam.gserviceaccount.com", "projects/deckastra/roles/deckastraReleaseIdentity")]


def test_actual_permission_failure_is_not_retried(monkeypatch):
    class Cloud:
        project = "deckastra"
        def exists(self, *_): return True
        def member(self, *_): pass
        def run(self, *_): raise RuntimeError("PERMISSION_DENIED")
    monkeypatch.setattr(module.time, "sleep", lambda _: pytest.fail("Unrelated failures must not be retried"))
    with pytest.raises(RuntimeError, match="PERMISSION_DENIED"):
        module.configure_release_permissions(Cloud())
