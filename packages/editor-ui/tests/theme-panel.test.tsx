import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { ThemePanel } from "../src/components/ThemePanel";
import { useEditor, type EditorApi } from "../src/lib/useEditor";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it("saves the current portable theme as the workspace default when selected", async () => {
  const document = loadFixture("technical");
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => ({ ok: true, json: async () =>
    options?.method === "POST" ? { id: "thm_default", name: "Our brand", is_default: true } : { themes: [] },
  }));
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <ThemePanel editor={editor} presentationId={document.id} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  fireEvent.change(screen.getByLabelText("Save current theme as"), { target: { value: "Our brand" } });
  fireEvent.click(screen.getByLabelText("Use as default for new decks"));
  fireEvent.click(screen.getByRole("button", { name: "Save theme" }));
  await screen.findByRole("option", { name: "Our brand (default)" });
  const post = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ name: "Our brand", definition: document.theme, is_default: true });
});

it("applies a fetched theme to the current local document and undoes only that change", async () => {
  const document = loadFixture("technical");
  const originalTheme = structuredClone(document.theme);
  const definition = { ...document.theme, colors: { ...document.theme.colors, accent: "#FF6600" } };
  let resolve!: (value: unknown) => void;
  const proposal = new Promise(done => { resolve = done; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/themes")) return { ok: true, json: async () => ({ themes: [{ id: "thm_saved", name: "Brand", is_default: false }] }) };
    if (url.endsWith("/themes/thm_saved")) return { ok: true, json: async () => proposal };
    return { ok: true, json: async () => ({ version_id: "v1" }) };
  }));
  let editor!: EditorApi;
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <ThemePanel editor={editor} presentationId={document.id} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  await screen.findByRole("option", { name: "Brand" });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  fireEvent.change(screen.getByLabelText("Saved theme"), { target: { value: "thm_saved" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply theme" }));
  act(() => editor.apply([{ op: "replace", path: "/metadata/title", value: "Local work" }], { label: "Rename" }));
  await act(async () => resolve({ theme: { name: "Brand" }, operations: [
    { op: "replace", path: "/theme", value: definition },
    { op: "add", path: "/metadata/themeId", value: "thm_saved" },
  ] }));
  expect(editor.document.metadata.title).toBe("Local work");
  expect(editor.document.theme.colors.accent).toBe("#FF6600");
  expect(editor.historyEntries).toHaveLength(2);
  act(() => editor.undo());
  expect(editor.document.theme).toEqual(originalTheme);
  expect(editor.document.metadata.title).toBe("Local work");
  expect(editor.document.metadata.themeId).toBeUndefined();
});
