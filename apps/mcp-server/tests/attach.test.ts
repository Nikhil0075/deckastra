import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_VERSION, NotRunning, attach } from "../src/attach";

/**
 * Refusing to guess (milestone D2.1).
 *
 * The attachment file is a *claim* that a workspace authority is running and can
 * be reached with a given secret, and every one of these cases is a way that
 * claim can be false while the file still exists. They matter because the
 * alternative to refusing is the thing the whole design exists to prevent: a
 * second writer against one SQLite database, or an agent editing a deck the user
 * has open in an app that will never hear about the change.
 */

let dir: string;
let path: string;

async function write(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      version: ATTACHMENT_VERSION,
      port: 51_234,
      grant: "dk1.payload.signature",
      scopes: ["read", "write", "export"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pid: process.pid,
      appVersion: "0.0.0",
      presentationId: "pres_1",
      ...overrides,
    }),
    "utf8",
  );
}

/** A service that answers `/health` only for the right bearer. */
function serviceAnswering(secret: string): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ok = headers.authorization === `Bearer ${secret}`;
    return { ok, status: ok ? 200 : 401, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deckastra-attach-"));
  path = join(dir, "attachment.json");
  process.env.DECKASTRA_ATTACHMENT = path;
});

afterEach(async () => {
  delete process.env.DECKASTRA_ATTACHMENT;
  await rm(dir, { recursive: true, force: true });
});

describe("attaching to a running app", () => {
  it("refuses when the app is not running, and says to start it", async () => {
    // The most common case by far, and the message has to reach a person: an MCP
    // client shows a failed server's stderr, and "ENOENT" there tells the user
    // nothing they can act on.
    await expect(attach()).rejects.toThrow(NotRunning);
    await expect(attach()).rejects.toThrow(/ask the user to start Deckastra/i);
  });

  it("refuses a file left behind by a process that is gone", async () => {
    // A crash removes nothing, so a stale file naming a dead pid is normal. The
    // port it names may since have been given to something else entirely.
    await write({ pid: 0x7ff_ffff });
    await expect(attach()).rejects.toThrow(/the process is gone/i);
  });

  it("refuses a version it does not speak rather than guessing", async () => {
    // This server can be installed and updated separately from the app, so a
    // mismatch is ordinary — and a request shaped for a contract that changed
    // would corrupt a document rather than fail.
    await write({ version: ATTACHMENT_VERSION + 1 });
    await expect(attach()).rejects.toThrow(/attachment version/i);
  });

  it("refuses an attachment with no grant, rather than reaching for a secret", async () => {
    // A v1 app published its own launch secret. This server will not use one.
    await write({ grant: undefined });
    await expect(attach()).rejects.toThrow(/no grant|attachment version/i);
  });

  it("refuses a grant the service no longer accepts", async () => {
    // The app restarted: the file is current-looking, the pid is alive, and the
    // secret died with the previous launch. Only the service's answer catches it.
    await write();
    await expect(attach(serviceAnswering("a-different-grant"))).rejects.toThrow(/expired|restarted/i);
  });

  it("refuses when nothing answers on the port", async () => {
    await write();
    const refusing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(attach(refusing)).rejects.toThrow(/not answering on port 51234/i);
  });

  it("attaches when the service proves it is ours", async () => {
    await write();
    const attached = await attach(serviceAnswering("dk1.payload.signature"));
    expect(attached.baseUrl).toBe("http://127.0.0.1:51234");
    // The deck the user is looking at. Without it an agent asked to "fix this
    // slide" has to guess which deck "this" is.
    expect(attached.attachment.presentationId).toBe("pres_1");
  });
});
