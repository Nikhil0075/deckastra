# Template pictures

Several design languages draw a frame for a photograph: Cinema Noir's image
frame, Quiet Luxe's portrait, Earth Story's arch, Spatial Future's hologram and
Play Lab's picture blob. A template can ship the picture that goes in it. This
page covers what may ship, how a picture is added, and where things stand.

## Status, 2026-10-11: 22 commercial-release images approved

All 22 OpenArt Starter demo pictures have been replaced. The current set was
generated with OpenAI image generation through Codex. The official OpenAI
Terms of Use say that, as between the user and OpenAI and to the extent
permitted by applicable law, the user owns Output and OpenAI assigns any right,
title and interest it has in that Output to the user.

That provider evidence is necessary but not sufficient for release. The terms
also put responsibility for the content and appropriate human review on the
user. The files have now passed both the agent inspection and the product
owner's review:

- every entry records `license.provider: "OpenAI"`, commercial use, the exact
  terms URL and retrieval fingerprint;
- every entry records the exact prompt, source PNG checksum and delivered JPEG
  checksum;
- agent inspection checked watermarks, logos, legible text, public figures,
  anatomy, composition and design-language fit;
- the product owner reviewed the 22-image contact sheet and approved the set;
- every entry records that decision as `review.by: "person"`, so both
  `problems(release=True)` and `apps/desktop/scripts/verify-release.mjs` accept
  the media review evidence.

| | |
| --- | --- |
| Terms | <https://openai.com/policies/row-terms-of-use/>, retrieved 2026-10-11; normalized retrieved-text SHA-256 `003722930ecfc18be07390656ae93d6c40189231f6abc2d135590db619688e3b` |
| Model | OpenAI image generation through Codex, text-to-image |
| Pictures | 22, 4.68 MB in all (largest 374 KB), 1600px on the long edge, JPEG quality 79–82 |
| Review | Codex inspected every image; the product owner approved all 22 from the contact sheet on 2026-10-11. Recorded as `by: "person"`. |

The release-review contact sheet is
`concepts/unit10-release-media/contact-sheet.jpg`. The earlier OpenArt demo
audit remains in `concepts/unit7b-media/` as historical evidence only.

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
- an entry without provider-specific licence evidence:
  `license.commercialUse: true`, a provider and plan/workflow accepted by the
  validator, plus `termsUrl`, `termsRetrievedAt` and `termsSha256`;
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

1. Make it under terms that allow commercial use, and save the provider, terms
   URL, retrieval date and a reproducible fingerprint of the retrieved terms.
2. Export a JPEG at quality 82 (lower only as needed for the ceiling), 1920px
   or less on the long edge, and 400 KB or less. Name it
   `<language>-<template>-<role>.jpg`.
3. Look at it, then write its alt text.
4. Add an entry to `packages/deck-presets/media/MANIFEST.json` with every
   field above, then run `python -m pytest apps/api/tests/test_preset_media.py`.
5. Render the template's contact sheet and check the picture in its frames.

The frames that exist today, and their sizes, are listed in the unit 7b
pull request. Twenty-two pictures cover all sixteen templates that draw a
frame: one `scene` each, plus a `hero` for each Quiet Luxe and Earth Story
template.
