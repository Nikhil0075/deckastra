import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profile = mkdtempSync(join(tmpdir(), "deckastra-logs-"));
// Mutable so one case can point the profile somewhere that cannot be written.
let where = profile;

vi.mock("electron", () => ({
  app: { getPath: () => where, getVersion: () => "0.9.0-beta.1", isPackaged: false },
}));

const { logEvent, logRaw, logsDir, redact, tail } = await import("../src/main/logs");

/**
 * What an installed user can send (final package review, item 18).
 *
 * The claim these hold to is narrow on purpose, after the review's correction:
 * user-written content is never logged, and the credentials whose *shape* is
 * known are removed. There is no claim to recognise arbitrary document text in
 * arbitrary output, because that is a promise nobody can keep.
 */

beforeEach(() => {
  where = profile;
  for (const name of ["app.log", "service.log", "app.log.1", "service.log.1"]) {
    const file = join(logsDir(), name);
    if (existsSync(file)) writeFileSync(file, "", "utf8");
  }
});

describe("redaction", () => {
  it.each([
    ["an API key", "using sk-ant-api03-Aa0_Bb1-Cc2dd33eeFF", "sk-ant-api03"],
    ["a bearer token", "authorization: Bearer abcdef1234567890xyz", "abcdef1234567890xyz"],
    ["a header assignment", 'x-api-key: "abcdef1234567890"', "abcdef1234567890"],
    ["the launch secret", "DECKASTRA_LOCAL_SECRET=8Ie2s0_secretvalue-here", "8Ie2s0_secretvalue-here"],
    ["an agent grant", "refused eyJhbGciOi.eyJzY29wZXMi.c2lnbmF0dXJl for /v1/account", "eyJhbGciOi.eyJzY29wZXMi"],
  ])("removes %s", (_name, line, secret) => {
    const cleaned = redact(line);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain("redacted");
  });

  it("leaves an ordinary message alone, so a report is still worth reading", () => {
    const line = "The workspace service exited before it was ready (code 3).";
    expect(redact(line)).toBe(line);
  });
});

describe("the log files", () => {
  it("records the app's own events as fields, and the service's output as it printed it", () => {
    logEvent("service.status", { state: "failed", kind: "permission", attempt: 2 });
    logRaw("service", "INFO  [alembic.runtime.migration] Running upgrade -> d94c1ba7f082\n");

    expect(tail("app").join("\n")).toContain('service.status state="failed" kind="permission" attempt="2"');
    expect(tail("service").join("\n")).toContain("Running upgrade");
  });

  it("redacts what the service prints, before it reaches the file", () => {
    logRaw("service", "GET /v1/account authorization: Bearer 0123456789abcdefghij -> 401");
    const written = readFileSync(join(logsDir(), "service.log"), "utf8");
    expect(written).not.toContain("0123456789abcdefghij");
    expect(written).toContain("[redacted]");
  });

  it("keeps a bound on what it writes", () => {
    // Rotation is what stops a long-running app filling a user's disk.
    for (let index = 0; index < 1_200; index += 1) logRaw("service", `line ${index} ${"x".repeat(4_000)}`);
    expect(statSync(join(logsDir(), "service.log")).size).toBeLessThan(3 * 1024 * 1024);
    expect(existsSync(join(logsDir(), "service.log.1"))).toBe(true);
  }, 60_000);

  it("never fails the thing it was logging", () => {
    // A profile that cannot hold a logs directory — here, a file where the
    // directory would go. Logging is a convenience; it must not take the app
    // down with it.
    const blocked = join(profile, "blocked-profile");
    writeFileSync(blocked, "not a directory", "utf8");
    where = blocked;
    expect(() => logEvent("service.status", { state: "ready" })).not.toThrow();
    expect(() => logRaw("service", "anything")).not.toThrow();
    expect(tail("app")).toEqual([]);
  });
});
