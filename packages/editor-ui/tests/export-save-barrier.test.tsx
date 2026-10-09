// @vitest-environment jsdom
/**
 * An export is of the deck on screen, or of nothing (audit UI-01, 2026-09-19).
 *
 * The editor saves on a debounce, and the service exports what it has stored,
 * so an export pressed right after an edit used to render the version before
 * it — and report success. These drive the real `useEditor` and the real
 * `ExportPanel` over the real HTTP client, with the transport controlled so the
 * orderings are deterministic. The first case is the audit's reproducer.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { ExportPanel } from "../src/components/ExportPanel";
import { useEditor } from "../src/lib/useEditor";
import { recoveryLocks } from "./helpers/recovery-locks";

type SaveReply = () => Response | Promise<Response>;

let persisted: string;
let saveReply: SaveReply;
let exportRequests: Array<{ body: Record<string, unknown>; persisted: string }>;
let exportReply: () => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: recoveryLocks() });
  persisted = "old";
  exportRequests = [];
  saveReply = () => json({ version_id: "v1" });
  exportReply = () => json({ id: "exp_test", kind: "pdf", status: "failed", error: "stopped by the test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/transactions")) {
        const reply = await saveReply();
        if (reply.ok) persisted = JSON.parse(String(init?.body)).operations.at(-1).value;
        return reply;
      }
      if (path.endsWith("/exports")) {
        exportRequests.push({ body: JSON.parse(String(init?.body)), persisted });
        return exportReply();
      }
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  const wrapper = withWorkspaceClient();
  const hook = renderHook(
    () => useEditor({ initialDocument: loadFixture("technical"), presentationId: "prs_audit", initialVersionId: "v0" }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.recoveryReady).toBe(true));
  const editor = {
    saveNow: () => hook.result.current.saveNow(),
    currentVersionId: () => hook.result.current.currentVersionId(),
  };
  render(<ExportPanel presentationId="prs_audit" editor={editor} />, { wrapper });
  act(() => hook.result.current.apply([{ op: "replace", path: "/metadata/title", value: "latest" }], { label: "Retitle" }));
  return hook;
}

describe("exporting from the editor", () => {
  it.each([
    ["PDF", "pdf"],
    ["PowerPoint", "pptx"],
    ["Narrated video", "mp4"],
  ])("%s includes an edit whose autosave had not run yet, pinned to its version", async (label, kind) => {
    const hook = await mount();
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(exportRequests).toHaveLength(1));
    expect(hook.result.current.document.metadata.title).toBe("latest");
    expect(exportRequests[0]!.persisted).toBe("latest");
    expect(exportRequests[0]!.body).toMatchObject({ kind, expected_version_id: "v1" });
    if (kind === "mp4") expect(exportRequests[0]!.body).toMatchObject({ fps: 30 });
  });

  it("waits for a save that is still in flight", async () => {
    let release!: () => void;
    saveReply = () => new Promise((resolve) => (release = () => resolve(json({ version_id: "v1" }))));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    await screen.findByText("Saving your latest changes first…");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(exportRequests).toHaveLength(0);

    await act(async () => release());
    await waitFor(() => expect(exportRequests).toHaveLength(1));
    expect(exportRequests[0]!.persisted).toBe("latest");
  });

  it.each([
    ["a failed save", () => json({ detail: "boom" }, 500)],
    ["a conflict", () => json({ detail: "The deck changed." }, 409)],
  ])("does not export after %s, and says the latest changes would be missing", async (_name, reply) => {
    saveReply = reply;
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    await screen.findByTestId("export-unsaved");
    expect(exportRequests).toHaveLength(0);

    // The explicit way out: the last saved version, named as such and unpinned.
    fireEvent.click(screen.getByRole("button", { name: "Export the last saved version" }));
    await waitFor(() => expect(exportRequests).toHaveLength(1));
    expect(exportRequests[0]!.persisted).toBe("old");
    expect(exportRequests[0]!.body.expected_version_id).toBeUndefined();
  });

  it("commits a draft still in a focused field, even when the press does not move focus", async () => {
    // A notes draft commits on blur. A person's click blurs it; a keyboard or
    // programmatic press does not, and the export must not depend on which.
    const hook = await mount();
    const field = document.createElement("textarea");
    field.addEventListener("blur", () =>
      hook.result.current.apply([{ op: "replace", path: "/metadata/title", value: "draft" }], { label: "Notes" }),
    );
    document.body.appendChild(field);
    field.focus();
    act(() => screen.getByRole("button", { name: "PDF" }).click());
    await waitFor(() => expect(exportRequests).toHaveLength(1));
    expect(exportRequests[0]!.persisted).toBe("draft");
    field.remove();
  });

  it("reports the service's refusal when the deck moved after the save", async () => {
    exportReply = () =>
      json({ detail: "The deck changed after it was saved for this export. Export again to include the latest version." }, 409);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The deck changed after it was saved for this export. Export again to include the latest version.",
    );
  });
});
