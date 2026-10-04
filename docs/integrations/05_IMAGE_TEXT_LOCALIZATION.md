# 05 — Translating the text inside images

Status: plan, 2026-10-01. Nothing here is built.
Depends on: [01](01_MULTILINGUAL_DECKS_NARRATION_AND_SOUND.md) (locale
overlays, script fonts), [04](04_GOOGLE_CLOUD_PLATFORM.md) (Vision, Vertex,
Cloud Run). Optional: [02](02_GEMMA_ADK_ASSISTANT.md) (Gemma for style
analysis on device).

## 1. What is being asked

The target, from the mockup provided (2026-10-01): a Portuguese pizza poster and
a Spanish travel poster become Hindi versions where **only the letters change**.
The photograph, icons, the red CTA button, the yellow brush-stroke banner,
colours, positions, rotation and weight stay. Line breaks and word order change
to suit the language.

And it must be **affordable in 20 languages**.

## 2. The cost question, answered

**Nothing regenerates the image per language.** The work splits in two:

```
ONCE per image (does not depend on language)        PER language (text only)
────────────────────────────────────────────        ────────────────────────
1. OCR: text, boxes, polygons                       4. Translate a few words
2. Style: colour, weight, rotation, role, font      5. Fit them into the box
3. Remove the letters → a clean plate image          6. Draw them (in the viewer)
```

For one image in 20 languages (approximate; check current prices):

| Step | Times | Approximate cost |
| --- | --- | --- |
| Cloud Vision OCR | 1 | ~$1.50 per 1,000 images |
| Style analysis (pixel code; optionally one Gemini/Gemma call) | 1 | fractions of a cent, or free on device |
| Text removal (OpenCV, or LaMa on our own Cloud Run) | 1 | compute only; no per-call fee |
| Translation (~100 characters × 20) | 20 | ~$0.04 with Cloud Translation |
| Drawing | 0 on the server | the browser or exporter draws text |

**A few cents per image for all 20 languages.** Switching language afterwards is
free, and cached analysis is reused across decks by content hash.

## 3. Assessment of the proposed "LIR" design

The pasted design is workable and matches this product closely.

| Proposal | Verdict |
| --- | --- |
| Keep text as a separate layer, render in the client (§1, §5, §20) | **Yes.** A Deckastra group of `[image, text, text…]` *is* that format. Locale overlays (01) are the `translations` map. No new file format is needed. |
| No LLM needed for OCR and MT (§2) | True. OCR + Cloud Translation, or IndicTrans2/NLLB self-hosted, covers it. An LLM adds better *transcreation* and fitting, on text only. |
| Capture geometry and style, not only text (§3) | **Yes, and OCR does not give style.** Style comes from pixel analysis (§5.3). |
| Mode A: creator-aware images are nearly free (§4) | **Already true in Deckastra.** Designs made in the editor keep text as elements, so only overlays are needed. |
| "Leave the original image unchanged, draw on top" (§1) | **Only with an opaque box** (§8), which covers banners and textures. The mockup needs the letters removed, **once**. |
| Deterministic fit loop (§9) | Already exists: shrink-to-fit with the browser measurer. |
| Font class → Unicode-capable family (§10) | Yes. The mapping table is §5.6. |
| Cache by hash, perceptual hash (§12–13) | Yes, by sha256 of the bytes; perceptual hash (dHash) to reuse analysis across re-uploads. |
| Browser extension for Instagram, SDKs (§6, §14, §16) | Workable in principle, but **a separate product**, with platform terms and cross-origin pixel access problems. Out of scope here. |

## 4. Discovery: what exists

| Fact | Where |
| --- | --- |
| Image element (`assetId`, `fit`, `focalPoint`, `altText`), groups, container layouts | `presentation-schema/src/elements.ts` |
| Text elements: rich text, `rotation` on the transform, `letterSpacing`, shrink-to-fit | `elements.ts`, `text.ts:107` |
| **No text stroke or text shadow on text styles** (check before relying on outlined text) | `text.ts` |
| Uploads measure image size first; assets carry width and height | `lib/insert-image.ts`, `db/models.py:813` |
| Asset bytes readable server-side (local or S3) | `object_storage.read()` |
| Proposal cards draw Before/After with `FinalFrameSlide` | `components/ProposalsPanel.tsx`, `lib/proposal-preview.ts` |
| Design Check contrast composites every layer under text; a picture beneath text is W218 "cannot be measured" | `renderer/src/layout-check.ts` |
| PPTX writes pictures and editable text boxes | `export-pptx/src/media.ts`, `shapes.ts` |
| Fonts: 16 Latin-only families | `renderer/src/font-library.ts` |

## 5. The pipeline

### 5.1 Stage 1: detection (Cloud Vision)

`DOCUMENT_TEXT_DETECTION` on the original bytes gives pages → blocks →
paragraphs → words → symbols, each with a polygon and a confidence, plus a
detected language per block.

- Keep the **polygons**, not only rectangles (tilted text: the travel banner).
- Rotation per line = the angle of the polygon's baseline edge.
- Language hints: none by default. Record the detected language per block.

### 5.2 Stage 2: grouping into semantic blocks

OCR blocks are not design blocks: "EXPLORA / EL MUNDO" is one headline on two
lines, and each bullet label is two lines under an icon.

1. **Code first:** merge lines with a similar height (±15%), a similar colour
   (ΔE < 12), aligned left edges or centres, and vertical gaps < 0.6 × line height.
2. **Model second (optional, once):** send the image (≤ 1024 px) plus the
   numbered line boxes to Gemini (Vertex) or Gemma 4 E4B (image input, see 02)
   with a structured-output schema:
   ```json
   { "blocks": [ { "lines": [3,4], "role": "headline|subhead|label|cta|body|brand|price",
                   "fontClass": "script|display-heavy|condensed-sans|sans|serif|mono",
                   "case": "upper|title|sentence", "translate": true } ] }
   ```
   Validate with Pydantic, and repair once, as `ask_model` does. A brand name or
   logo text gets `translate: false`.

### 5.3 Stage 3: style per block (pixel code, deterministic)

Inside each block's polygon (OpenCV and NumPy, in the imaging service):

- **Text colour vs local background:** k-means (k = 3) in Lab over the pixels.
  The text cluster is the one whose pixels form thin strokes (distance transform)
  rather than area.
- **Weight:** median stroke width ÷ x-height (from the distance transform),
  mapped to 300–900.
- **Size:** cap height from line polygons, converted to slide units.
- **Slant:** dominant vertical-stroke angle (Hough lines), mapped to italic or
  none (and skew, if the schema later supports it).
- **Alignment:** block lines' left, centre and right edge variance.
- **Background under the block:** flat, gradient, or texture (variance in a
  ring around the mask). This decides the removal method.

### 5.4 Stage 4: glyph mask and removal (the clean plate)

- **Mask = pixels in the text cluster** inside each block polygon, dilated by
  2–3 px to include anti-aliasing. This keeps the yellow banner and removes only
  the black letters on it.
- **Removal:**
  - flat or gradient background → OpenCV `inpaint` (Telea), in milliseconds;
  - texture or photograph → **LaMa** (open source, big-mask inpainting),
    CPU-capable, faster on a GPU;
  - failure or low confidence → fallback **card mode**: keep the original image
    and put an opaque rounded card in the sampled background colour behind the
    new text (the design's §8). The proposal says which mode was used.
- **Output:** a new PNG or WebP asset (the plate), same pixel size as the source.

### 5.5 Stage 5: build the Deckastra layers (one proposal)

The image element is replaced by a group, in **one patch**:

```
group "Localized: <filename>"          metadata.localizedImage = {
 ├─ image  plate asset (same frame)       sourceAssetId, analysisId, mode: "plate"|"card" }
 ├─ text   headline   font, weight, colour, rotation, align, fit: shrink
 ├─ text   subhead
 ├─ text   label ×3
 └─ text   CTA label
```

- **Coordinates** are block boxes mapped from image pixels to the element's
  frame. They account for the element's `fit`/`focalPoint` crop: for `cover`,
  compute the source rect first; text outside the visible crop is dropped and
  reported.
- The **source language is also redrawn** from the OCR text, so every language,
  including the original, renders the same way. The source-language strings go
  into the text elements; other languages go into locale overlays (01).
- **"Show original"**: an action that swaps the group back to a single image of
  `sourceAssetId` (one patch, with undo). The original asset is never deleted
  while the group cites it in metadata. Add that metadata path to asset
  reference counting (`assets.referenced_ids`), or the sweeper will collect it.
- It is a **proposal**: the Before/After card already shows exactly the mockup's
  layout. The person approves it, then corrects any text box by hand.

### 5.6 Stage 6: translation and fitting

- Uses 01's translation service with each block's **character budget** and role
  ("CTA: imperative, ≤ 16 characters"). `translate: false` blocks are left out.
- Line breaks: allow the translation to choose its own breaks (the mockup's
  "दुनिया को / एक्सप्लोर करें").
- Fit is the renderer's shrink-to-fit, with a floor (for example 60% of the
  source size). Below the floor, request the short alternative. Past that,
  Design Check reports W103.

**Font mapping (per script; all OFL):**

| fontClass | Latin (source redraw) | Devanagari | Bengali | Tamil | Arabic |
| --- | --- | --- | --- | --- | --- |
| script | Caveat | Kalam, Yatra One | Galada | Noto Sans Tamil | Aref Ruqaa |
| display-heavy | Archivo Black, Bebas Neue | Baloo 2 ExtraBold, Rozha One | Baloo Da 2 | Baloo Thambi 2 | Noto Kufi Arabic Black |
| condensed-sans | Bebas Neue | Khand, Teko | Hind Siliguri | Hind Madurai | Noto Sans Arabic Condensed |
| sans | Inter | Noto Sans Devanagari, Mukta | Noto Sans Bengali | Noto Sans Tamil | Noto Sans Arabic |
| serif | Lora | Noto Serif Devanagari | Noto Serif Bengali | Noto Serif Tamil | Noto Naskh Arabic |

Kept as data in `renderer/src/script-fonts.ts`; the fonts ship as language packs
(04 §4). Rules from 01 §3.9 apply (no uppercase, no synthetic italic, line height
for Indic, RTL).

## 6. Where the code goes

### 6.1 Imaging service (new): `apps/imaging/`

Heavy dependencies (OpenCV, NumPy, Pillow, PyTorch for LaMa) do **not** belong in
the API or in the desktop sidecar, which the project fought down to 103 MB.

```
apps/imaging/
  imaging/
    main.py        FastAPI: POST /analyze  (bytes → blocks, styles, masks)
                   POST /plate    (bytes + mask → plate bytes, mode)
    style.py       colour clustering, stroke width, slant, alignment
    mask.py        glyph masks per block
    inpaint.py     telea | lama (lazy-loaded) | card fallback
  Dockerfile       CPU image; optional GPU variant
  tests/           golden images: flat, gradient, texture, banner, tilted
```

It has a narrow JSON contract, the same pattern as the export worker. It is
stateless, receives bytes, returns bytes and JSON, and has no database access.

### 6.2 API: `apps/api/deckastra_api/image_localize.py` (new)

- `POST /v1/presentations/{id}/elements/{elementId}/localize-image`
  `{expected_version_id, target_locales?: [...], mode?: "auto"|"plate"|"card"}`:
  1. resolve access (editor);
  2. read the asset bytes (`object_storage.read`), scoped to the presentation's
     workspace, like `inline_for_render`;
  3. look up the cache: `image_analyses` by `sha256` (and `phash` near match);
  4. otherwise call Vision → group → imaging `/analyze` → `/plate`;
  5. register the plate as an asset (existing `assets.register`);
  6. build operations (§5.5) plus overlay entries for `target_locales` (01);
  7. `create_proposal(...)` with the expected version. Risk is computed from the
     operations.
- It runs as a **background job**: a row in a new `image_localization_jobs` table,
  polled like exports, with cancel. OCR plus LaMa can take seconds to tens of
  seconds.
- Quotas: count analyses per workspace. Cached hits are free.

### 6.3 Database (one revision)

```
image_analyses(id, workspace_id, source_sha256, source_phash, width, height,
               ocr_json, blocks_json, plate_asset_id, mode, provider_versions,
               created_at)      UNIQUE(workspace_id, source_sha256)
image_localization_jobs(id, presentation_id, element_id, status, progress,
               error, proposal_id, created_by, created_at, …)
assets.sha256, assets.phash   (shared with 02)
```

The cache is **per workspace**, not global: another workspace's analysis would
reveal what it uploaded.

### 6.4 Editor

- The image inspector section (`components/inspector/*`) gets **Localize
  text in image…** with target languages and an "auto / clean plate / card"
  choice.
- Progress in the AI panel; the result in Pending changes with Before/After.
- The group gets a small "Localized image" chip and **Show original / Show
  localized** in its inspector.
- Editing any text layer is ordinary text editing, per locale (01).

### 6.5 Contracts, client, MCP

- `workspace-contracts/src/imaging.ts`: job and result shapes.
- `workspace-client`: `client.images.localize()` and job polling.
- MCP: `image_localize` `{presentation_id, element_id, expected_version_id}`
  starts the job (write scope); the result is a proposal like everything else.

### 6.6 Exports

- PDF: plate + text is simply rendered.
- PPTX: plate as a picture + **editable text boxes**, which is better than the
  original flat image. Fonts are named, not embedded; the report says so per family.

## 7. Quality gates

A golden set of 20 posters (flat, gradient, photo texture, banner, tilted, two
scripts) in `apps/imaging/tests/golden/`, with checks:

- OCR recall ≥ 95% of hand-labelled words;
- the plate's residual text: re-run OCR on the plate and expect no words found
  inside the masks;
- colour: ΔE between the detected text colour and the labelled colour < 10;
- geometry: IoU between the rendered source-language redraw and the original
  text boxes > 0.8;
- an end-to-end pixel test in the worker, the same style as
  `assets.browser.test.ts`.

## 8. Known limits (state them in the product)

- Exact font identity is not matched, only its class.
- Distressed or textured fills inside letters (the "PIZZA" grain), curved text,
  3D or perspective text, and text over faces are either approximated or left to
  card mode.
- Text outlines and shadows need a schema addition (`textEffects`) before they
  can be reproduced.
- Very small text (< 12 px in the source) is skipped and reported.

## 9. Phasing

| Phase | Scope | Estimate |
| --- | --- | --- |
| A | Vision OCR + code grouping + card mode + overlay translation, end to end with a proposal | 3 days |
| B | Imaging service: style analysis, glyph masks, Telea + LaMa plate | 3–4 days |
| C | Optional model grouping (Gemini/Gemma), font mapping + packs, caching | 2 days |
| D | Golden set, quality gates, PPTX check, MCP tool | 2–3 days |

**For the hackathon, this is the strongest demo:** A + B on 5–10 chosen posters,
with a language switcher. It is visual, needs no explanation, and every step
runs on Google Cloud.

## 10. Beyond Deckastra (not in this plan)

A browser extension (overlaying cached layers on web images) and an SDK
(`<LocalizedImage>`) reuse the same analysis JSON. They are separate products
with their own legal and platform questions.
