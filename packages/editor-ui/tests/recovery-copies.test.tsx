import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import animationFixture from "@deckastra/presentation-schema/fixtures/animation-test.mydeck.json" with { type: "json" };

import { RecoveryCopies } from "../src/components/ConflictRecovery";
import { openRecoveryJournal, readRecovery, recoveryKey, type RecoveryCopy } from "../src/lib/editor-recovery";
import { groupRecoveryCopies, recoveryDetail, recoverySummary } from "../src/lib/recovery-copies";

/**
 * The notice for unsaved work other windows left behind. A desktop profile that
 * had run many smoke steps collected about twenty of these, and the old bullet
 * list pushed the canvas down to a sliver. These cases pin the new shape — one
 * line by default, grouped and bounded when opened — and that none of it
 * changes what can be recovered.
 */

const NOW = Date.parse("2026-09-19T12:00:00Z");

const copy = (key: string, title: string, extra: Partial<RecoveryCopy> = {}): RecoveryCopy => ({
  key,
  title,
  active: false,
  ...extra,
});

// This file assumes no Web Locks (each journal gets its own key). Other files
// install a fake `navigator.locks`, and in a single-process run it outlives
// them; with it, the second journal here resumed the first one's key and could
// not list it as another window's copy. Declared, not inherited.
beforeEach(() => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

describe("grouping", () => {
  it("groups by deck, newest first, with unrecorded times last", () => {
    const groups = groupRecoveryCopies([
      copy("a", "Q3 Review", { savedAt: "2026-09-19T10:00:00Z" }),
      copy("b", "Rich Man", { savedAt: "2026-09-19T11:30:00Z" }),
      copy("c", "Q3 Review"),
      copy("d", "Q3 Review", { savedAt: "2026-09-19T11:00:00Z" }),
    ]);
    expect(groups.map((group) => group.title)).toEqual(["Rich Man", "Q3 Review"]);
    expect(groups[1]!.copies.map((entry) => entry.key)).toEqual(["d", "a", "c"]);
  });

  it("reads a zone-less time as UTC, like every other server-ish timestamp", () => {
    const groups = groupRecoveryCopies([
      copy("utc", "Deck", { savedAt: "2026-09-19T11:00:00" }),
      copy("later", "Deck", { savedAt: "2026-09-19T11:30:00Z" }),
    ]);
    expect(groups[0]!.copies.map((entry) => entry.key)).toEqual(["later", "utc"]);
  });

  it("says how many and what each one holds", () => {
    expect(recoverySummary([copy("a", "x")])).toBe("1 unsaved copy from other windows");
    expect(recoverySummary([copy("a", "x"), copy("b", "y")])).toBe("2 unsaved copies from other windows");
    expect(recoveryDetail(copy("a", "x", { savedAt: "2026-09-19T11:55:00Z", changes: 3 }), NOW)).toBe(
      "Saved 5 min ago · 3 changes",
    );
    expect(recoveryDetail(copy("a", "x", { changes: 1 }), NOW)).toBe("Save time not recorded · 1 change");
  });
});

describe("the notice", () => {
  const copies = [
    copy("k1", "Q3 Review", { savedAt: "2026-09-19T11:00:00Z", changes: 2 }),
    copy("k2", "Q3 Review", { active: true, changes: 1 }),
    copy("k3", "Rich Man", { error: "The original data has been retained." }),
  ];

  function show(overrides: Partial<Parameters<typeof RecoveryCopies>[0]> = {}) {
    const props = {
      copies,
      busy: false,
      error: "",
      onRecover: vi.fn(),
      onDownload: vi.fn(),
      onRefresh: vi.fn(),
      ...overrides,
    };
    render(<RecoveryCopies {...props} />);
    return props;
  }

  it("is one line until someone asks to review", () => {
    show();
    expect(screen.getByText("3 unsaved copies from other windows")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Recover copy:/ })).toBeNull();
    expect(screen.getByTestId("recovery-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens grouped by deck, keeping the old accessible names", () => {
    const props = show();
    fireEvent.click(screen.getByTestId("recovery-toggle"));
    expect(screen.getByTestId("recovery-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Q3 Review", "Rich Man"]);

    const recover = screen.getAllByRole("button", { name: /^Recover copy:/ }) as HTMLButtonElement[];
    // Newest first: the copy with a recorded time, then the open one.
    expect(recover.map((button) => button.disabled)).toEqual([false, true, true]);
    fireEvent.click(recover[0]!);
    expect(props.onRecover).toHaveBeenCalledWith("k1");

    // A copy open elsewhere, or unreadable, can still be downloaded.
    const downloads = screen.getAllByRole("button", { name: "Download saved copy" });
    expect(downloads).toHaveLength(3);
    fireEvent.click(downloads[2]!);
    expect(props.onDownload).toHaveBeenCalledWith("k3");

    const open = screen.getByText("Open in another window").closest("li")!;
    expect(within(open).getByText(/Save time not recorded · 1 change/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh saved copies" }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("disables recovery while another is running, and shows a refusal while collapsed", () => {
    show({ busy: true, error: "That copy is still open in another tab." });
    expect(screen.getByRole("alert").textContent).toBe("That copy is still open in another tab.");
    fireEvent.click(screen.getByTestId("recovery-toggle"));
    const recover = screen.getAllByRole("button", { name: /^Recover copy:/ }) as HTMLButtonElement[];
    expect(recover.every((button) => button.disabled)).toBe(true);
  });
});

describe("the journal records when it was saved", () => {
  const deck = animationFixture as unknown as PresentationDocument;
  const record = { format: 1 as const, versionId: "v1", document: deck, operations: [], labels: [] };

  it("stamps a write, and another window sees the time and the change count", async () => {
    const first = await openRecoveryJournal("p1");
    first.write({ ...record, labels: ["Rename"], operations: [{ op: "replace", path: "/metadata/title", value: "x" }] });
    first.close();

    const second = await openRecoveryJournal("p1");
    const [found] = await second.copies();
    second.close();
    expect(found).toMatchObject({ key: first.key, changes: 1 });
    expect(Number.isFinite(Date.parse(found!.savedAt!))).toBe(true);
  });

  it("still reads a record written before the field existed, or with a broken time", () => {
    localStorage.setItem(recoveryKey("p2"), JSON.stringify(record));
    expect(readRecovery("p2")?.savedAt).toBeUndefined();
    localStorage.setItem(recoveryKey("p3"), JSON.stringify({ ...record, savedAt: 42 }));
    const read = readRecovery("p3");
    expect(read?.versionId).toBe("v1");
    expect(read?.savedAt).toBeUndefined();
  });
});
