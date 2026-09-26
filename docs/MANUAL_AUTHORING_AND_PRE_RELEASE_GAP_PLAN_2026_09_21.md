# Manual authoring and desktop release gap plan

Reviewed 21 September 2026, Windows x64. Baseline commit: `025fcb2c01b33d81f3ac600c651f9eae9ca2ce54`, with substantial existing uncommitted implementation. This is a review of that working tree, not a certification of an installed release. See the accompanying evidence directory for source fingerprints and test output.

## Decision

**Do not sign off the final package yet.** There are reproducible editing defects, missing manual-authoring workflows, and incomplete installed interaction evidence. Passing the existing suites is insufficient to close these gaps.

The objective is: **a person can build and revise a useful presentation without AI, and can edit an AI-authored presentation using the same controls.** AI should reduce work, not be the only way to change chart data, labels, formatting, or motion.

This adds an authoring gate ahead of final release acceptance in [the existing 36-item register](DESKTOP_FINAL_PACKAGE_FIX_REGISTER.md). It does not reset completed work or authorize every suggested feature automatically. Keep the agreed Windows x64/local-workspace scope; macOS, local model distribution, cloud collaboration, and `.mydeck` file association remain excluded from this candidate. The supplied delivery plan is reference material; its historical defect descriptions are not current test results.

Items **11 and 12** can be engineered while authoring work proceeds, but signing the distributable and verifying its nested binaries must use the final payload after these fixes. **33, notices, can proceed now**, with regeneration/review after dependency changes. Holding licensing work until every UI fix is finished provides no benefit.

## What this review establishes

Five additional defects have deterministic failing tests against the current implementation:

1. Group children do not follow their parent in the live drag preview.
2. Rotation changes the selection overlay while the object retains its original transform until commit.
3. Canvas text commits a partial IME composition on blur.
4. Canvas rich-text paste flattens supported bold formatting.
5. A tall inserted image extends far outside the slide: a 100 × 1000 image on the 1920 × 1080 fixture becomes 960 × 9600 at **y = −4260**.

These are DOM/component or pure-function reproductions, not claims that a human performed those gestures in an installed app. Positive controls verify ordinary text commit, plain paste, landscape insertion, and the existing gesture behaviour.

Additional source-confirmed problems include missing handlers for the defined Enter-to-edit and Ungroup shortcuts, destructive plain-text editing in the inspector, and group resizing that differs between handles and numeric fields.

After the user freed resources and asked for a retry, native interaction worked. **Double-click text entry and PNG dragging failed in the live development app.** Selecting and dragging a headline worked; repeated double-clicks did not create an editable field, and Enter did nothing. A newly inserted, unanimated text box also failed double-click entry. A generated test PNG inserted and displayed, but dragging its visible centre left X/Y at 480/270. **Transition selection worked:** slide 2 changed from Slide to Fade and the UI reported Saved. These observations narrow the original reports; they do not certify the installed candidate or all image/group variants.

Current source already makes renderer nodes interactive in editor mode (`SlideView.tsx:166`, `elements.tsx:903`); this is existing code, not a fix made in this review. It would be wrong to claim that pointer-events are universally disabled. Browser pointer capture and native image dragging need regression coverage, not only synthetic pointer events.

Transition editing and morph pairing are implemented. The focused tests pass; this review does not support the earlier claim that the transition engine is absent. PPTX also now has a `pictureShape` implementation: the historical “PPTX always drops images” finding must not be repeated as the current state.

## Evidence and terminology

- **Reproduced:** a test executed here demonstrates the failure.
- **Source-confirmed:** the concrete missing or destructive path is visible in inspected code; an end-to-end reproduction remains required.
- **Capability gap:** a useful authoring workflow has no corresponding control in the inspected UI. This is additional delivery work, not automatically a regression.
- **Investigation/gate:** not proven broken or complete; specifies the test needed to decide.
- **P1:** blocks the promised basic editable desktop product or protects work. **P2:** important authoring usability; finish or explicitly narrow the beta's claim. No invented P0/security claims.

References below are relative to this repository. Line numbers describe the reviewed source and may move. Each item needs one normal transaction/undo path, meaningful tests, and evidence on the release candidate where applicable.

## A. Direct interaction and correctness

| ID | Priority / evidence | Exact remaining work and impact | Acceptance criterion | Code / existing register |
| --- | --- | --- | --- | --- |
| MA-01 | P1 · reproduced live | Fix double-click entry for existing and newly inserted text. Selection and headline dragging worked, but double-click never opened a text field. Investigate pointer capture retargeting the click to the canvas: the double-click handler depends on `event.target.closest('[data-element-id]')`. Preserve a reliable hit target and distinguish selection from dragging; do not manufacture transactions on ordinary clicks. | Actual mouse input selects objects at fit/100%/200%; double-click edits text and enters groups; plain selection does not dirty the deck. Repeat on the installed candidate and an agent-authored deck. | `EditorCanvas.tsx:205–273`; `renderer/src/react/SlideView.tsx:163`; `live-new-text-doubleclick.*`; old 26/27 |
| MA-02 | P1 · reproduced live | Fix PNG dragging: the decoded test PNG stayed at X/Y 480/270 after a centre drag, whereas a headline moved using the same driver. `<img>` has no `draggable={false}` and canvas pointer-down does not prevent native drag. Verify `dragstart`/pointer-cancel as the cause and suppress native image dragging appropriately. | Drag from visible pixels and transparent interior, release inside/outside canvas, cancel with Escape/pointer cancellation. Exactly one move or no change on cancellation; no browser image ghost; Undo restores position. | `renderer/src/react/elements.tsx:281`; `EditorCanvas.tsx`; `live-png-drag-failed.*` |
| MA-03 | P1 · reproduced | Update descendants' composed geometry during a group drag. `applyDraft` changes only nodes with their own override; grouped content stays behind during preview. | During every sampled drag frame, children retain their offsets from the group. Preview equals committed scene; one Undo restores all, including nested rotated children. | `EditorCanvas.tsx:876–911`; `canvas-live.log` |
| MA-04 | P1 · reproduced | Preview actual rotation. `applyDraft` adjusts translation and bounds but never applies the draft rotation to the object's matrix. | Object and overlay rotate together before release at arbitrary angles and Shift-snapped angles; preview equals commit; Undo is one operation. | `EditorCanvas.tsx:896–905`; `canvas-live.log` |
| MA-05 | P1 · source-confirmed and live failure | Wire `enterTextEdit` into the shell's command switch. Enter is defined in the keyboard registry but has no executing branch; pressing it on the selected headline did not start editing. | Focus canvas, select unlocked text and press Enter: edit in place; typing does not move/delete deck objects; locked/non-text selections behave explicitly. | `editor/src/keyboard.ts:76`; `EditorShell.tsx:399–491` |
| MA-06 | P1 · source-confirmed | Wire Ungroup and expose it in the selected-group UI. The shortcut exists but the shell handles only Group. Generated groups should not require JSON editing to dismantle. | Ctrl+Shift+G and the visible action ungroup while preserving world geometry and element references; one Undo regroups exactly. | `editor/src/keyboard.ts:57`; `EditorShell.tsx:424`; inspector header |
| MA-07 | P1 · source-confirmed | Route numeric group W/H changes through `resizeOperations`, as canvas handles already do. Direct `setProperty(transform.width/height)` bypasses `scaleChildren`. | The same dimensions entered in the inspector or dragged produce identical descendants, fonts, scene digest and undo result for both resize modes. | `inspector/Inspector.tsx:238–239`; `lib/resize-operations.ts` |
| MA-08 | P1 · source-confirmed | Stop silently replacing rich text with `plainText(...)` on every inspector keystroke. Use a rich editor or an explicit, reversible plain-text conversion. | Edit one word in a mixed-format/list text element; unrelated bold, spans, block styles and IDs remain intact. Undo restores exact content. | `Inspector.tsx:250–258` |
| MA-09 | P1 · reproduced | Preserve allowed formatting during canvas paste. Sanitization produces spans but insertion then joins them into a text node. | Paste bold/italic/underline and lists into the middle of text; allowed styles survive; unsafe markup does not; native Undo removes the paste as a coherent edit. | `TextEditor.tsx:162–197`; `focused.log` |
| MA-10 | P1 · reproduced | Make canvas IME commit composition-aware. The composing flag guards keyboard handling, but `onBlur={commit}` commits immediately. | Blur/export/change slide/close during composition never persists partial characters. Defined pre-composition recovery works; completed composition is saved once. Add real IME evidence to event tests. | `TextEditor.tsx:107–124,246–254`; old 27 |
| MA-11 | P1 · investigation | Verify canvas text participates in the close/save draft barrier, not only speaker notes. `TextEditor` owns DOM text and has no draft registration of its own. Trace host close without assuming a blur event occurs. | A just-typed canvas edit survives close and quit, with service healthy/offline, and is blocked when neither save nor journal works. Verify persisted content after restart. | `TextEditor.tsx`; `EditorCanvas.tsx:727`; `lib/close-barrier.ts`; old 01 |
| MA-12 | P2 · source-confirmed geometry mismatch | Align in-place text editing with rotated text and transformed ancestors. The editable receives axis-aligned scene bounds but no rotation/world matrix. | Caret, editable glyphs and selection match the original at 30°/90° and inside a rotated group, at several zooms. No jump when entering/leaving editing. | `EditorCanvas.tsx:580–603`; `TextEditor.tsx:205–232` |
| MA-13 | P1 · reproduced | Fit image insertion to both viewport dimensions, preserving aspect ratio. Current placement constrains width only. | Portrait, panoramic, tiny and ordinary images initially fit within the slide; handles are reachable; original bytes/ratio retained; one-step Undo removes element and its manifest reference. | `lib/insert-image.ts:33–36,63–66`; `focused.log` |

## B. Manual creation without AI

These are minimum workflows to agree and implement, not an invitation to reproduce every feature of PowerPoint. Provide sensible defaults for beginners and direct controls for experienced authors; JSON/AI must not be the only editor.

| ID | Priority / evidence | Exact remaining work and impact | Acceptance criterion | Code |
| --- | --- | --- | --- | --- |
| MA-14 | P1 · capability gap | Add per-element typography controls: family, weight/style, colour, alignment, line spacing and rich-text formatting. Current text inspector mainly exposes content, size and fit. | Make a title, formatted body and caption with different styles without changing the entire theme or using AI. Selection and caret survive toolbar use. | `inspector/Inspector.tsx:248–291`; `TextEditor.tsx` |
| MA-15 | P1 · capability gap | Add shape/line fill and stroke editing: colour, width, dash and relevant radius/markers. Opacity/shape selection alone cannot author an ordinary diagram. | Independently recolour two objects, remove fill, change a line's stroke and undo each change. Editor/presentation/PDF agree. | `Inspector.tsx:294–343` |
| MA-16 | P2 · capability gap | Add align/distribute controls for multiselection, with clear “relative to selection/slide” rules. Snapping exists and should remain. | Align three objects and distribute equal gaps by keyboard or buttons, including nested selections; one transaction per action; locked elements handled predictably. | `Inspector.tsx` multiselection header; `EditorShell.tsx` command switch |
| MA-17 | P1 · capability gap | Add chart data and label editing; changing `chartType` is not chart authoring. | Insert chart, replace categories/values, add/remove a series, handle invalid values visibly and save/reopen/export—all without AI or JSON. | `ToolRail.tsx` Chart; `Inspector.tsx:319–321` |
| MA-18 | P1 · capability gap | Add table cell, row and column editing. A starter table with only generic geometry/appearance controls cannot communicate the user's data. | Edit a cell, add/remove row/column, paste a small rectangular data range, Undo and export with correct values. | `ToolRail.tsx` Table; `Inspector.tsx` has no table content branch |
| MA-19 | P1 · capability gap | Add diagram node/edge/label editing or expose its constituent objects safely. Canvas double-click edits only elements whose type is `text`. | Change node text, add a node/connection and reroute without AI; stable IDs preserve animation targets and undo. | `ToolRail.tsx` Diagram; `EditorCanvas.tsx:264`; `Inspector.tsx` |
| MA-20 | P1 · capability gap | Expose shape labels as editable content. A generated labelled shape must be as editable as a standalone text box. | Double-click or a discoverable inspector action edits the label while keeping the shape, formatting and animation identity. | `renderer/src/react/elements.tsx` shape label rendering; `EditorCanvas.tsx:264` |
| MA-21 | P2 · capability gap | Add image replace without deleting the object. Keep geometry, animation target and alt-text choices explicit. | Replace a picture with a different aspect ratio; preserve ID, placement and clips; show fit choice; Undo restores the original bytes reference. | `ToolRail.tsx`; `Inspector.tsx:340–342`; `lib/insert-image.ts` |
| MA-22 | P2 · capability gap | Add crop/focal-position controls with an uncropped preview/reset. Fit mode alone does not let someone compose a photograph. | Reposition a portrait in a landscape box; keep crop on reopen and disclose any export approximation; reset and Undo work. | image inspector; renderer image `objectPosition` in `scene.ts:714` |
| MA-23 | P2 · capability gap | Implement external text/image clipboard insertion and file drop, with deliberate destination/size/error handling. The shell's object clipboard is component-local state. | Paste an OS screenshot or text into a new slide, drop a PNG, and copy between open decks. Reject unsupported payloads without losing current work; one Undo per insertion. | `EditorShell.tsx:126,409–419`; `ToolRail.tsx` file input |

## C. Transitions, preview and agent-to-human handoff

| ID | Priority / evidence | Exact remaining work and impact | Acceptance criterion | Code |
| --- | --- | --- | --- | --- |
| MA-24 | P2 · discoverability / remaining candidate gate | The live retry successfully selected Motion, slide 2 and Fade, then showed Saved. Do not rewrite this functioning selection path. Make Motion → Transition into slide N discoverable from the selected slide; explain that first-slide Morph has no source slide. Complete the other kinds and installed/scaling checks. | Fresh user can select slide 2, choose Fade/Slide/Zoom/Morph, set duration, save, reopen and Undo. Controls are not clipped at 125–200% scaling. | `shell/MotionModePanel.tsx:96–144`; `live-transition-fade.*` |
| MA-25 | P1 · capability gap | Provide an explicit preview of the incoming slide transition. The existing canvas Preview compiles the current slide's animation tracks, not a two-scene slide transition. Avoid suggesting a morph can be judged by playing entrance clips alone. | “Preview transition” plays previous → current at controlled time, using the presentation transition engine; midpoint and end match presenting, including reduced motion. | `MotionPreview.tsx:63`; `MotionModePanel.tsx`; `PresentMode.tsx` |
| MA-26 | P1 · source-confirmed UX gap | Add Stop/Return to editing pose and reset motion preview when returning to Design or starting an edit. `scrubbing` is reset on slide change, not mode change; a scrubbed invisible/offset object is hard to edit. | Scrub a fade to zero, return to Design: all editable objects return to their ordinary pose. No invisible hit target or offset selection overlay; preview remains explicitly available. | `EditorShell.tsx:137–156,655–669`; `MotionPreview.tsx:115–121` |
| MA-27 | P2 · capability gap | Make morph pairing visually understandable with source/destination highlights or thumbnails. Existing label-based pairs and explicit Keep are valid foundations, not absent functionality. | Pair two otherwise similarly named objects without guessing IDs; unkept suggestions do not animate; removed/reordered slides explain and repair broken pairs. | `MotionModePanel.tsx:147–233`; `lib/transition-editing.ts` |
| MA-28 | P1 · gate | Test generated/agent-edited content with all the same manual controls. Include nested groups, labels, images, charts, tables, motion and a subsequent human edit. | MCP create → revise → animate → human text/image/data edit → undo → save/reopen → export succeeds. A stale proposal refuses and no caller-authored operation triggers a paid model request. | MCP server and workspace client; old 24/25; MA-01–23 |
| MA-29 | P1 · product acceptance gate | Introduce a complete no-AI journey, not just one smoke step per panel. Disable keys and agent access during it. | Build five slides from blank: title, PNG with caption, editable chart/table, simple diagram, summary; add transition; reorder, undo, reopen, present and export. No model request, raw JSON or developer tools. Record completion time and every dead end; agree the target time before sign-off. | `DeckList.tsx:189–193`; `ToolRail.tsx`; old 26 |

## D. Runtime and release verification

| ID | Priority / evidence | Exact remaining work and impact | Acceptance criterion | Link to original work |
| --- | --- | --- | --- | --- |
| MA-30 | P1 · observed startup/recovery failure | Investigate startup timeout and interrupted SQLite migration recovery. This run's fresh profiles exceeded the readiness deadline. Retrying the first interrupted profile failed because `_alembic_tmp_export_jobs` already existed. This includes a timed-out/terminated test launch, not proof of corruption on every normal startup. | On a copy/test profile, interrupt each migration boundary and retry; preserve originals and recover deterministically. Slow cold startup offers useful progress/retry and does not leave an unusable database. Repeat on the packaged sidecar before assigning a production root cause. | `apps/desktop/src/main/sidecar.ts:368–378`; migration `d49ad72c54f1`; old 15/17 |
| MA-31 | P1 · gate | Identify and run the exact final installer, then run trusted pointer/keyboard acceptance. Existing harness `.click()`/dispatched events bypass browser hit-testing and native drag defaults. | Installer hash + manifest + runtime/source identity + isolated profile recorded; actual pointer input passes MA-01–13; no development dependencies required. A failed startup prevents claiming motion/presenter passed. | old 07/26; `apps/desktop/src/main/smoke.ts` |
| MA-32 | P1 · gate | Extend save/recovery/export barriers to every new authoring surface and retain stale-version protection. Reuse the existing transaction engine. | Each edit is one meaningful undo unit; save failure keeps work; last-keystroke export contains the correct saved version; close/relaunch, quota-full journal and agent conflicts lose nothing silently. | old 01; export save barrier; `useEditor.ts` |
| MA-33 | P2 · gate | Re-run physical interaction acceptance after these controls change: IME, screen reader, high DPI, keyboard-only and projector/presenter. | Real evidence for the advertised setup, including text caret, selection handles, transitions and focus; simulated IME/axe alone are not sufficient. | old 27/28/29/31 |
| MA-34 | P1 · release gate | Rebuild and verify the release after the authoring changes; regenerate notices/SBOM, sign binaries and installer, verify nested signatures and candidate CI. | Items 11/12/33 pass on this final payload; Windows installed journey and applicable Linux CI have recorded results; release notes retain explicit exclusions. | old 10/11/12/24/26/32/33 |
| MA-35 | P1 · reproduced verification defect | Fix the smoke harness's first-run race and modal bypass. It waits only five seconds for the introductory dialog. The warm motion run recorded `firstRunNotice: false` and `ok: true`, yet its transition screenshot shows the dialog covering the editor. Programmatic `.click()` drove controls behind it. | Delay introduction mounting past five seconds in a regression: the harness must dismiss it through the visible path or fail. Assert target visibility/hit-testing and no blocking modal before each action. A screenshot of a covered control cannot certify that control. | `apps/desktop/src/main/smoke.ts:237–242,2011`; `smoke-warm/motion.json`; `motion-transition.png` |

## Delivery sequence

1. **Establish a usable and attributable runtime:** MA-30/31, then reproduce MA-01/02/24. Keep the user's real profile untouched. Separate development Python from the packaged sidecar and compare timestamps/build hashes.
2. **Repair direct manipulation and text correctness:** MA-03–13 and MA-26. Add the archived reproducers as permanent tests once fixing their behaviours. Add real pointer coverage; do not replace it with only `dispatchEvent` assertions.
3. **Close the manual-authoring essentials:** MA-14/15/17–20. Include chart/table/diagram data editing in the beta or explicitly narrow what “manually editable” promises. MA-16/21–23 are the next usability slice; do not hide unfinished controls behind AI.
4. **Make motion understandable:** MA-24–27, including two-slide preview and direct pairing feedback. Preserve compile-once/sample-pure and reduced-motion behaviour.
5. **Complete the handoff and no-AI journeys:** MA-28/29/32/33. A generated deck that cannot be comfortably revised manually is not a pass.
6. **Freeze, package, sign and verify:** MA-34, retaining existing release checklist gates. Changes after signing require a new candidate and relevant rechecks.

Each implemented item should record: code change, a regression that fails without it (where applicable), current test results, exact runtime/build used, and any remaining manual gate. Do not turn an investigation into a speculative patch or label a capability gap a verified crash.

## Verification for this review

Results are recorded in the [evidence summary](audit-evidence/manual-authoring-2026-09-21/README.md). The initial unrestricted `npm test` run was interrupted after very slow progress; a second attempted npm invocation did not forward serial-worker flags and was also stopped. Neither is a pass. Running each existing workspace test command directly with one worker then completed: **1,369 passed, 1 skipped across all 16 test workspaces**, retaining their normal browser/E2E/pixel exclusions.

Python API/agent/integration tests excluding `slow` finished with **720 passed, 1 failed, 15 skipped, 8 deselected**. The failure was the real object-store upload lifecycle (`httpx.ReadTimeout`); after the user's resource change its isolated retry **skipped because MinIO was unavailable**. That is an unresolved service-dependent check, not a pass. Schema drift and the cross-language fixture validator passed.

The focused regression run: **42 passed, 3 failed** across six files, including the three new text/image witnesses and three positive controls. The separate canvas run: **12 passed, 2 failed**, retaining all original gesture tests plus two new live-preview witnesses. Counts overlap; do not add them into a unique-suite total.

The fresh desktop build succeeded and typecheck passed. Two cold-profile desktop motion attempts failed **before exercising motion** because the service was unavailable. A warm retry completed and returned `ok: true`, but MA-35 limits what that pass proves. Following the user's “try now,” a normal isolated launch and native clicks/drags reproduced MA-01/02/05 and verified basic transition selection. The test window was closed afterwards; its profile and screenshots remain as evidence. No real Claude Code/Codex host, paid cloud generation, Figma comparison, installed candidate, physical display, real IME, or new pixel baseline is certified by this review. The exposed API key was not used or stored.

The new witnesses are preserved as `.test.tsx.txt` under [audit evidence](audit-evidence/manual-authoring-2026-09-21/), with logs. They were removed from the normal test discovery paths after execution so this planning-only review does not silently change the application's default suite. To rerun, copy the selected witness into `packages/editor-ui/tests/` and invoke that file with one Vitest worker; remove the temporary copy afterwards.

## Exit decision

There are **35 actionable items**, deliberately divided into proven defects, source-confirmed inconsistencies, additional authoring controls and verification gates. This is not “35 reproduced bugs,” nor a percentage proving the rest of the application is complete.

Close the P1 defects and manual-authoring acceptance before final packaging sign-off. For P2 capabilities, implement them or explicitly agree a narrower beta scope. The live retry reproduced the user's direct-editing and PNG-drag failures; their fixes still need installed-candidate acceptance.

## Delivery status — 2026-09-25

Development build, Windows 11 x64. "Done" means code plus a regression test that exercises it; "trusted input" means the `authoring` desktop acceptance step drove it with Electron's input pipeline (`sendInputEvent` / `insertText`), not `click()` or `dispatchEvent`. Nothing here is evidence about the installed candidate.

| ID | Status | Evidence |
| --- | --- | --- |
| MA-01 | Done | `elementsFromPoint` hit (prior session); a click that moves ≤4px commits nothing. `canvas-gesture`, `manual-authoring-shell`; **trusted double-click opened text** |
| MA-02 | Done | `draggable={false}` on images, canvas prevents `dragstart`. **Trusted drag moved a pasted PNG (480,270 → 753,391) and one Ctrl+Z restored it** |
| MA-03, MA-04 | Done | Prior session; the review's witnesses pass as `canvas-gesture` tests |
| MA-05 | Done | Enter edits text / shape label, steps into a group, or says why not. `manual-authoring-shell`; trusted Enter in `authoring` |
| MA-06 | Done | `ungroupElements` (presentation-core): exact world geometry incl. rotation and uniform scale, container placements, card background kept, group-only references removed, one Undo regroups. Ctrl+Shift+G, inspector button and menu |
| MA-07 | Done | Inspector W/H go through `resizeOperations` |
| MA-08 | Done | `applyPlainTextEdit` splices the change; canvas editor also opens lists as lists and keeps block ids |
| MA-09 | Done | Shared `rich-dom.ts`; paste keeps allowed marks and lists, uses `insertHTML` for native Undo |
| MA-10 | Done | Blur mid-composition waits for `compositionend`; save/close/unmount commit the pre-composition text. **Real IME not exercised** |
| MA-11 | Done | Canvas text registers with `registerDraft`; unmount keeps typed words. Close/quit with the service offline **not re-run** for canvas text specifically |
| MA-12 | Done | Editable carries the element's world matrix |
| MA-13 | Done | `fitImageBox` fits both axes. **Also found and fixed:** uploads never recorded pixel size, so every picture used the 16:9 fallback box; `imageSize()` now measures before upload. Trusted run: 800×1200 PNG placed at 576×864 |
| MA-14 | Done | Text style presets, font, weight, italic, size, line/letter spacing, colour, alignment; canvas B/I/U/list toolbar keeps the caret |
| MA-15 | Done | Fill, outline colour/width/dash, radius, line markers and routing, icon colour. Text boxes are not offered a fill (the renderer does not paint one) |
| MA-16 | Done | Align ×6 and distribute ×2; to selection, or slide for one object; locked objects anchor and are reported |
| MA-17 | Done | Chart grid: values, categories, series add/remove/rename, spreadsheet paste, visible refusal of non-numbers, axis titles, legend and data labels. Trusted typed value reached the store |
| MA-18 | Done | Table cells, headings, rows, columns (widths rebalanced), range paste |
| MA-19 | Done | Diagram relabel, add box (optionally connected), remove, connect, reroute, edge labels, direction; ids stable |
| MA-20 | Done | Shape labels via double-click, Enter, or inspector |
| MA-21 | Done | Replace keeps id/placement/clips; keep-box or match-shape; alt text flagged for review |
| MA-22 | Done, narrowed | Focal-point repositioning for `cover` with an uncropped preview and reset; **PPTX `srcRect` now follows the focal point** (was always centred). The schema's rectangular `crop` field is still not drawn; the inspector says so when a picture carries one |
| MA-23 | Done | System clipboard via native `copy`/`cut`/`paste` events; objects carry their asset entries across decks; screenshots and image files upload; HTML/text become a text box; unsupported files refused by name; file drop places at the drop point. Trusted Ctrl+V of a system-clipboard PNG |
| MA-24 | Done | Slide menu "Transition in: …" opens it; first-slide explanation. Scaling at 125–200% **not checked** |
| MA-25 | Done | Two-slide preview through present mode's own `compileTransition` + `SlideTransition` (new controlled-time mode); scrub, Start/Middle/End, Play, reduced-motion preview. Midpoint styles asserted equal to present mode's |
| MA-26 | Done | Preview ends on leaving Motion, on starting text editing, on a press on the canvas, and via a visible "Back to editing" |
| MA-27 | Done | Pair preview outlines source and destination; "Remove broken pairs" repair |
| MA-28 | Partial | Manual controls exercised on generated-style content (groups, containers, charts, tables, diagrams, images). **The MCP create → revise → human edit journey was not run** in this pass |
| MA-29 | Done (dev build) | `authoring` step: blank deck → 5 slides (title, pasted PNG + caption, typed chart, relabelled diagram, summary) → fade → reorder + Undo → reopen → present → PDF. **24.9s**, 36 page requests, **0 model requests**. A target time is still to be agreed |
| MA-30 | Done earlier | Staged atomic migration, progress lines, 180s readiness (prior session); rehearsal tests pass |
| MA-31 | Open | Needs the final installer; trusted-input harness is ready (`authoring`, helpers now scroll before hit-testing) |
| MA-32 | Done for new surfaces | New fields commit on blur/Enter, so `commitFocusedDraft` covers them; canvas text via `registerDraft`; every control is one patch through `editor.apply` |
| MA-33 | Open | Physical IME, screen reader, high DPI and projector are the user's run. `a11y` (axe, light and dark) passes with the new controls |
| MA-34 | Open | Needs a signing certificate and the final payload |
| MA-35 | Done earlier | Trusted first-run dismissal (prior session); helpers now also scroll into view before the hit-test |

Test results for this pass: editor-ui 474, editor 124, presentation-core 68, export-pptx 54, renderer 159 (+5 skipped), animation-engine 174, desktop 129, web 3 (+4 skipped) — all passing; repo typecheck 0 errors; schema drift and fixture validation pass. Desktop acceptance on an isolated profile: open, edit, verify, slides, timeline, motion, morph, export, presenter, a11y, menu, authoring — all `ok: true`.

One test-isolation defect was found and fixed: several files install a fake `navigator.locks` that outlives them in a single-process run; `recovery-copies` now declares the lock environment it assumes.

## Follow-up pass — 2026-09-25 (after the pending-work review)

Development build, isolated profiles. Items the review listed, in its order:

| Item | Result |
| --- | --- |
| MA-11 canvas close/quit | **Done.** `close` / `close-verify` gained `DECKASTRA_SMOKE_CLOSE_FIELD=canvas`: a text box opened by a real double-click, typed with real input, never blurred. Seven variants, each on a fresh profile, all as required: window close and app quit with the service healthy and killed (text in the stored deck after relaunch); save and journal both broken (window stays open); and an IME composition left open via Chromium's `Input.imeSetComposition`, window and quit-offline — the words before the composition kept, the half-composed かな not saved. No stray processes afterwards. A *physical* IME is still MA-33 |
| MA-28 MCP handoff | **Done for the MCP protocol; real hosts still open.** New `handoff` step: agent access allowed through the window; `apps/mcp-server/scripts/handoff.mjs` drives the real stdio server with caller-authored operations only (headline, a card that is a group holding a rotated group with a labelled shape, chart, table, motion in roles; a destructive removal held **pending**, risk high). Then, with real input: headline retyped by double-click, card ungrouped (background kept), inner group entered and shape label edited, picture pasted and undone, chart value and table cell typed, the agent's pending change **refused with 409** because the deck moved, deck reopened, PDF and PPTX exported. A Claude Code or Codex *session* was not driven — the `deckastra` MCP connection was down in this session — and "no paid model call" rests on the route (`/proposals`) and `test_authored_proposals.py`, not billing telemetry |
| MA-34 / 11 release command | **Done.** `npm run release:win` (root and desktop): refuses without `CSC_LINK` and `DECKASTRA_SIGNING_PUBLISHER`, empties `release/`, builds with `DECKASTRA_RELEASE=1`, runs the strict gate on that output, writes `release/release-report.json`. `npm run package` stays the unsigned development build |
| MA-34 / 12 nested payload | **Done.** `scripts/verify-release.mjs`: one installer; current against the build *measured now* (payload hashes, source tree, migrations — not a possibly-stale manifest file); every worker/MCP/service file hashed per file with nothing added or missing (JS bundles checked by hash, not pretended-Authenticode); our three executables signed by the named publisher; any native file changed since the build must be validly signed; every native file in the tree inventoried. 12 tests incl. swapped service, tampered bundle, foreign signer, stale release, extra installer, missing notices. On the real unsigned output: report mode clean apart from the three unsigned executables of ours (69 of 103 native files already carry vendor signatures); strict mode refuses; a copy with a byte appended to the service and to the MCP bundle is refused. **Found by it:** 16 compiled `__pycache__` files ship in the service folder that the manifest did not name — fixed (payloads are hashed exactly as shipped) |
| MA-34 / 33 notices | **Done, with a decision left.** See release checklist §12. `langsmith` and `sqlite-vec` ship no licence file; a release build fails until the owner records a decision in `notices-review.json` |
| MA-24 scaling | Open — part of the MA-33 display session |
| MA-22 crop | Open — scope decision: implement rectangular crop, or accept focal-point-only for this beta |
| MA-29 target | Open — needs an agreed target time and people at the intended skill level |
| MA-31, MA-33, MA-34 signing | Open — installer, hardware and certificate |

Two product bugs the new steps found, both fixed with regression tests:

- **PowerPoint export dropped every chart, table and diagram** as a labelled box. Tables are now native `a:tbl`; charts and diagrams are drawn as shapes with editable text from the scene's resolved geometry, reported as `approximated` (not an editable PowerPoint chart). Verified in **PowerPoint itself** via COM: the file opens without repair, the table is a table with its cells, and exported slide images show pie, line chart, diagram and table as the editor draws them. python-pptx tests for table cells and diagram labels fail on the old adapter.
- **Exporter output was decoded as cp1252** on Windows, so the export panel showed "â€”" for every em dash, and a non-ASCII path would have reached the exporter garbled. UTF-8 both ways now (also the local model runtime's log); the regression test fails on the old code.

And one in the new Help item: menu commands chose their target from a list that included the notices window. They now use the same editor-window list the close barrier uses.
