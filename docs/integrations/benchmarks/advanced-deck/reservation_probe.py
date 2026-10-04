import json, sys
import harness
from deckastra_agents.vertex_model import VertexClient
from deckastra_agents.budgets import RunBudget, BudgetExceeded
from deckastra_agents.router import ModelRequest
from deckastra_api import assistant_tasks
config = dict(project="deckastra", location="global", credentials="x", identity="", ceiling=5.0,
              prices={"gemini-3.8-flash": {"input": 1.5, "output": 7.5}, "gemini-3.1-flash-image": {"input": 0.5, "output": 3, "image_output": 60}}, thinking={"gemini-3.8-flash": "LOW"})
s = json.loads(harness.STATE.read_text())
doc = json.loads((harness.HERE / "advanced/advanced.mydeck.json").read_text(encoding="utf-8"))
def probe(label, request, snapshot_extra=None, raw=None):
    client = VertexClient("gemini-3.8-flash" if raw is None or not raw.image_output else "gemini-3.1-flash-image", config, token=lambda: "x")
    budget = RunBudget(max_wall_clock_seconds=60, max_total_tokens=60000, max_cost_usd=1e-9)
    try:
        if raw is not None:
            client.complete(raw, budget)
        else:
            snap = {"document": doc, "images": [], "assets": [], "vision": [], "sources": [], "run_id": "probe"}
            assistant_tasks.compute(request, snap, client, budget, lambda e: None)
    except BudgetExceeded as exc:
        print(f"{label:28} would reserve ${exc.used:.4f}")
    except Exception as exc:
        print(f"{label:28} {type(exc).__name__}: {str(exc)[:200]}")
one = lambda k: {"kind": "slide", "slide_ids": [s[k]], "element_ids": []}
base = {"presentation_id": doc["id"], "locale": "en", "instruction": "Fix the layout problems."}
probe("tidy: faults slide", {**base, "task": "tidy", "scope": one("faults")})
probe("tidy: whole deck", {**base, "task": "tidy", "scope": {"kind": "deck", "slide_ids": [], "element_ids": []}})
probe("narration: risks slide", {**base, "task": "narration", "scope": one("wall")})
probe("image: one picture", None, raw=ModelRequest(task_type="structured", stage="image", system="Create one image.", messages=[{"role": "user", "content": "A map of India"}], max_tokens=4096, image_output=True))
