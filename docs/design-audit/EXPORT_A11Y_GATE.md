# Image-led export and accessibility gate

Item 8 of the image-led visual systems plan, 2026-10-14. Each requirement is
listed beside the tests that hold it. `apps/api/tests/test_export_gate.py`'s
`test_gate_map_names_real_tests` reads this file and fails if a cited test no
longer exists, so the map cannot quietly go stale.

The gate deck is `apps/api/tests/export_gate_deck.py`: one deck with layers
whose depth and reading order disagree, a transparent cut-out, masked and
treated pictures, picture-filled text, a bubble map, a scatter, an isometric
diagram, Hindi and Arabic. It is exported through the real worker CLI and read
back by pypdf, python-pptx and Pillow, which are independent of the code that
wrote the files.

## Automated checks

| Requirement | Held by |
| --- | --- |
| Canvas matches the exported PNG | `apps/worker/tests/gate.browser.test.ts::draws every slide on the canvas exactly as the export writes it` |
| PDF renders, with extractable text | `apps/api/tests/test_export_gate.py::test_pdf_pages_text_and_scripts` |
| PowerPoint reopens | `apps/api/tests/test_export_gate.py::test_pptx_reopens_with_its_slides` |
| Transparent PNGs stay transparent | `apps/api/tests/test_export_gate.py::test_pptx_cut_out_keeps_its_transparency_and_alt`, `apps/api/tests/test_export_gate.py::test_pptx_stores_a_mistyped_picture_as_what_it_is` |
| Mask geometry | `apps/api/tests/test_export_gate.py::test_pptx_masks_crop_natively_or_capture_with_alt`, `apps/api/tests/test_pptx_masks.py::test_an_arch_mask_is_custom_geometry_with_curves`, `apps/worker/tests/masks.browser.test.ts::shows the picture inside an arch and not in the corner it cuts away` |
| Picture-filled text stays editable | `apps/api/tests/test_export_gate.py::test_pptx_picture_filled_text_is_still_text` |
| Reading order follows the story, not depth | `apps/api/tests/test_export_gate.py::test_pdf_reads_in_story_order_not_depth`, `apps/worker/tests/gate.test.ts::puts the markup in story order, while the paint stays in depth order`, `apps/api/tests/test_export_gate.py::test_pptx_marks_decoration_and_says_how_it_reads` |
| Alt text stays on masked and cut-out pictures | `apps/api/tests/test_export_gate.py::test_pdf_keeps_every_description`, `apps/worker/tests/gate.test.ts::keeps the description on a masked, a treated and a cut-out picture`, `apps/api/tests/test_export_gate.py::test_pptx_charts_and_diagrams_carry_their_descriptions` |
| A name is not a description | `packages/renderer/tests/accessibility.test.ts::a picture with a name and no alt text is not described` |
| Hindi and Arabic | `apps/api/tests/test_export_gate.py::test_pptx_hindi_and_arabic`, `apps/api/tests/test_export_gate.py::test_pdf_pages_text_and_scripts`, `packages/renderer/tests/languages.test.tsx::runs one text box the way it says, whatever the deck's language` |
| Windows scaling 100–150%, narrow and wide editors | `apps/desktop/src/main/smoke.ts::ZOOMS` and `apps/desktop/src/main/smoke.ts::[1024, 640]`, run by the desktop `polish` step |

## Broken cases

None may fail an export, and none may degrade silently.

| Case | Held by |
| --- | --- |
| Missing mask path | `apps/worker/tests/gate.test.ts::draws a picture whose mask path is empty unmasked, and says so` |
| Missing cut-out asset | `apps/worker/tests/gate.test.ts::names a cut-out whose file did not arrive`, `apps/worker/tests/gate.browser.test.ts::draws a missing cut-out as a named placeholder and reports which it was` |
| Transparent asset with the wrong MIME type | `apps/worker/tests/gate.test.ts::stores a transparent PNG recorded as a JPEG as the PNG it is` |
| Picture-fill asset removed from the manifest | `apps/worker/tests/gate.test.ts::refuses text filled with a picture that has left the manifest, and keeps the words` |
| Blend mode PowerPoint does not have | `apps/worker/tests/gate.test.ts::reports a blend mode PowerPoint does not have as dropped` |
| Subject stacked below its background decoration | `apps/worker/tests/gate.test.ts::finds a subject stacked under the decoration meant to sit behind it` |

## What the gate found

Each finding was fixed, and each fix has a test that fails without it.

- **A picture's name stood in for its description.** PowerPoint's `descr`
  and WCAG 1.1.1 both accepted an element's name ("Picture 3") as alt text.
  The scene now records whether an element is `described`, from its
  `altText` alone.
- **The seed deck's diagram had no description.** That was hidden by the
  name standing in for it.
- **A PNG recorded as a JPEG** was written to PowerPoint as a `.jpeg` part.
  The bytes are now sniffed, and the report says the type was corrected.
- **Text filled with a picture missing from the manifest** passed
  validation. It is now E102.
- **The markup, and so the tagged PDF, was in depth order.** A screen reader
  met a cut-out subject or a foreground note before the headline. The markup
  is in story order now, and each object keeps its depth as its z-index.
- **PowerPoint reads in layer order**, which is a slide's look and cannot
  also be its story. Decorations carry Office's own decorative mark. Where
  layering reverses the story, the report says so.
- **Two descriptions never reached the PDF.** Chromium leaves an image drawn
  through an SVG filter inside a masked wrapper out of the tag tree, so a
  picture with a duotone and a vignette lost its description. A diagram's
  description reached only an unlabelled wrapper. Both are now `role="img"`
  with the label.
- **A text box's own `direction` was ignored.** The schema has carried it
  since v1, and the scene read only the deck's language. An Arabic box in an
  English deck therefore ran left to right on the canvas, in the PDF and in
  PowerPoint. PowerPoint paragraphs now carry `rtl="1"`, and runs carry the
  deck's language instead of a fixed `en-US`.
- **A missing cut-out folded into another picture's line** in the PowerPoint
  report, which keeps one line per feature and slide. It now has a line of its
  own.
