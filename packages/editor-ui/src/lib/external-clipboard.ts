import {
  newId,
  type PatchOperation,
  type PresentationDocument,
  type RichTextDocument,
} from "@deckastra/presentation-schema";
import { addElement } from "@deckastra/presentation-core";
import {
  CLIPBOARD_MIME,
  parseClipboardPayload,
  plainTextToRichText,
  richTextToPlain,
  sanitizePastedHtml,
  type ClipboardPayload,
} from "@deckastra/editor";

/**
 * What the operating system's clipboard and a file drop can put on a slide
 * (manual-authoring review MA-23).
 *
 * The editor's own copy used to live in component state, so it reached neither
 * another deck nor another program, and nothing another program copied — a
 * screenshot, a paragraph — could be pasted onto a slide at all. Three kinds of
 * payload are accepted, in this order, and anything else is refused by name
 * rather than ignored:
 *
 * 1. **Deckastra objects**, under `CLIPBOARD_MIME`, from this or another deck
 *    or window. Fresh ids, and the asset entries their pictures cite.
 * 2. **Pictures** — a screenshot on the clipboard, or image files. Uploaded
 *    through the same path as Insert → Image, so the quota and the manifest
 *    entry work the same way.
 * 3. **Text** — HTML through the paste allowlist (the same one the text editor
 *    uses), or plain text — as a new text box.
 *
 * The decision is pure (`classifyTransfer`); the shell does the uploading.
 */

/** The kinds of picture the renderer can draw; the insert rail offers the same. */
export const PASTEABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;

export type Transfer =
  | { kind: "objects"; payload: ClipboardPayload }
  | { kind: "images"; files: File[]; refused: string[] }
  | { kind: "text"; content: RichTextDocument }
  | { kind: "refused"; message: string }
  | { kind: "empty" };

export interface TransferLike {
  getData(format: string): string;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
}

export function classifyTransfer(data: TransferLike | null | undefined, parse: (html: string) => Node): Transfer {
  if (!data) return { kind: "empty" };

  const payload = parseClipboardPayload(safeGet(data, CLIPBOARD_MIME));
  if (payload) return { kind: "objects", payload };

  const files = filesOf(data);
  if (files.length > 0) {
    const accepted = files.filter((file) => (PASTEABLE_IMAGE_TYPES as readonly string[]).includes(file.type));
    const refused = files.filter((file) => !accepted.includes(file)).map((file) => file.name || file.type || "a file");
    if (accepted.length > 0) return { kind: "images", files: accepted, refused };
    return {
      kind: "refused",
      message: `${refused.join(", ")} cannot go on a slide. Paste or drop a PNG, JPEG, GIF, WebP or SVG picture, or text.`,
    };
  }

  const html = safeGet(data, "text/html");
  const plain = safeGet(data, "text/plain");
  if (html) {
    const content = sanitizePastedHtml(html, parse);
    if (richTextToPlain(content).trim() !== "") return { kind: "text", content };
  }
  if (plain.trim() !== "") return { kind: "text", content: plainTextToRichText(plain) };
  return { kind: "empty" };
}

/**
 * A text box holding pasted words, centred on the slide (or on `at`) and
 * fitted to its content's height, as one `add`.
 */
export function pastedTextOperations(
  document: PresentationDocument,
  slideId: string,
  content: RichTextDocument,
  at?: { x: number; y: number },
): { operations: PatchOperation[]; elementId: string } {
  const width = Math.round(document.viewport.width * 0.5);
  const lines = content.blocks.length;
  const height = Math.min(Math.round(document.viewport.height * 0.8), Math.max(80, lines * 44));
  const x = at ? at.x - width / 2 : (document.viewport.width - width) / 2;
  const y = at ? at.y - height / 2 : (document.viewport.height - height) / 2;
  const element = {
    id: newId("el"),
    type: "text",
    transform: {
      x: clamp(Math.round(x), 0, document.viewport.width - width),
      y: clamp(Math.round(y), 0, document.viewport.height - height),
      width,
      height,
    },
    content,
    typography: {
      fontFamily: "token:typography.body.fontFamily",
      fontSize: 32,
      color: "token:colors.foreground",
    },
    fit: "autoHeight",
    semanticRole: "body",
  };
  return { operations: addElement(document, { slideId, element: element as never }), elementId: element.id };
}

/** Write the editor's own copy to the system clipboard, with words for other programs. */
export function writeClipboard(data: DataTransfer, payload: ClipboardPayload): void {
  data.setData(CLIPBOARD_MIME, JSON.stringify(payload));
  const words = payload.elements
    .map((element) => {
      const content = (element as { content?: RichTextDocument; text?: RichTextDocument }).content ?? (element as { text?: RichTextDocument }).text;
      return content && typeof content === "object" && "blocks" in content ? richTextToPlain(content) : "";
    })
    .filter((text) => text !== "")
    .join("\n");
  if (words) data.setData("text/plain", words);
}

function filesOf(data: TransferLike): File[] {
  const out: File[] = [];
  // Keyed on what the file is, not the object: Chromium hands back a new File
  // from every `getAsFile()`, so identity would count one screenshot twice.
  const seen = new Set<string>();
  const add = (file: File | null) => {
    if (!file) return;
    const key = `${file.name}|${file.size}|${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  for (const file of Array.from(data.files ?? [])) add(file);
  // A screenshot arrives as an item, not always in `files`.
  for (const item of Array.from(data.items ?? [])) if (item.kind === "file") add(item.getAsFile());
  return out;
}

function safeGet(data: TransferLike, format: string): string {
  try {
    return data.getData(format) ?? "";
  } catch {
    return "";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
