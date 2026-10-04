/** Shared editor Design Check, callable by the API without a second geometry engine. */
import { readFileSync } from "node:fs";
import { buildDocumentScene } from "@deckastra/renderer";
import { PresentationDocumentSchema } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";
import { designCheck, fixOperations, fixAllOperations } from "../packages/editor-ui/src/lib/design-check";
import { localizeDocument } from "../packages/editor-ui/src/lib/locale-lens";

const input = JSON.parse(readFileSync(0, "utf8"));
const source = PresentationDocumentSchema.parse(input.document);
// Compare before and after in the same viewing language even before its first
// overlay exists. Otherwise adding an overlay changes font fallback across all
// slides and misattributes existing locale-preview findings to the translation.
const viewingSource = input.locale && !source.locales?.[input.locale]
  ? { ...source, locales: { ...source.locales, [input.locale]: { locale: input.locale, status: "draft" as const, entries: {} } } }
  : source;
const document = localizeDocument(viewingSource, input.locale ?? null);
const baseline = designCheck(document, buildDocumentScene(document));
const scoped = baseline
  .filter((finding) => (!input.slide_id || finding.slideId === input.slide_id)
    && (!input.scope || input.scope.kind === "deck" || input.scope.slide_ids.includes(finding.slideId))
    && (!input.scope || input.scope.kind !== "elements" || input.scope.element_ids.includes(finding.elementId)));
const findings = scoped
  .map((finding) => ({ ...finding, estimated: true, suggestedFix: finding.fix ? fixOperations(document, [finding.fix]) : [] }));
// Overlap fixes require a layout decision; leave these visible for review.
let operations = input.action === "fix_all" ? fixAllOperations(document, scoped, undefined, ["W110"])
  .filter((op) => !input.scope || input.scope.kind !== "elements"
    || input.scope.element_ids.some((id: string) => op.path.includes(`/id:${id}/`))) : [];
if (operations.length) {
  const identity = (f: typeof baseline[number]) => `${f.code}:${f.slideId}:${f.relatedElementId ? [f.elementId, f.relatedElementId].sort().join(":") : f.elementId ?? ""}`;
  const known = new Set(baseline.map(identity));
  const severe = new Set(["W103", "W104", "W110", "A102"]);
  const safe = (candidate: typeof document) => !designCheck(candidate, buildDocumentScene(candidate))
    .some((f) => !known.has(identity(f)) && (f.severity === "error" || severe.has(f.code)));
  if (!safe(applyPatch(document, operations).document)) {
    // Each element's changes stay together: applying half a resize is unsafe.
    const groups = new Map<string, typeof operations>();
    for (const operation of operations) {
      const key = operation.path.split("/transform")[0].split("/typography")[0];
      groups.set(key, [...(groups.get(key) ?? []), operation]);
    }
    let candidate = document;
    operations = [];
    for (const group of groups.values()) {
      const trial = applyPatch(candidate, group).document;
      if (safe(trial)) { candidate = trial; operations.push(...group); }
    }
  }
}
process.stdout.write(JSON.stringify({ findings, estimated: true, operations,
  ...(input.action === "fix_all" ? { baseline_findings: baseline } : {}) }));
