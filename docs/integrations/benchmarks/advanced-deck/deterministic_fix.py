import json, time
import harness  # sets env
from deckastra_api import assistant_design, author_service
from deckastra_api.patch import apply_patch
s = json.loads(harness.STATE.read_text())
doc = json.loads((harness.HERE / "advanced/advanced.mydeck.json").read_text(encoding="utf-8"))
slide = s["faults"]
for rnd in range(4):
    t = time.monotonic()
    findings = [f for f in assistant_design.check(doc)["findings"] if f["slideId"] == slide]
    print(f"round {rnd}: {len(findings)} findings {[f['code'] for f in findings]} ({time.monotonic()-t:.1f}s)")
    ops = [op for f in findings for op in f.get("suggestedFix", [])][:]
    if not ops: break
    # apply one finding's fix at a time (they may overlap on the same element)
    applied = 0
    for f in findings:
        if not f.get("suggestedFix"): continue
        if author_service.check(doc, f["suggestedFix"]): continue
        doc, _ = apply_patch(doc, f["suggestedFix"]); applied += 1
    print("  applied fixes:", applied)
    if not applied: break
print("remaining:", [(f["code"], f["message"][:70]) for f in assistant_design.check(doc)["findings"] if f["slideId"] == slide])
