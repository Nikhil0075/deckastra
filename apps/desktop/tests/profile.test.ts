import { describe, expect, it } from "vitest";

import { profileOverride } from "../src/main/profile";

/**
 * Which profile a launch uses (corrected 2026-09-20, item 25).
 *
 * Small enough to look not worth testing, which is precisely why it is: the
 * failure is silent. Falling back to the real profile does not error — the app
 * starts, opens a deck, and the only sign it opened the wrong person's deck is
 * that it is the wrong deck. An acceptance run that loses its override edits
 * real work, because several steps change the deck they find on purpose.
 */

describe("the profile a launch uses", () => {
  it("honours a named profile", () => {
    expect(profileOverride({ DECKASTRA_SMOKE_PROFILE: "D:/runs/p1" })).toBe("D:/runs/p1");
  });

  it("honours it whether or not the harness is switched on", () => {
    // The bug this replaces: gated on `DECKASTRA_SMOKE_DIR`, so a process with
    // the profile and not the directory fell through to `%APPDATA%\\Deckastra`.
    // A second-instance probe is exactly that shape — the harness off, the
    // profile kept — and it started a whole app against the real profile.
    expect(profileOverride({ DECKASTRA_SMOKE_PROFILE: "D:/runs/p1", DECKASTRA_SMOKE_DIR: "D:/runs/s1" })).toBe(
      "D:/runs/p1",
    );
    expect(profileOverride({ DECKASTRA_SMOKE_PROFILE: "D:/runs/p1", DECKASTRA_SMOKE_STEP: "open" })).toBe(
      "D:/runs/p1",
    );
  });

  it("uses the ordinary profile when none is named", () => {
    expect(profileOverride({})).toBeUndefined();
  });

  it("does not let an empty value quietly mean the real profile", () => {
    // `DECKASTRA_SMOKE_PROFILE=` in a script that meant to set one is the same
    // mistake with a different spelling, and it must not read as "unset".
    expect(profileOverride({ DECKASTRA_SMOKE_PROFILE: "" })).toBeUndefined();
    expect(profileOverride({ DECKASTRA_SMOKE_PROFILE: "   " })).toBeUndefined();
  });
});
