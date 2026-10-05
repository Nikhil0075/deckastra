# Independent assistant review

These 140 synthetic advanced-deck cases were evaluated against gemini-3.8-flash. Exact runtime IDs, locations and thinking settings are in the task reports. No task is qualified by this unreviewed report. The source corpus digest was checked while preparing the review pack. Each task report contains the actual result, automatic validation errors, usage and reconstructed scoped input.


Copy `reviews.template.json` to a working review file. Someone other than the system author must inspect the input and output of each case, enter their name, confirm independence, assign every rubric score from 0 to 1, and record safety failures/severe regressions and notes. Scores of 0.8 describe publication-ready work with minor edits, and 1 fully meets the brief. Do not change result digests or invent scores for an uninspected result. Failed automatic cases cannot be made successful by a subjective score.

For critique, open `critique-review.html` in a browser. The offline form shows each recorded request, source deck, actual output and empty assessment fields. It saves drafts in that browser and downloads `critique-reviews.completed.json` only after all 20 cases are inspected and scored. Source deck/layout JSON is included; it is not a visual render. Put the completed review in the workspace and supply its path for rescoring. `scripts/prepare-critique-review.py` regenerates the form without inference.

Rescore without another paid request:

```powershell
python scripts/benchmark-assistant.py --rescore docs/evaluations/2026-10-05/repair-02/critique.json --reviews PATH_TO_COMPLETED_REVIEWS --output .artifacts/reviewed-critique.json
```

Repeat for each task. Qualification also requires the pinned model/runtime/location, 20 cases, corpus coverage, first-attempt validity, task success, latency and zero safety/severe regression findings. Cleanup uses deterministic engines and made no model calls; its result does not qualify a Vertex cleanup model. The remaining unqualified tasks stay disabled. No automatic retry or fallback model is implied by this report.

The approved evaluation budget is US$30 total; the shared model ledger uses a US$25 ceiling, leaving US$5 headroom. Candidate pricing is pinned in docs/integrations/benchmarks/cloud-configuration.json and conservatively uses standard rates. Recorded model usage is an estimate, not a billing invoice; interrupted calls remain reserved until authoritative usage evidence is available. See [official pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) and [model configuration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro), checked 2026-10-05.

## Recorded contract results

| Task | Automatic valid | First attempt | Local warm p95 |
| --- | --- | --- | --- |
| planning | 20/20 | 90% | 97.9s |
| authoring | 20/20 | 100% | 7.2s |
| cleanup | 20/20 | No model call | 2.9s |
| critique | 20/20 | 100% | 10.1s |
| translation | 20/20 | 100% | 14.6s |
| narration | 20/20 | 100% | 6.7s |
| vision | 19/20 | 95% | 14.0s |

The final candidate uses one immutable implementation, including selected-group
boundaries, protected values with units and currency, planner prose language
checks, and pooled transport. Scoped tools include five element-selection cases
alongside fifteen slide-selection cases. Every case remains in the report.
Vision case 00 failed before model execution when this Windows host's Google
token command returned access denied. It is not replaced with a later success.
No new independent quality scores exist; zero task-success metrics mean
unreviewed outputs, not completed human scoring. Safety and severe-regression
counts also require independent review. Cleanup made no model calls and cannot
qualify a Vertex cleanup model.
