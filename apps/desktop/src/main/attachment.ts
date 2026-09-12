import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

/**
 * How an external agent finds this app's workspace authority (milestone D2.1).
 *
 * D1 established that the service is deliberately unreachable: it binds a random
 * loopback port, requires a per-launch secret, and the renderer never learns
 * either because the main process proxies for it. That is the right posture and
 * D2 does not relax it — it adds exactly one, deliberate way in, and writes down
 * what that costs.
 *
 * **This file is a credential.** Whoever can read it can do anything the signed-in
 * user can do to their decks. Three things follow, and none of them is optional:
 *
 * - It lives in `userData`, which is inside the user's own profile and already
 *   ACL'd to them by the operating system. `0o600` is set as well, which POSIX
 *   honours and Windows ignores in favour of the inherited ACL.
 * - It is **removed when the app stops**, so a stale file cannot advertise a port
 *   that something else has since been given. A reader must still verify, because
 *   a crash removes nothing.
 * - It carries the **launch** secret, not a durable one. A file recovered from a
 *   backup authorises nothing: the secret it names died with that process.
 *
 * The alternative — having the MCP server start its own headless service — was
 * rejected outright. Two processes on one SQLite database is the corruption case
 * the single-instance lock already exists to prevent, and an agent writing to a
 * deck the user has open in an editor that knows nothing about it is worse than
 * an agent that refuses.
 */

/**
 * Bumped when a reader would misinterpret an older file.
 *
 * An attachment describes a running process, so old and new are never both
 * present — but an MCP server installed separately from the app can easily be a
 * different age than the app it finds, and "refuses with a version mismatch"
 * is a far better failure than a request shaped for a contract that changed.
 */
export const ATTACHMENT_VERSION = 1;

export interface Attachment {
  version: number;
  /** Loopback port the workspace service is listening on. */
  port: number;
  /** The per-launch bearer. Dies with the process that minted it. */
  secret: string;
  /** The desktop process. A reader checks it is alive before trusting the rest. */
  pid: number;
  /** So an agent and the user's window are looking at the same deck. */
  presentationId?: string;
  /** Informational: which build wrote this. */
  appVersion: string;
}

export function attachmentPath(): string {
  return join(app.getPath("userData"), "attachment.json");
}

/**
 * Publish the attachment, or replace the one already there.
 *
 * Written whole rather than merged: the fields describe one running service, and
 * a half-updated file after a restart would name a live port with a dead secret.
 */
export async function publishAttachment(
  service: { port: number; secret: string },
  presentationId?: string,
): Promise<void> {
  const attachment: Attachment = {
    version: ATTACHMENT_VERSION,
    port: service.port,
    secret: service.secret,
    pid: process.pid,
    appVersion: app.getVersion(),
    ...(presentationId ? { presentationId } : {}),
  };

  // Not written through a staging file and a rename, unlike `workspace.json`.
  // A torn read here costs a reader one refusal and a retry; a staging file
  // would briefly leave the secret at a second path, and a crash between the
  // write and the rename would leave it there indefinitely.
  await writeFile(attachmentPath(), JSON.stringify(attachment, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Withdraw it.
 *
 * Called on a clean shutdown and whenever the service is not there — a failed
 * start, a stop by the acceptance harness. Missing is the honest state for both:
 * the difference between "the app is not running" and "the app is running but
 * its service is down" is not one an external client can act on differently.
 */
export async function withdrawAttachment(): Promise<void> {
  try {
    await unlink(attachmentPath());
  } catch {
    // Already gone is the outcome we wanted. Any other failure is on a path the
    // app is quitting through, where a thrown error would replace a clean exit
    // with a crash report about a file nobody asked about.
  }
}
