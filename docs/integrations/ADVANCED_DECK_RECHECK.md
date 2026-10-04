# Advanced-deck recheck — 2026-10-04

This rechecks [the remediation](ADVANCED_DECK_REMEDIATION.md) against the same
21-slide deck and harness as [the audit](ADVANCED_DECK_AUDIT.md). It ran in
local-only mode on Gemma E2B with an isolated database. No paid calls were made.
The run records are in [benchmarks/advanced-deck/runs-v2](benchmarks/advanced-deck/runs-v2/),
and `batch2.py` reruns them.

**Caveat:** the machine was under heavy memory pressure during the model cases.
Commands that normally return instantly took more than a minute. The model-case
timings and the later SQLite lock errors are not product evidence. The engine
cases and code findings below do not depend on timing.

## Confirmed fixed

| Audit finding | Observed |
| --- | --- |
| Model rewrites cleanup geometry | Tidy runs the engine: 2.4 s, no model, 7 operations, pending review with residual findings listed. |
| Resized duplicate missed | The 800 px copy is now a `candidate` at distance 0. |
| Tidy and motion need a paid model | Capabilities report both as `engine`. |
| Model runtime survives its parent | After the batch exited, no `llama-server` was left and VRAM was back to 30 MiB. Last time two servers held 3.4 GB. |
| One missing image blocks alt text | Preparation no longer fails with "No such asset". The model then timed out, so the warning path was not observed end to end. |
| Generation ignores sources | The orchestrator now receives the attached sources. The generate case did not run because of the lock (see caveat). |
| Equation unknown | `equation` is in `ElementTypeSchema`. |

## New regression: motion destroys authored reveals

The motion job now calls `motion.animate_slide`, which assigns
`slide["animations"] = tracks`. It **replaces** every existing track, and
`motion_click_reveals` defaults to 0.

| Slide | Before | After |
| --- | --- | --- |
| "Three steps" (4 narration cues on steps 0–3) | 3 click reveals | `slideEnter`, `timer`, `withPrevious` ×2, so no clicks |
| "Click to reveal" | `staggerReveal` + `drawPath` on click | one `fade` on slide enter |

- **The person was not asked.** Both changes applied immediately at low risk.
  `create_proposal(..., model_authored=task not in {"tidy", "motion"})` exempts
  engine tasks from forced review.
- **The instruction is ignored.** The instruction was "Keep my click reveals; just
  make them smoother". The motion and tidy paths never read the instruction box.
- **Narration was broken.** Afterwards, Design Check reports W323 on "Three steps":
  three narration lines "belong to click 1, which this slide no longer has". The
  motion path runs `scope_errors` but not `assistant_design.regressions`, so it
  creates a finding that tidy's gate would have refused.

**Fixed the same day.** `assistant_tasks.plan_motion` changes motion as follows:

- **Kept by default.** Slides that already have tracks are left alone and named in
  a warning, unless the request sets `motion_replace`.
- **Clicks preserved.** A replacement asks for the slide's own click count. When
  the role-based planner cannot rebuild every click, that slide keeps its motion.
  Both fixture slides hit this case: their clicks share one role.
- **New findings refuse the plan.** Any new Design Check finding, warnings such as
  W323 included, refuses the whole plan with the finding's own words.
- **Replacement is reviewed.** Replacing authored tracks is held for review through
  `create_proposal(review_reason=…)`.

The panel no longer shows an instruction box for motion or tidy. It offers
"Replace existing animation" instead and says what will happen.

Run through the API, the two slides above are now kept, with and without
replacement. "Sequenced entrance" (entrances only) re-plans as a pending proposal
whose reason reads "Replaces existing animation". The tests fail against the old
behaviour.

Original suggested direction:

- Leave slides that already have tracks alone unless the request explicitly says
  to replace them.
- Otherwise default `motion_click_reveals` to the slide's existing click count.
- Run the regression gate.
- Treat replacing authored tracks as reviewable.
- Say in the panel that motion and tidy ignore the instruction text.

## Still open or new

- **Errors are now too generic.** A model timeout, a schema failure and a rejected
  patch all show "The assistant could not produce a validated result… review the
  run before retrying". The checkpoint holds the reason, but the person gets no
  next step. A fixed short list such as "the local model did not answer in time",
  "the model's change failed validation" or "the deck changed" would keep internal
  prompts private and still be actionable.
  **Fixed 2026-10-04.** `public_error` classifies by exception type and cause
  chain, and each kind of failure gets its own sentence: what happened, that
  the deck was not changed, and what to try.
  - The kinds are timeout, time and token limit, cost ceiling, context too
    large, not installed, unusable format, refusal, provider error, rejected
    change, cancelled, and unexpected.
  - A rejected change names its reasons ("it changed something outside the
    selection", "it removed a source attribution"). These come from the
    product's own checks, never from model text or repair prompts.
  - The full diagnostic stays in the checkpoint.
  - The per-slide skip now keys on `AssistantFailure` rather than a sentence.
  - A Design Check timeout says so instead of asking for configuration.
- **Single-slide jobs still get 180 s.** Alt text and edit ended at 180 s with zero
  tokens: cold start plus the CPU vision projector did not answer in time.
  Per-slide scaling only helps multi-slide jobs. A cold start should not count
  against the first slide's budget, or the floor should be higher for local runs.
  **Fixed 2026-10-04.** Three changes:
  - **Start-up is off the clock.** Loading a local model is no longer charged to
    the job (`RunBudget.exclude_time`). Loading keeps its own bound
    (`DECKASTRA_MODEL_STARTUP_SECONDS`), and cancellation still stops it. The run
    reports `startup_seconds`.
  - **Allowance follows where the model runs.** The per-slide allowance is
    360 s locally and 180 s in the cloud, which leaves room for the repair a
    slide is entitled to (local attempts measured 47–112 s). Routing decides
    which applies. The job ceiling is 3,600 s locally and 1,800 s in the cloud.
    Engine tasks keep 180 s. `DECKASTRA_ASSISTANT_SLIDE_SECONDS` overrides the
    allowance.
  - **Finished slides are kept.** A multi-slide job that runs out of time keeps
    the slides it already validated. It does not start a slide it cannot finish,
    and it names the slides it did not reach. It still stops outright when nothing
    is finished or when a paid call's outcome is uncertain.
- **Design Check timeout reads as misconfiguration.** The helper's fixed 20 s
  subprocess timeout fired during consistency and reported "Design Check runtime
  unavailable. Configure DECKASTRA_DESIGN_CHECK_CMD." A slow machine is not a
  configuration problem.
- **Status reads write.** `GET /v1/assistant/runs/{id}` and the list call
  `recover()`, an UPDATE. Under write contention a status poll fails with 500
  "database is locked" instead of returning the run. Recovery belongs in the
  dispatcher, or the poll should tolerate a busy database.
  **Fixed 2026-10-04.** Status reads (`GET /runs/{id}`, `GET /runs`, the
  stream) no longer write. A `running` run whose lease has passed is
  reported as `interrupted` by `result()`. Only the dispatcher's 5-second loop
  and resume persist that state, and both are writers anyway. The stream also
  ends for such a run instead of waiting out its 25 s. A test holds SQLite's
  write lock from a second connection and polls: the old code fails with
  "database is locked", the new code answers.
- **Per-slide failure is matched on message text.** (Fixed with the error
  messages: the skip now keys on `AssistantFailure`.) `compute()` decides whether
  a slide failure is skippable by comparing `str(exc)` with one exact sentence.
  Any change to that sentence turns a skipped slide into a failed job. Use an
  exception type.
- **Model quality is unchanged.** Translation and narration again produced no
  usable patch on E2B. `patch_valid: false` is now recorded, so the metric is
  honest.

## Generate, organise and research rerun (2026-10-04, after the lock fix)

All three ran to completion on Gemma E2B, with model start-up kept off the clock
(14–15 s each). Records are `runs-v2/v2-{organise-deck,research-sources,generate-5}.json`.

- **Research passed.** It computed India +20.95% and GCC +23.84% and labelled both
  first-to-last rather than year-on-year. It reported the 18% vs 11% contradiction,
  and flagged the planted "9,999 crore" note and the "60% market share" override
  instead of following them. Took 30 s.
- **Organise was rejected by our filter, not by the model.** Gemma described the
  chart correctly ("North (42%), South (67%)…"). One tag on the decorative image,
  "swoosh", equals its file name stem (`swoosh.png`). The filename rule then
  rejected the whole batch and discarded the good description too. The rule
  should drop the matching tag, not the batch.
- **Generate passed the orchestrator** (the attached-sources fix holds) and
  planned five slides, all on the first attempt. The gate then refused them for
  A102: the composer's `_caption` (`compose.py`) draws 18 px text in
  `colors.foregroundSubtle` (#6B7C90). That is 4.49:1 on this theme's background
  (#0B0F14) and 4.17:1 on its surface, against the 4.5:1 required. Replaying the
  saved answers through the composer reproduces it with no inference. Every
  generation that appends a captioned slide to a deck on this theme fails,
  whatever the model writes.

**Both fixed the same day:**

- **Organise** now drops only tags that repeat the file name (`filename_tag`,
  ignoring case and separators). An asset whose tags were all file-name copies is
  left unchanged with a warning, and only a batch with nothing usable is refused.
- **Composer captions** now take the quietest colour that reaches 4.5:1 on the
  theme's background (`compose.caption_colour`). That colour is chosen for the
  theme the slides render in: the composer's own, or the deck's theme when
  generation appends slides. On Neo Technical that is `foregroundMuted`, and
  every other shipped preset keeps `foregroundSubtle`.

Rerun on Gemma (`v2-*-fixed.json`):

- **Organise** produced a correct chart description, held as a pending metadata
  proposal.
- **Generate** appended 5 slides (21 → 26) as a pending medium-risk proposal,
  with no severe findings on the new slides.

**Content problem in that generation.** The metrics slide labels India +21% and
GCC +24% as "YoY". They are Q1-to-Q4 growth, which the research job labels
correctly. Generation does not receive the CSV calculator's results. The
proposal is held for review, so a person would see it, but the gap is real.

## Not rechecked

Generate, organise and research did not run (lock, see caveat). The following were
read but not exercised:

- Reservation reconciliation
- Per-entry translation draft status
- Proposal review for model-authored edits
- History summaries
- Image placement
