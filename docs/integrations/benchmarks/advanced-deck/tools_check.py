import json, time
from harness import app_client, STATE
s = json.loads(STATE.read_text()); auth = {"Authorization": f"Bearer {s['token']}"}
with app_client() as c:
    t = time.monotonic(); r = c.get(f"/v1/presentations/{s['presentation_id']}/design-check", headers=auth); dt = time.monotonic() - t
    print("design-check", r.status_code, f"{dt:.1f}s")
    if r.status_code == 200:
        f = r.json()["findings"]
        from collections import Counter
        print("findings", len(f), Counter(x["code"] for x in f))
        names = {"faults": "Layout faults", "images": "Field photos", "wall": "Risks", "mixed": "Languages", "data": "Revenue", "inj": "Partner"}
        for key in names:
            print(" ", key, sorted(Counter(x["code"] for x in f if x["slideId"] == s[key]).items()))
        print(" sample:", json.dumps(f[0])[:500])
    else:
        print(r.text[:500])
    print("assets", [(a["filename"], a["sha256"] and a["sha256"][:8], a["dhash64"], a["width"]) for a in c.get("/v1/assets", headers=auth).json()["assets"]])
    print("duplicates", c.get("/v1/assets/duplicates", headers=auth).json())
    v = c.get(f"/v1/assets/{s['IMG_ID']}/view?max_px=256&x=0&y=0&width=800&height=450", headers=auth); print("view", v.status_code, {k: v.json()[k] for k in ("width", "height")} if v.status_code == 200 else v.text[:200])
    caps = c.get("/v1/assistant/capabilities", headers=auth).json()
    print("caps mode", caps["provider"], caps["available"], caps["reason"])
    for task, info in caps["tasks"].items(): print(f"  {task:12} {info['available']!s:5} {info['provider']:6} {info['model']} {info['reason']}")
