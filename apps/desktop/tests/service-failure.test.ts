import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "" } }));

import { classifyFailure, parseServiceAnnouncement } from "../src/main/sidecar";
import { advice, worthRetrying } from "../src/renderer/ServiceFailure";

/**
 * A service that will not start is something to act on (final package review,
 * item 17). What it must never be is a dead end, and what it must never offer
 * is to clear someone's workspace to make the app run.
 */

describe("telling the failures apart", () => {
  it.each([
    ["missing", new Error("No packaged service and no repository at C:/…")],
    ["missing", new Error("spawn deckastra-service.exe ENOENT")],
    ["permission", new Error("EACCES: permission denied, open 'C:/Users/…/deckastra.db'")],
    ["permission", new Error("Access is denied.")],
    ["migration", new Error("alembic.util.exc.CommandError: Can't locate revision")],
    // An older build meeting a database a newer one wrote (item 15). Same
    // bucket, because the advice is the same one that matters: the data is
    // fine, and nothing must offer to clear it to make the app start.
    [
      "migration",
      new Error(
        "SchemaFromTheFuture: This workspace was written by a newer version of Deckastra (database revision z).",
      ),
    ],
    ["mismatch", new Error("This app and its workspace service were built from different migrations (app a, service b).")],
    ["crashed", new Error("The workspace service exited before it was ready (code 3).")],
    ["crashed", new Error("The workspace service bound a port but never answered (HTTP 500).")],
    ["unknown", new Error("something nobody has seen before")],
    ["unknown", "not even an error"],
  ])("reads %s", (kind, error) => {
    expect(classifyFailure(error)).toBe(kind);
  });
});

describe("the startup announcement protocol", () => {
  it("accepts progress before the final ready record", () => {
    expect(parseServiceAnnouncement('{"progress":"migration","message":"Upgrading workspace"}')).toEqual({
      kind: "progress",
      detail: "Upgrading workspace",
    });
    expect(parseServiceAnnouncement('{"ready":true,"port":51234}')).toEqual({
      kind: "ready",
      port: 51234,
    });
  });

  it("rejects unrelated stdout instead of treating it as readiness", () => {
    expect(() => parseServiceAnnouncement('{"hello":"world"}')).toThrow(/ready or progress/);
    expect(() => parseServiceAnnouncement("not json")).toThrow();
  });
});

describe("what a person is told", () => {
  it("never suggests clearing the workspace, whatever went wrong", () => {
    for (const kind of ["missing", "permission", "migration", "mismatch", "crashed", "unknown", undefined] as const) {
      const text = advice(kind).toLowerCase();
      // Instructions to destroy data, not the word: the migration advice says
      // "nothing has been changed or deleted", which is the opposite.
      expect(text).not.toMatch(/(delete|remove|clear|reset|wipe|erase)\s+(your|the)\s+(workspace|data|database|decks|profile)/);
      expect(text).not.toMatch(/start (over|fresh)/);
    }
  });

  it("says the data is safe when the database could not be migrated", () => {
    // The one case where starting matters less than what is on disk.
    expect(advice("migration")).toContain("still on this computer");
    expect(advice("migration")).toContain("nothing has been changed or deleted");
  });

  it("offers a retry only where one could work", () => {
    expect(worthRetrying("crashed")).toBe(true);
    expect(worthRetrying("permission")).toBe(true);
    expect(worthRetrying(undefined)).toBe(true);
    // Reinstalling is the fix for both of these; a button that cannot help is
    // a button that wastes someone's afternoon.
    expect(worthRetrying("missing")).toBe(false);
    expect(worthRetrying("mismatch")).toBe(false);
  });

  it("names reinstalling for a broken install and for a mismatched pair", () => {
    expect(advice("missing")).toContain("Reinstalling");
    expect(advice("mismatch")).toContain("Reinstall");
  });
});
