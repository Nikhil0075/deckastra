import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument, TextElement } from "@deckastra/presentation-schema";
import { newId, validateDocument } from "@deckastra/presentation-schema";
import { makeStarterElement, resolveElementById } from "@deckastra/presentation-core";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { Inspector } from "../src/components/inspector/Inspector";
import { fontTypeOf, readFontInfo } from "../src/lib/font-file";
import { useEditor, type EditorApi } from "../src/lib/useEditor";

/**
 * Uploading a font (Design tab review, 2026-09-26): the family is read from
 * the file, the face and its use arrive as one patch, and Undo takes both.
 */

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));

/** A minimal TrueType file: an sfnt header and a `name` table, nothing else. */
function sfnt(names: Record<number, string>): Uint8Array {
  const entries = Object.entries(names).map(([id, text]) => {
    const bytes: number[] = [];
    for (const char of text) bytes.push(0, char.charCodeAt(0));
    return { id: Number(id), bytes };
  });
  const stringOffset = 6 + entries.length * 12;
  const stringsLength = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const nameLength = stringOffset + stringsLength;
  const out = new Uint8Array(12 + 16 + nameLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  out.set([..."name"].map((c) => c.charCodeAt(0)), 12);
  view.setUint32(20, 28);
  view.setUint32(24, nameLength);
  view.setUint16(28 + 2, entries.length);
  view.setUint16(28 + 4, stringOffset);
  let cursor = 0;
  entries.forEach((entry, index) => {
    const record = 28 + 6 + index * 12;
    view.setUint16(record, 3);
    view.setUint16(record + 2, 1);
    view.setUint16(record + 4, 0x409);
    view.setUint16(record + 6, entry.id);
    view.setUint16(record + 8, entry.bytes.length);
    view.setUint16(record + 10, cursor);
    out.set(entry.bytes, 28 + stringOffset + cursor);
    cursor += entry.bytes.length;
  });
  return out;
}

it("reads the family from the file, preferring the typographic family", async () => {
  const file = new File([sfnt({ 1: "Acme Sans Bold", 2: "Italic", 16: "Acme Sans" })], "whatever.ttf");
  expect(await readFontInfo(file)).toEqual({ family: "Acme Sans", fromFile: true, style: "italic" });
});

it("names a compressed font from its file name, without the style words", async () => {
  const file = new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0])], "Acme-Grotesk-SemiBold.woff2");
  expect(await readFontInfo(file)).toEqual({ family: "Acme Grotesk", fromFile: false });
});

it("knows a font by its extension and nothing else", () => {
  expect(fontTypeOf("a.TTF")).toBe("font/ttf");
  expect(fontTypeOf("a.woff2")).toBe("font/woff2");
  expect(fontTypeOf("a.png")).toBeUndefined();
});

let editor: EditorApi;
const FONT_ID = newId("ast");
const begun: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  begun.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/uploads/complete")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: FONT_ID, storage_key: "workspaces/wsp_test/assets/acme.ttf", kind: "font" }),
        };
      }
      if (String(url).includes("/uploads")) {
        begun.push(JSON.parse(String(init?.body ?? "{}")));
        return {
          ok: true,
          status: 201,
          json: async () => ({ method: "PUT", upload_url: "/v1/workspace/assets/blob/x", headers: {}, upload_token: "a-token-long-enough-to-pass" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ version_id: "v1" }) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ doc, id }: { doc: PresentationDocument; id: string }) {
  editor = useEditor({ initialDocument: doc, presentationId: "prs_fonts", initialVersionId: "v0" });
  const selected = resolveElementById(editor.document, id)?.element;
  return (
    <Inspector
      editor={editor}
      presentationId="prs_fonts"
      selected={selected}
      onReorder={() => {}}
      onToggle={() => {}}
      onGroup={() => {}}
      onUngroup={() => {}}
      onDelete={() => {}}
      onOpenHistory={() => {}}
    />
  );
}

it("uploads a font from the picker and uses it on the text, as one undo step", async () => {
  const doc = structuredClone(loadFixture("technical"));
  const element = makeStarterElement({ kind: "text", viewport: doc.viewport });
  doc.slides[0]!.elements.push(element);
  const assetsBefore = doc.assets.length;
  render(<Harness doc={doc} id={element.id} />, { wrapper: withWorkspaceClient() });

  fireEvent.click(screen.getByTestId("font-family"));
  const input = screen.getByTestId("font-upload-input") as HTMLInputElement;
  const file = new File([sfnt({ 1: "Acme Sans", 2: "Regular" })], "acme.ttf");
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });

  await waitFor(() => expect(screen.getByTestId("font-upload-status").textContent).toBe("Using Acme Sans."));
  // A browser often leaves a font's type empty, so the kind and type are said.
  expect(begun[0]).toMatchObject({ kind: "font", content_type: "font/ttf" });

  const font = editor.document.assets.find((asset) => asset.type === "font") as { fontFamily?: string; id: string } | undefined;
  expect(font).toMatchObject({ id: FONT_ID, fontFamily: "Acme Sans" });
  const text = resolveElementById(editor.document, element.id)!.element as TextElement;
  expect(text.typography.fontFamily).toBe("Acme Sans");
  expect(validateDocument(editor.document).errors).toEqual([]);

  // The picker now offers it under this deck's uploads.
  fireEvent.click(screen.getByTestId("font-family"));
  expect(within(screen.getByRole("listbox", { name: "Font" })).getByRole("option", { name: "Acme Sans" })).toBeTruthy();

  act(() => editor.undo());
  expect(editor.document.assets.length).toBe(assetsBefore);
  expect((resolveElementById(editor.document, element.id)!.element as TextElement).typography.fontFamily).toBe(
    element.typography.fontFamily,
  );
});

it("refuses a file that is not a font, and says so", async () => {
  const doc = structuredClone(loadFixture("technical"));
  const element = makeStarterElement({ kind: "text", viewport: doc.viewport });
  doc.slides[0]!.elements.push(element);
  render(<Harness doc={doc} id={element.id} />, { wrapper: withWorkspaceClient() });

  fireEvent.click(screen.getByTestId("font-family"));
  await act(async () => {
    fireEvent.change(screen.getByTestId("font-upload-input"), { target: { files: [new File(["x"], "notes.txt")] } });
  });
  await waitFor(() => expect(screen.getByTestId("font-upload-status").textContent).toMatch(/not a font file/));
  expect(begun).toEqual([]);
});
