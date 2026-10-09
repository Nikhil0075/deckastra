// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../presentation-schema/fixtures/technical-deck.mydeck.json";
import { AssistantPanel } from "../src/components/AssistantPanel";
import type { EditorApi } from "../src/lib/useEditor";

const agent = vi.hoisted(() => ({
  proposals: vi.fn(),
  proposal: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
const client = vi.hoisted(() => ({ agent, session: {} }));

vi.mock("@deckastra/workspace-client/react", () => ({
  useWorkspaceClient: () => client,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function setup() {
  agent.proposals.mockResolvedValue([]);
  const editor = {
    sourceDocument: fixture,
    document: fixture,
    slideIndex: 0,
    locale: null,
    selection: { selectedIds: [] },
    saveNow: vi.fn().mockResolvedValue(true),
    currentVersionId: () => "ver_current",
    adoptDocument: vi.fn().mockReturnValue(true),
  } as unknown as EditorApi;
  const onVoiceOpen = vi.fn();
  const onMediaOpen = vi.fn();
  const onClose = vi.fn();
  render(
    <AssistantPanel
      editor={editor}
      presentationId={fixture.id}
      onLanguagesOpen={vi.fn()}
      onVoiceOpen={onVoiceOpen}
      onMediaOpen={onMediaOpen}
      onClose={onClose}
    />,
  );
  return { onVoiceOpen, onMediaOpen, onClose };
}

it("is a compact hub for approvals, languages, voice, and media", async () => {
  setup();
  expect(screen.getByRole("heading", { name: "Assistant" })).toBeTruthy();
  expect(screen.getByText(/Build and revise the deck with your connected agent/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Waiting for you/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Languages/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Voice/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Media/ })).toBeTruthy();
  expect(screen.queryByTestId("assistant-input")).toBeNull();
  expect(screen.queryByText("Quick actions")).toBeNull();
  await waitFor(() => expect(agent.proposals).toHaveBeenCalledWith(fixture.id));
});

it("opens the dedicated voice and media tools", () => {
  const { onVoiceOpen, onMediaOpen } = setup();
  fireEvent.click(screen.getByRole("button", { name: /Voice/ }));
  fireEvent.click(screen.getByTestId("assistant-open-voice"));
  expect(onVoiceOpen).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: /Media/ }));
  fireEvent.click(screen.getByTestId("assistant-open-media"));
  expect(onMediaOpen).toHaveBeenCalledOnce();
});

it("closes from its header", () => {
  const { onClose } = setup();
  fireEvent.click(screen.getByTestId("close-assistant"));
  expect(onClose).toHaveBeenCalledOnce();
});
