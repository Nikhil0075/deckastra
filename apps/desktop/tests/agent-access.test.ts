import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether an agent may reach this install (milestone D2.3).
 *
 * The credential an agent holds is already narrow, and narrow is not the same as
 * asked for: an app that published one the moment it started would have decided
 * on the user's behalf that anything able to read one file may edit their decks.
 * These cases pin the decision — off until someone says otherwise, and not
 * forever once they do.
 */

let dir: string;

vi.mock("electron", () => ({ app: { getPath: () => dir, getVersion: () => "1.2.3" } }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deckastra-access-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("agent access", () => {
  it("is off on a fresh install, and off after an update that had it on", async () => {
    const { readAgentAccess } = await import("../src/main/agent-access");
    expect(await readAgentAccess()).toMatchObject({ allowed: false, scopes: [] });

    // A file from an older build that never knew about consent: still off,
    // because nobody granted anything.
    await writeFile(join(dir, "agent-access.json"), JSON.stringify({ scopes: ["read"] }), "utf8");
    expect((await readAgentAccess()).allowed).toBe(false);
  });

  it("allows read, write and export — never approving or sharing", async () => {
    const { readAgentAccess, setAgentAccess, AGENT_SCOPES } = await import("../src/main/agent-access");
    const granted = await setAgentAccess(true);

    expect(granted.allowed).toBe(true);
    expect(granted.scopes).toEqual(["read", "write", "export"]);
    expect(AGENT_SCOPES).not.toContain("approve");
    expect(AGENT_SCOPES).not.toContain("share");
    expect(await readAgentAccess()).toMatchObject({ allowed: true });
  });

  it("lapses, so a permission granted once is not true for ever", async () => {
    const { readAgentAccess, setAgentAccess } = await import("../src/main/agent-access");
    await setAgentAccess(true);

    // Twelve hours on, the same file reads as off — and still says when it ended.
    const stored = JSON.parse(await readFile(join(dir, "agent-access.json"), "utf8"));
    await writeFile(
      join(dir, "agent-access.json"),
      JSON.stringify({ ...stored, expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      "utf8",
    );
    const lapsed = await readAgentAccess();
    expect(lapsed.allowed).toBe(false);
    expect(lapsed.expiresAt).toBeTruthy();
  });

  it("remembers being turned off", async () => {
    const { readAgentAccess, setAgentAccess } = await import("../src/main/agent-access");
    await setAgentAccess(true);
    const stopped = await setAgentAccess(false);

    expect(stopped.allowed).toBe(false);
    expect(stopped.scopes).toEqual([]);
    expect(stopped.expiresAt).toBeNull();
    // When they decided is kept: "who could do this, and when did that stop" is
    // the question asked afterwards.
    expect(stopped.decidedAt).toBeTruthy();
    expect((await readAgentAccess()).allowed).toBe(false);
  });

  it("asks the service to refuse grants it already signed", async () => {
    const { revokeIssuedGrants } = await import("../src/main/agent-access");
    const calls: { url: string; authorization?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, authorization: headers.authorization });
      return { ok: true } as Response;
    });

    expect(await revokeIssuedGrants({ port: 4321, secret: "launch-secret" })).toBe(true);
    // With the launch secret, because only the app's own credential carries
    // `administer` — an agent that could revoke grants could revoke someone
    // else's. And withdrawing the file alone would leave a live grant working.
    expect(calls[0]!.url).toBe("http://127.0.0.1:4321/v1/local/agent-access/revoke");
    expect(calls[0]!.authorization).toBe("Bearer launch-secret");
    vi.unstubAllGlobals();
  });

  it("does not fail the user's click when the service is not answering", async () => {
    const { revokeIssuedGrants } = await import("../src/main/agent-access");
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    // Nothing live to revoke, and the attachment is withdrawn either way.
    expect(await revokeIssuedGrants({ port: 1, secret: "s" })).toBe(false);
    vi.unstubAllGlobals();
  });
});
