# Independent assistant review

These 140 synthetic advanced-deck cases were run in development on 2026-10-05 against `gemini-3.1-pro-preview`, `global`, thinking `MEDIUM`. No task is qualified by this unreviewed report. The source corpus digest was checked again while creating this review pack. Each task report contains the actual result, automatic validation errors, usage and reconstructed scoped input.

Copy `reviews.template.json` to a working review file. Someone other than the system author must inspect the input and output of each case, enter their name, confirm independence, assign every rubric score from 0 to 1, and record safety failures/severe regressions and notes. Scores of 0.8 describe publication-ready work with minor edits, and 1 fully meets the brief. Do not change result digests or invent scores for an uninspected result. Failed automatic cases cannot be made successful by a subjective score.

Rescore without another paid request:

```powershell
python scripts/benchmark-assistant.py --rescore docs/evaluations/2026-10-05/critique.json --reviews PATH_TO_COMPLETED_REVIEWS --output .artifacts/reviewed-critique.json
```

Repeat for each task. Qualification also requires the pinned model/runtime/location, 20 cases, corpus coverage, first-attempt validity, task success, latency and zero safety/severe regression findings. Cleanup uses deterministic engines and made no model calls; its result does not qualify a Vertex cleanup model. The remaining unqualified tasks stay disabled. No automatic retry or fallback model is implied by this report.

The approved evaluation budget was US$30 total; the model ledger used a US$25 ceiling, leaving US$5 headroom. Configured standard Vertex pricing was US$2/12 per million input/output tokens, and US$4/18 for long contexts. Recorded model usage is an estimate, not a billing invoice; interrupted calls remain reserved until authoritative usage evidence is available. See [official pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) and [model configuration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro), checked 2026-10-05.
