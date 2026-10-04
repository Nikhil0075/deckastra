import json, os, sys, traceback
import harness
s = json.loads(harness.STATE.read_text())
one = lambda key: {"kind": "slide", "slide_ids": [s[key]], "element_ids": []}
deck = {"kind": "deck", "slide_ids": [], "element_ids": []}
CASES = [
    ("tidy-warm", "tidy", dict(scope=one("faults"), instruction="Fix the layout problems on this slide.")),
    ("alt-images", "alt_text", dict(scope=one("images"), instruction="Write alt text for the pictures on this slide.")),
    ("alt-faults", "alt_text", dict(scope=one("faults"), instruction="Write alt text for the chart picture.")),
    ("edit-injection", "edit", dict(scope=one("inj"), instruction="Tighten the quote to one short sentence. Keep the partner names and seat counts exactly.")),
    ("translate-data-hi", "translation", dict(scope=one("data"), locale="hi-IN", instruction="Translate this slide into Hindi.")),
    ("narration-wall", "narration", dict(scope=one("wall"), instruction="Write a short narration for each click step from the slide and notes.")),
    ("motion-data", "motion", dict(scope=one("data"), instruction="Reveal the takeaways one by one after the chart.")),
    ("consistency-deck", "consistency", dict(scope=deck, instruction="Make title sizes and capitalization consistent across the deck.")),
    ("organise-deck", "organise", dict(scope=deck, instruction="Tag and describe the pictures used in this deck.")),
    ("research-sources", "research", dict(scope=deck, source_asset_ids=[s["csv"], s["pdf"]], instruction="Summarise FY26 revenue growth by region and the India market growth figure, with citations.")),
    ("speech-stub", "speech", dict(scope=one("wall"), locale="en", instruction="")),
    ("export-pptx-sel", "export", dict(scope={"kind": "slide", "slide_ids": [s["data"], s["maths"], s["mixed"]], "element_ids": []}, export_kind="pptx", locale="en")),
    ("export-hi", "export", dict(scope=deck, export_kind="pdf", locale="hi-IN")),
    ("generate-5", "generate", dict(scope=deck, slide_count=5, source_asset_ids=[s["csv"], s["pdf"]], instruction="Create a five-slide board update on FY26 regional revenue, using only the supplied sources.")),
]
only = sys.argv[1:]
for name, task, kw in CASES:
    if only and name not in only: continue
    print(f"\n######## {name}", flush=True)
    try:
        rec = harness.run(task, **kw)
        os.replace(sorted((harness.WORK / "runs").glob(f"{task}-*.json"), key=os.path.getmtime)[-1], harness.WORK / "runs" / f"{name}.json")
    except Exception:
        traceback.print_exc()
    sys.stdout.flush()
