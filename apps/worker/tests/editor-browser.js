// Independent comparison path: call the actual editor measurer directly inside
// Chromium, without the worker's recording pass or cache.
import { browserMeasurer } from "../../web/lib/measurer";
import { buildDocumentScene, documentDigest } from "@deckastra/renderer";

export function editorDigest(deck) {
  return documentDigest(buildDocumentScene(deck, { measurer: browserMeasurer() }));
}
