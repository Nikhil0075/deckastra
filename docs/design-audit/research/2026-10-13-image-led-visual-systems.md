# Image-led visual systems — implementation research

The V2 structural catalogue solved layout repetition, but a strong layout still
looks generic when the image, typography and data behave as unrelated boxes.
The next quality bar is **art-directed composition**: one dominant visual
metaphor per slide, with editable information attached to that metaphor.

## Evidence used

- Microsoft recommends at least fifteen visibly different layouts, multiple
  alternatives for common slide purposes, edge-reaching pictures, and testing
  with arbitrary and long content. It also recommends light and dark overlay
  alternatives for images:
  <https://support.microsoft.com/en-au/powerpoint/creating-custom-templates-that-work-well-with-designer-in-powerpoint>
- Microsoft Designer describes cohesive layouts and specifically treats
  photo-driven title slides as a normal high-quality composition:
  <https://support.microsoft.com/en-us/powerpoint/create-professional-slide-layouts-with-designer>
- Apple defines materials as a depth and hierarchy system, not a translucent
  decoration. Blur, vibrancy, material thickness and backdrop dimming work
  together, and glass should be used selectively:
  <https://developer.apple.com/design/human-interface-guidelines/materials>
- Fluent 2 separates acrylic (frosted, translucent), mica (opaque, subtly
  tinted) and smoke (a dimming separation layer). That distinction is useful
  for presentation depth as well as application UI:
  <https://fluent2.microsoft.design/material>
- Material 3 Expressive combines vibrant colour, contrasting shapes, flexible
  display typography and expressive motion. Display styles are for short,
  important text and numerals; tabular numbers remain appropriate for data:
  <https://m3.material.io/get-started>,
  <https://m3.material.io/styles/typography/applying-type>,
  <https://m3.material.io/styles/motion>

## Production rules

1. **One metaphor, many native layers.** A photograph or illustration carries
   the scene; headlines, milestones, labels, charts and diagrams stay editable.
2. **Images are commissioned for the layout.** Prompts specify text-safe areas,
   camera direction and where the information will sit. Cropping is not left to
   chance.
3. **Numbers may occupy the scene.** Big-number slides use scale, overlap and
   background imagery; the number is not placed inside a metric card.
4. **Journeys follow a real path.** Timeline markers attach to a road, ridge,
   orbit, river or process line rather than floating along a generic rule.
5. **Product explanation pairs evidence and editability.** A detailed product
   render supplies physical understanding while a native diagram supplies
   accessible relationships and exportable labels.
6. **Glass has thickness.** A glass plane requires a blurred backdrop,
   translucent body, specular rim, inner highlight, outer shadow and a visible
   light source behind it. Multiple planes must have different depth.
7. **Playful means kinetic, not merely rounded.** It uses oversized type,
   primary colour contrast, diagonal movement, cropped subjects and expressive
   motion; functional text still uses restrained motion and readable body type.
8. **Every image is unique to its narrative beat.** Reuse is acceptable for a
   continuous background system, not as a shortcut for unrelated slides.
9. **Release provenance stays explicit.** Generated media remains a candidate
   until a person reviews the contact sheet. A test build may show candidates;
   a release build must reject them.

## First implementation

The AsterLoop flagship now uses seven purpose-built images: industrial opening,
emissions context, mountain scale journey, exploded thermal module, industrial
comparison, operator portrait and Earth-scale closing. The chart and thermal
architecture remain native. Play Lab now uses an electric cobalt/yellow/coral
system, an action photograph and oversized split display type. Spatial Future's
glass planes now use blur, saturation, highlight rims, inner and outer shadows,
and staggered depth layers.

## Depth and masking audit after the first render

The first AsterLoop/Play Lab render exposed two different requirements that must
not be confused:

- **Picture-filled type is a text capability.** PowerPoint supports a picture as
  the fill of slide text/WordArt, and CSS supports the same composition with
  `background-clip: text`. Deckastra now models this as `TextElement.pictureFill`
  and keeps the text editable in the canvas, PDF and PowerPoint.
  <https://support.microsoft.com/en-gb/office/graphics-visuals/add-or-delete-a-fill-outline-or-effect-for-text-or-wordart>
  <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-clip>
- **Subject depth is a layer capability.** PowerPoint exposes front/back ordering
  explicitly. The Play Lab source photograph already placed the runner in front
  of its yellow ring; a redundant Deckastra foreground ellipse broke that order,
  so the duplicate ornament was removed.
  <https://support.microsoft.com/en-us/powerpoint/training/layer-objects-on-slides>

Before the eight exact visual systems are packaged, the remaining reusable
capability gaps are:

1. Arbitrary media masks (custom path, arch, torn edge and compound geometry),
   rather than only rectangular crops with corner radii. **Done 2026-10-13:**
   named, custom, inverted, turned and compound masks draw identically on the
   canvas, in thumbnails, in the PDF (an alpha soft mask) and in PowerPoint (a
   preset or custom-geometry crop, or a reported cut-out picture); see
   CLAUDE.md, "Image masks".
2. Transparent subject cutouts/foreground mattes so a person or product can sit
   between editable decorative layers without baking the whole slide into one
   image.
3. Image treatments as native, reversible properties: monochrome, duotone,
   exposure/contrast, blend mode and film grain/material texture.
4. Geographic/bubble-map and scatter primitives for Data Desk; current native
   charts cover the common business chart families but not its map composition.
5. Perspective/isometric diagram helpers for System Terminal's exploded wireframe
   and Spatial Future's orbital/volumetric scenes.
6. Editor controls for text picture fill, media masks and subject layers. The
   document/renderer/export capability now exists for picture-filled type, while
   the current flagship binds it from reviewed template media.

These are engine features, not agent-prompt geometry. The eight language packs
should consume them after they are stable, with each pack retaining editable
text, charts and diagrams and using generated imagery only for the visual scene.
