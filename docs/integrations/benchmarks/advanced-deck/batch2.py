import json, os, sys, traceback
sys.stdout.reconfigure(encoding="utf-8")
import harness
s = json.loads(harness.STATE.read_text())
one = lambda key: {"kind": "slide", "slide_ids": [s[key] if key in s else key], "element_ids": []}
deck = {"kind": "deck", "slide_ids": [], "element_ids": []}
STEPS, CLICK = "sld_01JB8Z9K2QW4RN7F3X04001400", "sld_01JB8Z9K2QW4RN7F3X03002300"
CASES = [
    ("tidy-faults", "tidy", dict(scope=one("faults"), instruction="Fix the layout problems on this slide.")),
    ("tidy-deck", "tidy", dict(scope=deck, instruction="Fix layout problems across the deck.")),
    ("motion-steps", "motion", dict(scope=one(STEPS), instruction="Keep my click reveals; just make them smoother.")),
    ("motion-click", "motion", dict(scope=one(CLICK), instruction="Make it calmer.")),
    ("alt-images", "alt_text", dict(scope=one("images"), instruction="Write alt text for the pictures on this slide.")),
    ("edit-injection", "edit", dict(scope=one("inj"), instruction="Tighten the quote to one short sentence. Keep the partner names and seat counts exactly.")),
    ("consistency-3", "consistency", dict(scope={"kind": "slide", "slide_ids": [s["faults"], s["data"], s["wall"]], "element_ids": []}, instruction="Make title capitalization consistent.")),
    ("translate-data-hi", "translation", dict(scope=one("data"), locale="hi-IN", instruction="Translate this slide into Hindi.")),
    ("narration-wall", "narration", dict(scope=one("wall"), instruction="Write a short narration for each click step from the slide and notes.")),
    ("organise-deck", "organise", dict(scope=deck, instruction="Tag and describe the pictures used in this deck.")),
    ("research-sources", "research", dict(scope=deck, source_asset_ids=[s["csv"], s["pdf"]], instruction="Summarise FY26 revenue growth by region and the India market growth figure, with citations.")),
    ("generate-5", "generate", dict(scope=deck, slide_count=5, source_asset_ids=[s["csv"], s["pdf"]], instruction="Create a five-slide board update on FY26 regional revenue, using only the supplied sources.")),
]
only = sys.argv[1:]
for name, task, kw in CASES:
    if only and name not in only: continue
    print(f"\n######## {name}", flush=True)
    try:
        harness.run(task, **kw)
        os.replace(sorted((harness.WORK / "runs").glob(f"{task}-*.json"), key=os.path.getmtime)[-1], harness.WORK / "runs" / f"v2-{name}.json")
    except Exception:
        traceback.print_exc()
    sys.stdout.flush()
