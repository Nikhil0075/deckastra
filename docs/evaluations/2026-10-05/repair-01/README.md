# Independent assistant review

Start with **critique-review.html**, the new 20-case critique assessment. The
earlier completed review belongs to different result hashes and must not be
reused. No case has an independent quality score yet; zeros in task-success
metrics mean unreviewed, not a completed review with zero successful results.

The Flash LOW critique and narration candidates meet their automatic
first-attempt and local latency gates. Authoring has two transport failures;
translation has one interruption; vision and planning needed one semantic
repair each. Translation, vision and planning exceed their latency gate in this
run. Failed cases remain present. Cleanup is deterministic and made no model
calls. No task is currently qualified or enabled.

`verification.json` records the implementation fingerprint, environment and Pro
critique comparison. `workflow-smoke-en.json` and `workflow-smoke-hi.json` are two
bounded checks of the real generation path: both produced three schema-valid
slides and the correct source-language metadata. They are smoke tests, not a
20-case whole-workflow qualification or an independent content-quality review.
The latency results came from the local Windows host using IPv4, not Cloud Run.

These 140 synthetic advanced-deck cases were evaluated against gemini-3.8-flash. Exact runtime IDs, locations and thinking settings are in the task reports. No task is qualified by this unreviewed report. The source corpus digest was checked while preparing the review pack. Each task report contains the actual result, automatic validation errors, usage and reconstructed scoped input.


Copy `reviews.template.json` to a working review file. Someone other than the system author must inspect the input and output of each case, enter their name, confirm independence, assign every rubric score from 0 to 1, and record safety failures/severe regressions and notes. Scores of 0.8 describe publication-ready work with minor edits, and 1 fully meets the brief. Do not change result digests or invent scores for an uninspected result. Failed automatic cases cannot be made successful by a subjective score.

For critique, open `critique-review.html` in a browser. The offline form shows each recorded request, source deck, actual output and empty assessment fields. It saves drafts in that browser and downloads `critique-reviews.completed.json` only after all 20 cases are inspected and scored. Source deck/layout JSON is included; it is not a visual render. Put the completed review in the workspace and supply its path for rescoring. `scripts/prepare-critique-review.py` regenerates the form without inference.

Rescore without another paid request:

```powershell
python scripts/benchmark-assistant.py --rescore docs/evaluations/2026-10-05/repair-01/critique.json --reviews PATH_TO_COMPLETED_REVIEWS --output .artifacts/reviewed-critique.json
```

Repeat for each task. Qualification also requires the pinned model/runtime/location, 20 cases, corpus coverage, first-attempt validity, task success, latency and zero safety/severe regression findings. Cleanup uses deterministic engines and made no model calls; its result does not qualify a Vertex cleanup model. The remaining unqualified tasks stay disabled. No automatic retry or fallback model is implied by this report.

The approved evaluation budget is US$30 total; the shared model ledger uses a US$25 ceiling, leaving US$5 headroom. Candidate pricing is pinned in docs/integrations/benchmarks/cloud-configuration.json and conservatively uses standard rates. Recorded model usage is an estimate, not a billing invoice; interrupted calls remain reserved until authoritative usage evidence is available. See [official pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) and [model configuration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro), checked 2026-10-05.
