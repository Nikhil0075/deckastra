// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../presentation-schema/fixtures/technical-deck.mydeck.json";
import { AssistantPanel } from "../src/components/AssistantPanel";
import type { EditorApi } from "../src/lib/useEditor";

const api = vi.hoisted(() => ({ capabilities: vi.fn(), list: vi.fn(), assetList: vi.fn(), start: vi.fn(), get: vi.fn(), events: vi.fn(), cancel: vi.fn(), resume: vi.fn(), approveMetadata: vi.fn() }));
vi.mock("@deckastra/workspace-client/react", () => ({ useWorkspaceClient: () => ({ assistant: api }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function setup(available = true, extraTasks = {}) {
  api.capabilities.mockResolvedValue({ tasks: { tidy: { available, provider: "local", reason: available ? null : "Install the verified model pack" }, ...extraTasks } });
  api.list.mockResolvedValue({ runs: [] }); api.assetList.mockResolvedValue({ assets: [] });
  const editor = { sourceDocument: fixture, slideIndex: 0, selection: { selectedIds: [] }, saveNow: vi.fn().mockResolvedValue(true), currentVersionId: () => "ver_current", adoptDocument: vi.fn().mockReturnValue(true) } as unknown as EditorApi;
  render(<AssistantPanel editor={editor} presentationId={fixture.id} onCompleted={vi.fn()} />);
  return editor;
}

it("saves before starting with the current version and selected scope, then cancels", async () => {
  const editor = setup();
  const run = { id: "asr_test", task: "tidy", status: "queued", result: null, error: null };
  api.start.mockResolvedValue(run); api.get.mockResolvedValue(run); api.events.mockResolvedValue({ events: [{ sequence: 1, status: "provider", provider: "vertex", reason: "Local task unqualified" }] }); api.cancel.mockResolvedValue({ ...run, cancel_requested: true });
  await waitFor(() => expect((screen.getByRole("button", { name: "Run assistant" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Run assistant" }));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(editor.saveNow).toHaveBeenCalledOnce();
  expect(api.start.mock.calls[0]![0]).toMatchObject({ expected_version_id: "ver_current", scope: { kind: "slide", slide_ids: [fixture.slides[0]!.id] } });
  await screen.findByText(/Vertex AI: Local task unqualified/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("asr_test"));
});

it("shows actionable configuration failures and prevents unavailable tasks", async () => {
  setup(false);
  await screen.findByText("Install the verified model pack");
  expect((screen.getByRole("button", { name: "Run assistant" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.start).not.toHaveBeenCalled();
});

it("exports the current slide in the editor's selected language", async () => {
  const editor = setup(true, { export: { available: true, provider: "export" } });
  editor.locale = "hi";
  const run = { id: "asr_export", task: "export", status: "queued", result: null, error: null };
  api.start.mockResolvedValue(run); api.get.mockResolvedValue(run); api.events.mockResolvedValue({ events: [] });
  fireEvent.change(screen.getByLabelText("Assistant task"), { target: { value: "export" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Run assistant" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Run assistant" }));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(api.start.mock.calls[0]![0]).toMatchObject({ task: "export", locale: "hi", scope: { kind: "slide", slide_ids: [fixture.slides[0]!.id] } });
});

it("retains newer local edits and shows a reconciliation notice after completion", async () => {
  const editor = setup();
  const queued = { id: "asr_reconcile", task: "tidy", status: "queued", result: null, error: null };
  api.start.mockResolvedValue(queued);
  api.get.mockResolvedValue({ ...queued, status: "completed", result: { document: fixture, version_id: "ver_assistant" } });
  api.events.mockResolvedValue({ events: [] });
  vi.mocked(editor.saveNow).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await waitFor(() => expect((screen.getByRole("button", { name: "Run assistant" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Run assistant" }));
  await screen.findByText(/newer local edits need reconciliation/);
  expect(editor.adoptDocument).not.toHaveBeenCalled();
});

it("defaults generation to appending and warns about replacing existing slides", async () => {
  setup(true, { generate: { available: true, provider: "local" } });
  fireEvent.change(screen.getByLabelText("Assistant task"), { target: { value: "generate" } });
  expect((screen.getByLabelText("Generation mode") as HTMLSelectElement).value).toBe("append");
  expect(screen.getByText("Research sources")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Generation mode"), { target: { value: "replace" } });
  expect(screen.getByRole("alert").textContent).toContain(`all ${fixture.slides.length} existing slides`);
});

it("keeps authored motion by default and asks before replacing it", async () => {
  setup(true, { motion: { available: true, provider: "engine", reason: null } });
  const run = { id: "asr_motion", task: "motion", status: "queued", result: null, error: null };
  api.start.mockResolvedValue(run); api.get.mockResolvedValue(run); api.events.mockResolvedValue({ events: [] });
  fireEvent.change(await screen.findByLabelText("Assistant task"), { target: { value: "motion" } });
  // Motion does not read written instructions, so it offers none.
  expect(screen.queryByLabelText("Assistant instructions")).toBeNull();
  await screen.findByText("Slides that already have animation are left as they are.");
  await waitFor(() => expect((screen.getByRole("button", { name: "Run assistant" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Run assistant" }));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(api.start.mock.calls[0]![0]).toMatchObject({ task: "motion", motion_replace: false });
});

it("sends a replacement request only when the person ticks it", async () => {
  setup(true, { motion: { available: true, provider: "engine", reason: null } });
  api.start.mockResolvedValue({ id: "asr_motion2", task: "motion", status: "queued", result: null, error: null });
  api.get.mockResolvedValue({ id: "asr_motion2", task: "motion", status: "queued", result: null, error: null }); api.events.mockResolvedValue({ events: [] });
  fireEvent.change(await screen.findByLabelText("Assistant task"), { target: { value: "motion" } });
  fireEvent.click(screen.getByLabelText("Replace existing animation"));
  await screen.findByText(/waits for your review in Proposals/);
  await waitFor(() => expect((screen.getByRole("button", { name: "Run assistant" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Run assistant" }));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(api.start.mock.calls[0]![0]).toMatchObject({ task: "motion", motion_replace: true });
});
