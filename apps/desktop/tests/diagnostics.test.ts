import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const profile = mkdtempSync(join(tmpdir(), "deckastra-diag-"));

vi.mock("electron", () => ({
  app: { getPath: () => profile, getVersion: () => "0.9.0-beta.1", isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^sealed:/, ""),
  },
}));

const { setCloudKey } = await import("../src/main/cloud-key");
const { setAgentAccess } = await import("../src/main/agent-access");
const { logEvent, logRaw } = await import("../src/main/logs");
const { collectDiagnostics, diagnosticsFilename } = await import("../src/main/diagnostics");

/**
 * A report someone can send (final package review, item 18): enough to explain
 * a failure, and nothing that is theirs to keep.
 */

const KEY = "sk-ant-api03-a-real-looking-key-value-000";

describe("a diagnostics report", () => {
  it("carries the build, the machine and why the service is not running", async () => {
    const report = await collectDiagnostics({
      status: { state: "failed", detail: "The workspace service exited before it was ready (code 3).", kind: "crashed", attempt: 2 },
      service: null,
      dataDir: join(profile, "workspace"),
    });

    expect(report.app.version).toBe("0.9.0-beta.1");
    expect(report.runtime.platform).toContain(process.platform);
    expect(report.service).toMatchObject({ state: "failed", kind: "crashed", attempt: 2 });
    expect(report.service.detail).toContain("code 3");
    expect(report.dataDir).toContain("workspace");
    // The service was not running, so this says so rather than claiming a route.
    expect(report.generation).toHaveProperty("error");
  });

  it("says whether a key is set, and never what it is", async () => {
    await setCloudKey(KEY);
    await setAgentAccess(true);
    logEvent("service.status", { state: "failed", kind: "permission", attempt: 1 });
    logRaw("service", `GET /v1/account authorization: Bearer 0123456789abcdefghij -> 401`);
    logRaw("service", `env ANTHROPIC_API_KEY=${KEY}`);

    const report = await collectDiagnostics({
      status: { state: "ready", attempt: 0 },
      service: null,
      dataDir: profile,
    });
    const text = JSON.stringify(report);

    expect(report.account.signedIn).toBe(false);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("0123456789abcdefghij");
    // Whether an agent may reach this install, never the credential it holds.
    expect(report.agentAccess.allowed).toBe(true);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    // Still worth reading.
    expect(text).toContain("service.status");
    await setCloudKey(null);
    await setAgentAccess(false);
  });

  it("names the build and the time in its filename", () => {
    expect(diagnosticsFilename()).toMatch(/^deckastra-diagnostics-0\.9\.0-beta\.1-\d{4}-\d{2}-\d{2}T/);
    expect(diagnosticsFilename().endsWith(".json")).toBe(true);
  });
});
