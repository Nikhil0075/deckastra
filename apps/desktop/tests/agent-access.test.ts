import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether an agent may reach this install, remembered (D2.3) — and only for the
 * build it was granted in (item 06).
 */

const profile = mkdtempSync(join(tmpdir(), "deckastra-consent-"));
let version = "0.9.0-beta.1";

vi.mock("electron", () => ({
  app: { getPath: () => profile, getVersion: () => version },
}));

const { readAgentAccess, setAgentAccess, ACCESS_TTL_SECONDS } = await import("../src/main/agent-access");

const file = join(profile, "agent-access.json");

beforeEach(() => {
  version = "0.9.0-beta.1";
  rmSync(file, { force: true });
});

describe("agent access", () => {
  it("is off until someone says yes, and on once they have", async () => {
    expect((await readAgentAccess()).allowed).toBe(false);
    const allowed = await setAgentAccess(true);
    expect(allowed).toMatchObject({ allowed: true, scopes: ["read", "write", "export"] });
    expect((await readAgentAccess()).allowed).toBe(true);
  });

  it("is off again after an update, on the same machine and within the twelve hours", async () => {
    await setAgentAccess(true);
    // The life of a grant would have carried this across an update installed the
    // same afternoon. A permission given to one build is not given to the next.
    version = "0.9.0-beta.2";
    const after = await readAgentAccess();
    expect(after.allowed).toBe(false);
    expect(after.decidedAt).not.toBeNull();
  });

  it("is off for a decision written before builds were recorded", async () => {
    await setAgentAccess(true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete stored.version;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(stored), "utf8");
    expect((await readAgentAccess()).allowed).toBe(false);
  });

  it("lapses on its own", async () => {
    await setAgentAccess(true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    stored.expiresAt = new Date(Date.now() - 1_000).toISOString();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(stored), "utf8");
    expect((await readAgentAccess()).allowed).toBe(false);
    expect(ACCESS_TTL_SECONDS).toBe(12 * 60 * 60);
  });

  it("never hands the stored build back to the window", async () => {
    expect(await setAgentAccess(true)).not.toHaveProperty("version");
    expect(await readAgentAccess()).not.toHaveProperty("version");
  });
});
