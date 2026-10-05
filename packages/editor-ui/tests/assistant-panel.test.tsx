// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../presentation-schema/fixtures/technical-deck.mydeck.json";
import { AssistantPanel } from "../src/components/AssistantPanel";
import type { EditorApi } from "../src/lib/useEditor";

const api = vi.hoisted(() => ({
  capabilities: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  events: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  approveMetadata: vi.fn(),
}));
const agent = vi.hoisted(() => ({ edit: vi.fn(), revert: vi.fn(), proposals: vi.fn() }));
const session = vi.hoisted(() => ({ account: vi.fn(), ensure: vi.fn() }));
const assets = vi.hoisted(() => ({ upload: vi.fn() }));
// One object, as the real provider gives: panels key their effects on the
// client's identity, and a fresh one per render refetches forever.
const client = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@deckastra/workspace-client/react", () => ({
  useWorkspaceClient: () => Object.assign(client, { assistant: api, agent, session, assets, repositories: { slideSources: () => new Promise(() => {}) } }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const slideId = fixture.slides[0]!.id;

function setup({
  tasks = { tidy: { available: true, provider: "engine", reason: null } } as Record<string, unknown>,
  generation = { provider: "vertex", available: true, reason: null } as Record<string, unknown> | undefined,
  selected = [] as string[],
} = {}) {
  api.capabilities.mockResolvedValue({ provider: "vertex", available: true, reason: null, tasks });
  api.list.mockResolvedValue({ runs: [] });
  agent.proposals.mockResolvedValue([]);
  session.account.mockResolvedValue({ capabilities: { generation } });
  const editor = {
    sourceDocument: fixture,
    document: fixture,
    slideIndex: 0,
    locale: null,
    selection: { selectedIds: selected },
    saveNow: vi.fn().mockResolvedValue(true),
    currentVersionId: () => "ver_current",
    adoptDocument: vi.fn().mockReturnValue(true),
  } as unknown as EditorApi;
  render(<AssistantPanel editor={editor} presentationId={fixture.id} onLanguagesOpen={vi.fn()} />);
  return editor;
}

const action = (id: string) => screen.getByTestId(`assistant-action-${id}`) as HTMLButtonElement;

it("runs a quick action on the slide on screen, saved first, and can stop it", async () => {
  const editor = setup();
  const run = { id: "asr_test", task: "tidy", status: "running", result: null, error: null, cancel_requested: false };
  api.start.mockResolvedValue(run);
  api.get.mockResolvedValue(run);
  api.events.mockResolvedValue({ events: [{ sequence: 1, status: "provider", provider: "vertex", message: "Checking spacing" }] });
  api.cancel.mockResolvedValue({ ...run, cancel_requested: true });
  await waitFor(() => expect(action("fix-layout").disabled).toBe(false));
  fireEvent.click(action("fix-layout"));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(editor.saveNow).toHaveBeenCalledOnce();
  expect(api.start.mock.calls[0]![0]).toMatchObject({
    task: "tidy",
    expected_version_id: "ver_current",
    scope: { kind: "slide", slide_ids: [slideId] },
  });
  await screen.findByText(/Checking spacing/);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("asr_test"));
});

it("says why an action is unavailable, in words a person uses", async () => {
  setup({ tasks: { tidy: { available: false, provider: "local", reason: "Install the verified Gemma model pack" } } });
  await waitFor(() => expect(action("fix-layout").title).toBe("Not set up yet."));
  expect(action("fix-layout").disabled).toBe(true);
  // A task the service does not list at all is not offered as though it worked.
  expect(action("alt-text").disabled).toBe(true);
  expect(document.body.textContent).not.toMatch(/gemma|model|qualif/i);
});

it("sends the prompt with its scope, and offers Undo for a change the server applied", async () => {
  const editor = setup({ selected: ["el_one"] });
  agent.edit.mockResolvedValue({
    outcome: "applied",
    document: fixture,
    version_id: "ver_next",
    transaction_id: "txn_1",
    changes: [{ element_id: "el_one", reason: "Shortened the title." }],
    reasons: [],
    risk_tier: "low",
  });
  agent.revert.mockResolvedValue({ document: fixture, version_id: "ver_back" });
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Shorter title" } });
  await waitFor(() => expect((screen.getByTestId("assistant-run") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("assistant-run"));
  await waitFor(() => expect(agent.edit).toHaveBeenCalledOnce());
  expect(agent.edit.mock.calls[0]![1]).toMatchObject({
    instruction: "Shorter title",
    scope: { kind: "elements", element_ids: ["el_one"], slide_ids: [slideId] },
  });
  await screen.findByText("Done. Shortened the title.");
  expect(editor.adoptDocument).toHaveBeenCalledWith(fixture, "ver_next");
  fireEvent.click(screen.getByTestId("assistant-undo"));
  await waitFor(() => expect(agent.revert).toHaveBeenCalledWith(fixture.id, "txn_1"));
});

it("puts a change too large to apply under Waiting for you, and asks for the list again", async () => {
  setup();
  agent.edit.mockResolvedValue({ outcome: "pending", transaction_id: "txn_2", changes: [], reasons: [], risk_tier: "high" });
  await waitFor(() => expect(agent.proposals).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Restyle every slide" } });
  fireEvent.click(screen.getByTestId("assistant-run"));
  await screen.findByText(/waiting for you below/i);
  await waitFor(() => expect(agent.proposals).toHaveBeenCalledTimes(2));
});

it("says what is sent before Run, and refuses when nothing is set up", async () => {
  setup();
  expect((await screen.findByTestId("assistant-disclosure")).textContent).toBe(
    "Only your request and this slide are sent to Google Cloud, when you press Run.",
  );
  cleanup();
  setup({ generation: { provider: "none", available: false, reason: "Sign in to use the assistant." } });
  await waitFor(() => expect(screen.getByTestId("assistant-disclosure").textContent).toBe("Sign in to use the assistant."));
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Anything" } });
  expect((screen.getByTestId("assistant-run") as HTMLButtonElement).disabled).toBe(true);
});

it("asks for words before Add slides, then adds after the slides already there", async () => {
  setup({ tasks: { generate: { available: true, provider: "vertex", reason: null } } });
  api.start.mockResolvedValue({ id: "asr_gen", task: "generate", status: "queued", result: null, error: null });
  api.get.mockResolvedValue({ id: "asr_gen", task: "generate", status: "queued", result: null, error: null });
  api.events.mockResolvedValue({ events: [] });
  await waitFor(() => expect(action("add-slides").disabled).toBe(false));
  fireEvent.click(action("add-slides"));
  expect(screen.getByRole("alert").textContent).toMatch(/Say what the new slides should cover/);
  expect(api.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: "Two slides on pricing" } });
  fireEvent.click(action("add-slides"));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(api.start.mock.calls[0]![0]).toMatchObject({
    task: "generate",
    instruction: "Two slides on pricing",
    generation_mode: "append",
    scope: { kind: "deck" },
  });
});

it("keeps authored motion unless the person chooses otherwise", async () => {
  setup({ tasks: { motion: { available: true, provider: "engine", reason: null } } });
  const run = { id: "asr_motion", task: "motion", status: "queued", result: null, error: null };
  api.start.mockResolvedValue(run);
  api.get.mockResolvedValue(run);
  api.events.mockResolvedValue({ events: [] });
  await waitFor(() => expect(action("motion").disabled).toBe(false));
  fireEvent.click(action("motion"));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(api.start.mock.calls[0]![0]).toMatchObject({ task: "motion", motion_replace: false });
});

it("keeps newer local edits when a finished run would replace them", async () => {
  const editor = setup();
  const queued = { id: "asr_reconcile", task: "tidy", status: "queued", result: null, error: null };
  api.start.mockResolvedValue(queued);
  api.get.mockResolvedValue({ ...queued, status: "completed", result: { document: fixture, version_id: "ver_assistant" } });
  api.events.mockResolvedValue({ events: [] });
  vi.mocked(editor.saveNow).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await waitFor(() => expect(action("fix-layout").disabled).toBe(false));
  fireEvent.click(action("fix-layout"));
  await screen.findByText(/you have newer edits here/);
  expect(editor.adoptDocument).not.toHaveBeenCalled();
});

it("never names a model or provider in its progress", async () => {
  setup();
  const run = { id: "asr_words", task: "tidy", status: "running", result: null, error: null, cancel_requested: false };
  api.start.mockResolvedValue(run);
  api.get.mockResolvedValue(run);
  api.events.mockResolvedValue({ events: [{ sequence: 1, status: "provider", provider: "local", message: "Gemma E2B model loaded" }] });
  await waitFor(() => expect(action("fix-layout").disabled).toBe(false));
  fireEvent.click(action("fix-layout"));
  await screen.findByTestId("assistant-progress");
  await waitFor(() => expect(screen.getByTestId("assistant-progress").textContent).toMatch(/Fix layout:/));
  expect(document.body.textContent).not.toMatch(/gemma|model|vertex/i);
});

it("fills the prompt with words handed over from the command palette, and sends nothing", async () => {
  api.capabilities.mockResolvedValue({ tasks: {} });
  api.list.mockResolvedValue({ runs: [] });
  agent.proposals.mockResolvedValue([]);
  session.account.mockResolvedValue({ capabilities: {} });
  const editor = {
    sourceDocument: fixture,
    document: fixture,
    slideIndex: 0,
    locale: null,
    selection: { selectedIds: [] },
    saveNow: vi.fn().mockResolvedValue(true),
    currentVersionId: () => "ver_current",
    adoptDocument: vi.fn(),
  } as unknown as EditorApi;
  render(<AssistantPanel editor={editor} presentationId={fixture.id} focusToken={1} initialPrompt="Add a pricing slide" />);
  const input = screen.getByTestId("assistant-input") as HTMLTextAreaElement;
  await waitFor(() => expect(input.value).toBe("Add a pricing slide"));
  expect(document.activeElement).toBe(input);
  expect(agent.edit).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
});

it("reads attached files: Research needs one, and sends them with the request", async () => {
  setup({ tasks: { research: { available: true, provider: "vertex", reason: null } } });
  session.ensure.mockResolvedValue({ workspaceId: "wsp_1" });
  assets.upload.mockResolvedValue({ id: "ast_pdf" });
  api.start.mockResolvedValue({ id: "asr_r", task: "research", status: "queued", result: null, error: null, cancel_requested: false });
  api.get.mockResolvedValue({ id: "asr_r", task: "research", status: "queued", result: null, error: null, cancel_requested: false });
  api.events.mockResolvedValue({ events: [] });
  await waitFor(() => expect(action("research").disabled).toBe(false));

  // Nothing attached yet: said, and nothing started.
  fireEvent.click(action("research"));
  expect(await screen.findByText(/Attach a PDF, CSV or text file under Sources first/)).toBeTruthy();
  expect(api.start).not.toHaveBeenCalled();

  // A PowerPoint is not something it can read; a PDF is.
  fireEvent.click(screen.getByRole("button", { name: /^Sources/ }));
  const input = screen.getByTestId("assistant-attach-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "deck.pptx")] } });
  expect(await screen.findByText(/deck.pptx is not a PDF, CSV or text file/)).toBeTruthy();
  fireEvent.change(input, { target: { files: [new File(["%PDF"], "Market report.pdf")] } });
  await screen.findByText("Market report.pdf");
  expect(assets.upload.mock.calls[0]![1]).toMatchObject({ workspaceId: "wsp_1", kind: "document", contentType: "application/pdf" });

  fireEvent.click(action("research"));
  await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  expect(api.start.mock.calls[0]![0]).toMatchObject({ task: "research", source_asset_ids: ["ast_pdf"] });
});
