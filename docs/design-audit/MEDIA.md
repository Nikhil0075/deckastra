# Template pictures

Several design languages draw a frame for a photograph: Cinema Noir's image
frame, Quiet Luxe's portrait, Earth Story's arch, Spatial Future's hologram and
Play Lab's picture blob. A template can ship the picture that goes in it. This
page covers what may ship, how a picture is added, and where things stand.

## Status, 2026-10-10: the pipeline is built and no pictures ship

The plan was to generate the pictures with OpenArt. Before generating
anything, the terms were read:

> "For subscription levels at, and above, the 'Plus' level (as described on our
> pricing page), you may also freely use Output you generate for commercial
> purposes."

The account is on **Starter**, which the pricing page lists below Plus.
"Commercial use rights" appears on Plus and above. Pictures shipped inside a
product's templates are commercial use, so none were generated. The person
chose to build the pipeline now and add pictures later, either after upgrading
to a plan that allows commercial use or from another source with a licence that
permits it.

Evidence, kept so the decision can be checked:

| | |
| --- | --- |
| Terms | <https://openart.ai/terms>, retrieved 2026-10-10, SHA-256 of the page `00685fc4f42dc4bb56c5acb168e493e74d5fc593c93e1bf4cdb60b01c5c10fc2` |
| Pricing | <https://openart.ai/pricing>, retrieved 2026-10-10 |
| Account | Starter plan, 2,430 credits |

The page digest records what was read. It is not a copy of the page.

## What may ship

`apps/api/deckastra_api/preset_media.py` `problems()` checks the shipped
manifest on every API test run (`test_the_shipped_manifest_is_within_budget`).
It refuses:

- more than **30** pictures, or more than **12 MB** in total;
- any file that is not a **JPEG**, is over **400 KB**, or is over **1920px** on
  its long edge;
- a file whose SHA-256 differs from the one recorded at review, or whose
  recorded size is wrong;
- an entry without its provenance: `model`, `generatedAt`, the exact
  `prompt`, `sourceSha256` (the file as downloaded), and `alt` text;
- an entry without a review: `review.result: "approved"`, a named `reviewer`
  and a `date`;
- an entry without licence evidence: `license.commercialUse: true`, a `plan`
  that grants it, and the `termsUrl`, `termsRetrievedAt` and `termsSha256` of
  the terms it was made under;
- an entry that names no template and role (`hero` or `scene`).

JPEG, not WebP: PowerPoint does not open WebP, and the PPTX exporter refuses it
rather than embed a broken picture.

The release check (`apps/desktop/scripts/verify-release.mjs`) holds the
shipped folder to the same 30-file and 12 MB ceiling, and refuses a release
with no picture folder.

## How a picture reaches a deck

1. **Composition.** `template_compose.compose_template` composes the template,
   then `preset_media.attach` puts the template's pictures in the frames its
   language drew. Title slides take the `hero` picture and other slides the
   `scene`; either one stands in when the other is missing. The asset's storage
   key is `preset-media/<file>`. The geometry code never changes.
2. **Preview.** A template preview stores nothing, so its pictures are read
   from the build through `GET /v1/presets/media/{file}`. That route needs a
   signed-in caller and takes a file name the manifest lists, never a path.
   Both `object_storage.blob_url` and the client's `blobPath` map the key
   prefix to it.
3. **Creation.** `POST /v1/decks/from-template` copies each picture into the
   workspace (`preset_media.adopt`): the bytes go to the workspace's own
   storage, the asset is registered (which charges the storage quota), and the
   deck is rewritten to the new ids and keys. From then on the deck's pictures
   are ordinary assets. Exports, backups, the sweeper and sync need nothing
   new, and a deck never depends on a later build still shipping the file.

## Adding a picture

1. Make it under terms that allow commercial use, and save the terms page's
   URL, the date, and the page's SHA-256.
2. Export a JPEG at quality 82, 1920px or less on the long edge, and 400 KB or
   less. Name it `<language>-<template>-<role>.jpg`.
3. Look at it, then write its alt text.
4. Add an entry to `packages/deck-presets/media/MANIFEST.json` with every
   field above, then run `python -m pytest apps/api/tests/test_preset_media.py`.
5. Render the template's contact sheet and check the picture in its frames.

The frames that exist today, and their sizes, are listed in the unit 7b
pull request. Twenty-two pictures cover all sixteen templates that draw a
frame: one `scene` each, plus a `hero` for each Quiet Luxe and Earth Story
template.
