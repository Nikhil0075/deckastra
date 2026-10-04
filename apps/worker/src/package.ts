import { createHash } from "node:crypto";
import { createZip, type ZipEntry } from "@deckastra/export-core";
import { serializeDocument, MYDECK_LIMITS, type PresentationDocument } from "@deckastra/presentation-schema";
import type { InlineAsset } from "./assets";

export const MYDECK_MIME = "application/vnd.deckastra.mydeck+zip";

/** One canonical serializer and one deterministic ZIP writer for exchange files. */
export function packageDeck(source: PresentationDocument, supplied: InlineAsset[], extras: Record<string, string> = {}) {
  const document = structuredClone(source);
  for (const key of ["provenance", "criticIssues", "history", "shareLinks"]) delete document[key];
  const assets = new Map(supplied.map(a => [a.assetId, a]));
  const entries: ZipEntry[] = [];
  const files: Record<string, unknown>[] = [];
  let total = 0;
  function add(path: string, data: Uint8Array, contentType: string, metadata: Record<string, unknown> = {}) {
    total += data.length;
    if (data.length > MYDECK_LIMITS.assetBytes || total > MYDECK_LIMITS.totalBytes || entries.length + 3 > MYDECK_LIMITS.entries) throw new Error("M003: Package size limit exceeded.");
    entries.push({ path, data, maxRatio: MYDECK_LIMITS.compressionRatio });
    files.push({ path, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, contentType, ...metadata });
  }
  const cited = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["assetId", "asset_id"].includes(key) && typeof child === "string") cited.add(child);
      else visit(child);
    }
  }
  visit(document);
  for (const asset of document.assets) cited.add(asset.id);
  for (const id of [...cited].sort()) {
    const payload = assets.get(id);
    if (!payload?.data || payload.problem) throw new Error(`M010: Asset ${id} is unavailable; this package would be incomplete.`);
    if (!/^ast_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("M004: Invalid asset identifier.");
    const data = Buffer.from(payload.data, "base64");
    const ref = document.assets.find(a => a.id === id);
    const contentType = payload.mimeType ?? ref?.mimeType ?? "application/octet-stream";
    const path = `assets/${id}`;
    if (ref) { ref.storageKey = path; ref.byteSize = data.length; }
    add(path, data, contentType, { assetId: id, ...(ref?.width ? { width: ref.width } : {}), ...(ref?.height ? { height: ref.height } : {}) });
  }
  add("document.json", Buffer.from(serializeDocument(document)), "application/json");
  for (const [path, encoded] of Object.entries(extras).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith("extras/") || path.split("/").some(p => ["", ".", ".."].includes(p)) || /[\\:\x00]/.test(path)) throw new Error("M004: Unsafe extra path.");
    add(path, Buffer.from(encoded, "base64"), "application/octet-stream");
  }
  const manifest = { format: "mydeck", formatVersion: 1, schemaVersion: document.schemaVersion,
    presentationId: document.id, title: document.metadata.title, createdBy: { app: "Deckastra", version: "0.10.0" },
    createdAt: document.updatedAt, locales: [document.metadata.language ?? "en", ...Object.keys(document.locales ?? {}).sort()], files };
  const bytes = createZip([{ path: "mimetype", data: MYDECK_MIME, stored: true },
    { path: "manifest.json", data: JSON.stringify(manifest), maxRatio: MYDECK_LIMITS.compressionRatio },
    ...entries.sort((a, b) => a.path.localeCompare(b.path))]);
  return { bytes, filename: "deck.mydeck", contentType: MYDECK_MIME, report: { warnings: [], degraded: false } };
}
