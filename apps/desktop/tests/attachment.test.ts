import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Publishing the way in, and taking it away again (milestone D2.1).
 *
 * The attachment is a credential on disk. What these cases pin is the lifecycle
 * around it rather than its contents: it is written whole, it carries the launch
 * secret rather than a durable one, and it goes away when the service does — so
 * an agent connecting during an outage is told the app is unavailable instead of
 * being handed a port that stopped answering.
 */

let dir: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => dir,
    getVersion: () => "1.2.3",
  },
}));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deckastra-attachment-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("the attachment file", () => {
  it("names the port, the secret and the process that owns them", async () => {
    const { attachmentPath, publishAttachment } = await import("../src/main/attachment");
    await publishAttachment({ port: 51_234, secret: "launch-secret" }, "pres_1");

    const written = JSON.parse(await readFile(attachmentPath(), "utf8"));
    expect(written).toMatchObject({
      version: 2,
      port: 51_234,
      pid: process.pid,
      presentationId: "pres_1",
      appVersion: "1.2.3",
      scopes: ["read", "write", "export"],
    });

    // Never the launch secret itself. That was the hole: anything reading this
    // file held the app's own authority, and the refusals an agent lives under
    // were only the tools its adapter happened to register.
    expect(JSON.stringify(written)).not.toContain("launch-secret");

    // A grant this process signed, for exactly those capabilities, with an end.
    const parts = String(written.grant).split(".");
    expect(parts[0]).toBe("dk1");
    const payload = parts[1]!;
    expect(createHmac("sha256", "launch-secret").update(payload).digest("base64url")).toBe(parts[2]);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(claims.s).toEqual(["export", "read", "write"]);
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    expect(new Date(written.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The pid is what lets a reader tell a live app from a file a crash left
    // behind, and the port it names may since have gone to something else.
    expect(written.pid).toBe(process.pid);
  });

  it("asks the filesystem to keep it to this user where that means anything", async () => {
    const { attachmentPath, publishAttachment } = await import("../src/main/attachment");
    await publishAttachment({ port: 1, secret: "s" });

    const mode = (await stat(attachmentPath())).mode & 0o777;
    // POSIX honours this; Windows ignores it in favour of the ACL inherited from
    // the user's own profile directory, which is where this file lives.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    else expect(mode).toBeGreaterThan(0);
  });

  it("replaces the whole file rather than merging into it", async () => {
    const { attachmentPath, publishAttachment } = await import("../src/main/attachment");
    await publishAttachment({ port: 1, secret: "first" }, "pres_1");
    // A restart comes back on a different port. A merged write would leave the
    // old port beside the new secret, which is a file that describes no service.
    await publishAttachment({ port: 2, secret: "second" });

    const written = JSON.parse(await readFile(attachmentPath(), "utf8"));
    expect(written.port).toBe(2);
    // Signed by the second secret, so a grant from the first launch is refused.
    const parts = String(written.grant).split(".");
    expect(createHmac("sha256", "second").update(parts[1]!).digest("base64url")).toBe(parts[2]);
    expect(written.presentationId).toBeUndefined();
  });

  it("withdraws it, and withdrawing twice is not an error", async () => {
    const { attachmentPath, publishAttachment, withdrawAttachment } = await import(
      "../src/main/attachment"
    );
    await publishAttachment({ port: 1, secret: "s" });
    await withdrawAttachment();

    await expect(readFile(attachmentPath(), "utf8")).rejects.toThrow();
    // Called on a quit path, where a thrown error would replace a clean exit
    // with a crash report about a file nobody asked about.
    await expect(withdrawAttachment()).resolves.toBeUndefined();
  });
});
