/**
 * Uploading a font (Design tab review, 2026-09-26).
 *
 * A font someone uploads is named by the file itself: its `name` table says
 * what family it is, and that is the name a deck must use to ask for it. Read
 * here, in the browser, for TrueType and OpenType (uncompressed sfnt); a WOFF or
 * WOFF2 file is compressed and its name comes from the file name instead, which
 * the person can see and change.
 *
 * The upload and the deck's use of it are one patch: the manifest entry that
 * declares the face and, when a text box asked for it, the text's new font. So
 * the font can never be in the deck without being declared, and Undo removes
 * both.
 */

import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

export const FONT_TYPES: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** Fonts are small; anything this size is not one a slide needs. */
export const MAX_FONT_BYTES = 12 * 1024 * 1024;

export interface FontInfo {
  family: string;
  /** Whether the family came from the file rather than its name. */
  fromFile: boolean;
  weight?: string;
  style?: "normal" | "italic";
}

/** The family, weight and style a font file declares, as far as it can be read here. */
export async function readFontInfo(file: Blob & { name?: string }): Promise<FontInfo> {
  const fallback = familyFromName(file.name ?? "Uploaded font");
  try {
    const bytes = new Uint8Array(await readBytes(file));
    const tag = String.fromCharCode(...bytes.slice(0, 4));
    // 0x00010000 is TrueType; "OTTF" is OpenType with CFF outlines; "true" is
    // an old Apple TrueType. Anything else (wOFF, wOF2) is compressed.
    const sfnt = tag === "\u0000\u0001\u0000\u0000" || tag === "OTTO" || tag === "true";
    if (!sfnt) return fallback;
    const names = nameTable(bytes);
    // Typographic family (16) where a font has one, so "Acme Sans Bold" is
    // family "Acme Sans"; otherwise the legacy family (1).
    const family = (names.get(16) ?? names.get(1))?.trim();
    const subfamily = (names.get(17) ?? names.get(2) ?? "").toLowerCase();
    if (!family) return fallback;
    return {
      family: family.slice(0, 120),
      fromFile: true,
      style: subfamily.includes("italic") || subfamily.includes("oblique") ? "italic" : "normal",
    };
  } catch {
    return fallback;
  }
}

function familyFromName(fileName: string): FontInfo {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  const family = base
    .replace(/[-_]+/g, " ")
    // "Acme-SemiBold-Italic" names a style, not a family.
    .replace(/\b(thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|variable|vf)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return { family: (family || base || "Uploaded font").slice(0, 120), fromFile: false };
}

/** The strings of an sfnt `name` table, by name id, preferring Windows Unicode English. */
function nameTable(bytes: Uint8Array): Map<number, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = view.getUint16(4);
  let offset = -1;
  for (let index = 0; index < tables; index += 1) {
    const at = 12 + index * 16;
    if (String.fromCharCode(...bytes.slice(at, at + 4)) === "name") offset = view.getUint32(at + 8);
  }
  const out = new Map<number, string>();
  if (offset < 0) return out;
  const count = view.getUint16(offset + 2);
  const strings = offset + view.getUint16(offset + 4);
  const rank = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const record = offset + 6 + index * 12;
    const platform = view.getUint16(record);
    const language = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const start = strings + view.getUint16(record + 10);
    const score = platform === 3 && language === 0x409 ? 3 : platform === 3 ? 2 : platform === 0 ? 1 : platform === 1 ? 0 : -1;
    if (score < 0 || score <= (rank.get(nameId) ?? -1)) continue;
    const raw = bytes.slice(start, start + length);
    let text = "";
    if (platform === 1) {
      text = String.fromCharCode(...raw);
    } else {
      for (let at = 0; at + 1 < raw.length; at += 2) text += String.fromCharCode((raw[at]! << 8) | raw[at + 1]!);
    }
    rank.set(nameId, score);
    out.set(nameId, text);
  }
  return out;
}

function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

/** The extension's font type, or undefined for a file that is not a font. */
export function fontTypeOf(fileName: string): string | undefined {
  return FONT_TYPES[fileName.split(".").pop()?.toLowerCase() ?? ""];
}

/**
 * Upload a font and produce the manifest entry that declares it. The caller
 * adds its own use of the family to the same patch.
 */
export async function uploadFont(
  client: Pick<WorkspaceClient, "assets" | "session">,
  input: { document: PresentationDocument; file: File },
): Promise<{ operations: PatchOperation[]; family: string; fromFile: boolean }> {
  const type = fontTypeOf(input.file.name);
  if (!type) throw new Error("That is not a font file. Use a .ttf, .otf, .woff or .woff2 file.");
  if (input.file.size > MAX_FONT_BYTES) throw new Error("That font file is larger than 12 MB, which no slide font needs.");

  const info = await readFontInfo(input.file);
  const already = input.document.assets.some(
    (candidate) => candidate.type === "font" && (candidate as { fontFamily?: string }).fontFamily === info.family,
  );
  // The same family uploaded twice is used, not stored twice.
  if (already) return { operations: [], family: info.family, fromFile: info.fromFile };

  const session = await client.session.ensure();
  const asset = await client.assets.upload(input.file, { workspaceId: session.workspaceId, kind: "font", contentType: type });
  return {
    family: info.family,
    fromFile: info.fromFile,
    operations: [
      {
        op: "add",
        path: "/assets/-",
        value: {
          id: asset.id,
          type: "font",
          storageKey: asset.storage_key,
          fileName: input.file.name,
          mimeType: type,
          byteSize: input.file.size,
          fontFamily: info.family,
          ...(info.style ? { fontStyle: info.style } : {}),
          // A variable font carries its range; a static one draws as uploaded at
          // every weight rather than being refused at the weights it lacks.
          fontWeight: "100 900",
        },
      },
    ],
  };
}
