// Independent comparison path: call the actual editor measurer directly inside
// Chromium, without the worker's recording pass or cache.
// `measurer.ts` moved to `packages/editor-ui` when the editor was extracted
// (D0.2) and this path did not follow it, so every digest-parity case in this
// suite had been failing to *build* rather than to compare.
import { browserMeasurer } from "../../../packages/editor-ui/src/lib/measurer";
import { buildDocumentScene, documentDigest } from "@deckastra/renderer";

export function editorDigest(deck) {
  return documentDigest(buildDocumentScene(deck, { measurer: browserMeasurer() }));
}
