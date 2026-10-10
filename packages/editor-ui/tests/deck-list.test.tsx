/**
 * The deck list (Phase 4).
 *
 * Driven through a real client over a stubbed `fetch`, like the other panels:
 * what matters is which requests reach the service — a delete that is actually a
 * soft delete with an Undo that restores, a duplicate that asks the server for a
 * copy — not what a fake client was told.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { PresentationSummary } from "@deckastra/workspace-contracts";

import { DeckList } from "../src/components/DeckList";
import { deckSummary, parseServerTime, projectSummary, relativeTime, visibleDecks } from "../src/lib/deck-list";

vi.mock("@deckastra/renderer/react", () => ({
  ScaledSlide: () => <div data-thumbnail />,
}));

const NOW = Date.parse("2026-09-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("deck-list rules", () => {
  it("says when a deck was edited in words, and as a date past a week", () => {
    expect(relativeTime(ago(20_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * MIN), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(relativeTime(ago(DAY + HOUR), NOW)).toBe("yesterday");
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(relativeTime(ago(20 * DAY), NOW)).toMatch(/^2026-08-\d\d$/);
    expect(relativeTime(null, NOW)).toBe("never edited");
  });

  it("reads a timestamp SQLite served without its zone as UTC, not local time", () => {
    // What the desktop's service answers: the stored UTC instant, zone dropped.
    // Read as local time it put a minute-old version "5h ago" in IST.
    expect(parseServerTime("2026-09-19T11:59:00")).toBe(NOW - MIN);
    expect(parseServerTime("2026-09-19T11:59:00.123456")).toBe(NOW - MIN + 123);
    expect(parseServerTime("2026-09-19T11:59:00+00:00")).toBe(NOW - MIN);
    expect(parseServerTime("2026-09-19T17:29:00+05:30")).toBe(NOW - MIN);
    expect(relativeTime("2026-09-19T11:59:00", NOW)).toBe("1 min ago");
  });

  const decks: PresentationSummary[] = [
    { id: "doc_b", title: "Security Review", version_id: "v", updated_at: ago(DAY + HOUR), slide_count: 9 },
    { id: "doc_a", title: "Migration Control Tower", version_id: "v", updated_at: ago(2 * HOUR), slide_count: 12 },
    { id: "doc_c", title: "Customer onboarding", version_id: "v", updated_at: ago(3 * HOUR), slide_count: 1 },
  ];

  it("describes a card and a project the way the Figma frame does", () => {
    expect(deckSummary(decks[1]!, NOW)).toBe("12 slides · edited 2h ago");
    expect(deckSummary(decks[2]!, NOW)).toBe("1 slide · edited 3h ago");
    expect(deckSummary({ ...decks[0]!, slide_count: null }, NOW)).toBe("edited yesterday");
    expect(projectSummary(decks, NOW)).toBe("3 decks · updated 2h ago");
  });

  it("sorts by recency or by name, and searches every word of the title", () => {
    expect(visibleDecks(decks, "", "recent").map((deck) => deck.id)).toEqual(["doc_a", "doc_c", "doc_b"]);
    expect(visibleDecks(decks, "", "name").map((deck) => deck.id)).toEqual(["doc_c", "doc_a", "doc_b"]);
    expect(visibleDecks(decks, "control migration", "recent").map((deck) => deck.id)).toEqual(["doc_a"]);
    expect(visibleDecks(decks, "nothing", "recent")).toEqual([]);
  });
});

const CATALOG = {
  description: "reviewed",
  purposeGroups: ["business"],
  slidePatterns: ["title"],
  patternDefinitions: {},
  themes: [{ key: "flat", name: "Flat", summary: "", preview: { background: "#fff", foreground: "#111", accent: "#00f", surface: "#eee" } }],
  presets: [
    { id: "business-pitch", name: "Sharp pitch", summary: "Pitch", purpose: "business", tags: [], themeKey: "flat", motionStyle: "restrained", transitionStyle: "fade", voiceStyle: "clear", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Hello" } }] },
    { id: "security-brief", name: "Security brief", summary: "Risks", purpose: "business", tags: [], themeKey: "flat", motionStyle: "restrained", transitionStyle: "fade", voiceStyle: "clear", reviewed: true, slides: [{ key: "opening", pattern: "title", purpose: "Open", slots: { headline: "Risk" } }] },
  ],
};

describe("DeckList", () => {
  let decks: PresentationSummary[];
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The remembered home destination outlives a test in one jsdom; start
    // every test where a first launch starts, on Projects.
    localStorage.removeItem("deckastra.home");
    decks = [
      { id: "doc_a", title: "Migration Control Tower", version_id: "ver_a", updated_at: ago(2 * HOUR), slide_count: 12, pending_proposals: 2 },
      { id: "doc_b", title: "Security Review", version_id: "ver_b", updated_at: ago(DAY + HOUR), slide_count: 9, pending_proposals: 0 },
    ];
    const deleted = new Set<string>();
    fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (path.includes("/v1/dev/session")) return reply({ token: "t", user_id: "usr_1" });
      if (path.endsWith("/v1/account")) {
        return reply({
          user: { id: "usr_1", email: "me@local", name: "Me" },
          workspaces: [
            {
              id: "wsp_1",
              name: "AgentSphere",
              role: "owner",
              origin: "local",
              access: "authoritative",
              confirmed_at: null,
              projects: [
                { id: "prj_1", name: "Migration", description: null },
                { id: "prj_2", name: "Archive", description: null },
              ],
            },
          ],
          capabilities: { sharing: false },
        });
      }
      if (path.endsWith("/v1/presets")) return reply(CATALOG);
      if (path.includes("/projects/prj_1/presentations")) {
        return reply({ presentations: decks.filter((deck) => !deleted.has(deck.id)) });
      }
      if (method === "DELETE" && path.endsWith("/v1/presentations/doc_b")) {
        deleted.add("doc_b");
        return reply({ presentation_id: "doc_b", deleted_at: ago(0) });
      }
      if (path.endsWith("/v1/presentations/doc_b/restore")) {
        deleted.delete("doc_b");
        return reply({ presentation_id: "doc_b", restored: true });
      }
      if (path.endsWith("/v1/presentations/doc_a/duplicate")) {
        decks.push({ id: "doc_copy", title: "Migration Control Tower (copy)", version_id: "v", updated_at: ago(0), slide_count: 12 });
        return reply({ presentation_id: "doc_copy", version_id: "v", title: "Migration Control Tower (copy)" });
      }
      return { ok: false, status: 404, json: async () => ({ detail: "Not found." }) };
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** "METHOD /path" for every request, without the client's base URL. */
  const calls = () =>
    fetcher.mock.calls.map(([url, init]) => {
      const { pathname } = new URL(String(url), "http://localhost");
      return `${(init as RequestInit | undefined)?.method ?? "GET"} ${pathname}`;
    });

  function renderList(onOpen = vi.fn()) {
    render(<DeckList onOpen={onOpen} openPresentationId="doc_a" />, { wrapper: withWorkspaceClient() });
    return onOpen;
  }

  it("lists the first project's decks as cards, with counts and the pending badge", async () => {
    renderList();
    const cards = await screen.findAllByTestId("deck-card");
    expect(cards).toHaveLength(2);
    const first = within(cards[0]!);
    expect(first.getByText("Migration Control Tower")).toBeTruthy();
    expect(first.getByText(/12 slides · edited/)).toBeTruthy();
    expect(first.getByText("2 pending")).toBeTruthy();
    expect(first.getByText("Open")).toBeTruthy();
    expect(screen.getByText(/2 decks · updated/)).toBeTruthy();
  });

  /** prj_2 holds one deck, and the trash holds one deleted from prj_1. */
  function withSecondProjectAndTrash() {
    const original = fetcher.getMockImplementation()!;
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    let restored = false;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("deleted=true")) {
        return reply({
          presentations:
            path.includes("prj_1") && !restored
              ? [{ id: "doc_gone", title: "Old pitch", version_id: "v", updated_at: ago(DAY), deleted_at: ago(HOUR) }]
              : [],
        });
      }
      if (path.includes("/projects/prj_2/presentations")) {
        return reply({ presentations: [{ id: "doc_z", title: "Archived plan", version_id: "v", updated_at: ago(MIN), slide_count: 3 }] });
      }
      if (path.endsWith("/v1/presentations/doc_gone/restore")) {
        restored = true;
        return reply({ presentation_id: "doc_gone", restored: true });
      }
      return original(url, init);
    });
  }

  it("shows every deck across projects, newest first, naming each one's project", async () => {
    withSecondProjectAndTrash();
    renderList();
    await screen.findAllByTestId("deck-card");
    fireEvent.click(screen.getByTestId("view-all"));
    await waitFor(() => expect(screen.getAllByTestId("deck-card")).toHaveLength(3));
    const cards = screen.getAllByTestId("deck-card");
    expect(cards[0]!.getAttribute("data-deck-id")).toBe("doc_z");
    expect(within(cards[0]!).getByText(/^Archive · 3 slides/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All decks" })).toBeTruthy();
  });

  it("lists the trash across projects and restores a deck from it", async () => {
    withSecondProjectAndTrash();
    renderList();
    await screen.findAllByTestId("deck-card");
    fireEvent.click(screen.getByTestId("view-trash"));
    const card = await screen.findByTestId("trash-card");
    expect(within(card).getByText(/^Migration · deleted /)).toBeTruthy();
    // Nothing to describe a deck into while looking at the trash.
    expect(screen.queryByTestId("generate-instruction")).toBeNull();
    fireEvent.click(within(card).getByTestId("restore-deck"));
    await waitFor(() => expect(calls()).toContain("POST /v1/presentations/doc_gone/restore"));
    await waitFor(() => expect(screen.queryByTestId("trash-card")).toBeNull());
    expect(screen.getByText(/Nothing in the trash/)).toBeTruthy();
  });

  it("opens a deck by handing its id to the shell", async () => {
    const onOpen = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Open Security Review" }));
    expect(onOpen).toHaveBeenCalledWith("doc_b");
  });

  it("deletes softly and offers an Undo that restores the same deck", async () => {
    renderList();
    await screen.findAllByTestId("deck-card");
    fireEvent.click(screen.getByRole("button", { name: "Security Review actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.getAllByTestId("deck-card")).toHaveLength(1));
    expect(calls()).toContain("DELETE /v1/presentations/doc_b");
    expect(screen.getByText("Deleted “Security Review”.")).toBeTruthy();

    fireEvent.click(screen.getByTestId("undo-delete"));
    await waitFor(() => expect(screen.getAllByTestId("deck-card")).toHaveLength(2));
    expect(calls()).toContain("POST /v1/presentations/doc_b/restore");
  });

  it("duplicates on the server and shows the copy", async () => {
    renderList();
    await screen.findAllByTestId("deck-card");
    fireEvent.click(screen.getByRole("button", { name: "Migration Control Tower actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    expect(await screen.findByText("Migration Control Tower (copy)")).toBeTruthy();
    expect(calls()).toContain("POST /v1/presentations/doc_a/duplicate");
  });

  it("filters by search without asking the server again", async () => {
    renderList();
    await screen.findAllByTestId("deck-card");
    const before = fetcher.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Search decks"), { target: { value: "security" } });
    expect(screen.getAllByTestId("deck-card")).toHaveLength(1);
    expect(fetcher.mock.calls.length).toBe(before);
  });

  // ------------------------------------------- Projects | Templates (unit 1)

  it("opens on Projects with no template card in it, and starts a deck from the strip", async () => {
    renderList();
    await screen.findAllByTestId("deck-card");
    expect(document.querySelector('[data-home-destination="projects"]')).toBeTruthy();
    expect(screen.queryByTestId("template-start")).toBeNull();
    expect(document.querySelector("[data-template-id]")).toBeNull();
    expect(screen.getByTestId("new-deck")).toBeTruthy();
  });

  it("shows the catalog on Templates with no deck card in it, and remembers going there", async () => {
    renderList();
    await screen.findAllByTestId("deck-card");
    fireEvent.click(screen.getByTestId("view-templates"));
    expect(await screen.findByTestId("use-template-business-pitch")).toBeTruthy();
    expect(screen.queryAllByTestId("deck-card")).toHaveLength(0);
    expect(screen.getByTestId("view-templates").getAttribute("aria-current")).toBe("page");
    expect(localStorage.getItem("deckastra.home")).toBe("templates");

    // A relaunch comes back to the same place.
    cleanup();
    renderList();
    expect(await screen.findByTestId("use-template-business-pitch")).toBeTruthy();
    expect(screen.queryAllByTestId("deck-card")).toHaveLength(0);
  });

  it("scopes the one search box to the destination on screen", async () => {
    renderList();
    await screen.findAllByTestId("deck-card");
    fireEvent.change(screen.getByLabelText("Search decks"), { target: { value: "security" } });
    expect(screen.getAllByTestId("deck-card")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("view-templates"));
    // Templates has its own text: the deck search does not follow it there.
    const search = await screen.findByLabelText("Search templates");
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("Search decks")).toBeNull();
    await screen.findByTestId("use-template-business-pitch");
    fireEvent.change(search, { target: { value: "security" } });
    expect(screen.queryByTestId("use-template-business-pitch")).toBeNull();
    expect(screen.getByTestId("use-template-security-brief")).toBeTruthy();

    // And back: the deck search kept its own words.
    fireEvent.click(screen.getByTestId("view-all"));
    expect((screen.getByLabelText("Search decks") as HTMLInputElement).value).toBe("security");
    expect(localStorage.getItem("deckastra.home")).toBe("projects");
  });

  it("goes to Templates from the strip and from the menu's New from template", async () => {
    let send: ((command: "generate-deck") => void) | undefined;
    render(
      <DeckList onOpen={vi.fn()} commands={(handler) => ((send = handler as typeof send), () => {})} />,
      { wrapper: withWorkspaceClient() },
    );
    await screen.findAllByTestId("deck-card");
    fireEvent.click(screen.getByTestId("browse-templates"));
    expect(await screen.findByTestId("template-start")).toBeTruthy();

    fireEvent.click(screen.getByTestId("view-all"));
    await waitFor(() => expect(screen.queryByTestId("template-start")).toBeNull());
    send?.("generate-deck");
    expect(await screen.findByTestId("template-start")).toBeTruthy();
  });

  it("lands on the decks when a deck is left through All decks, whatever the home last showed", async () => {
    withSecondProjectAndTrash();
    localStorage.setItem("deckastra.home", "templates");
    render(<DeckList onOpen={vi.fn()} startWith="all-decks" />, { wrapper: withWorkspaceClient() });
    await waitFor(() => expect(screen.getAllByTestId("deck-card").length).toBeGreaterThan(0));
    expect(screen.getByRole("heading", { name: "All decks" })).toBeTruthy();
    expect(screen.queryByTestId("template-start")).toBeNull();
    expect(localStorage.getItem("deckastra.home")).toBe("projects");
  });
});
