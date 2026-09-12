import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { app } from "electron";

/**
 * How an external agent reaches this app's workspace authority (milestone D2).
 *
 * D1 established that the service is deliberately unreachable: a random loopback
 * port, a per-launch secret, and a renderer that learns neither because the main
 * process proxies for it. D2 adds exactly one way in, and writes down its cost.
 *
 * **What it publishes is a grant, not the launch secret.** It used to be the
 * secret itself, which made "an agent cannot approve its own proposal" and "an
 * agent cannot mint a share link" true only because the MCP adapter registered no
 * such tools — an omission in one file, not a boundary. A grant carries
 * `read`, `write` and `export` and nothing else, and the *authority* refuses the
 * rest (`grants.py`). Anything that reads this file is held to the same limits.
 *
 * The rest of the posture is unchanged and still load-bearing:
 *
 * - It lives in `userData`, inside the user's own profile. `0o600` is set for
 *   POSIX, and on Windows the ACL is tightened explicitly, because Windows
 *   ignores the mode and inherited permissions are not a decision anyone made.
 * - It is **removed when the app stops**, so a stale file cannot advertise a port
 *   something else has since been given. A crash removes nothing, so a reader
 *   must still verify.
 * - The grant is signed with the **launch** secret and expires, so a file
 *   recovered from a backup authorises nothing: the key died with that process.
 */

/**
 * Bumped when a reader would misinterpret an older file.
 *
 * 2 replaced `secret` with `grant`. A v1 reader handed a grant would send it as
 * though it were the app's own credential and be puzzled by the refusals; a v2
 * reader handed a v1 file would hold far more authority than it should. Both are
 * better as a version mismatch that says which side is older.
 */
export const ATTACHMENT_VERSION = 2;

/** What an attached agent may do. Not approval: that is the human's half. */
export const GRANT_SCOPES = ["read", "write", "export"] as const;

/**
 * How long a grant lasts.
 *
 * Long enough that a day's work never trips over it, short enough that a file
 * someone copied out of a backup is useless by the time they find it. The app
 * republishes while it runs, so a live session is never cut off mid-change.
 */
export const GRANT_TTL_SECONDS = 12 * 60 * 60;

export interface Attachment {
  version: number;
  /** Loopback port the workspace service is listening on. */
  port: number;
  /** A scoped, expiring credential — never the launch secret itself. */
  grant: string;
  /** What that grant allows, so a reader can say why it was refused. */
  scopes: string[];
  /** When it stops working, ISO 8601. */
  expiresAt: string;
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

function base64url(raw: Buffer): string {
  return raw.toString("base64url");
}

/**
 * Mint a grant the service will accept for a subset of what it can do.
 *
 * The format is `dk1.<payload>.<signature>`, matching `local_mode.mint_grant`
 * byte for byte: the signature covers the payload *as sent*, so neither side
 * depends on the other's JSON spacing or key order.
 */
export function mintGrant(
  secret: string,
  scopes: readonly string[] = GRANT_SCOPES,
  ttlSeconds: number = GRANT_TTL_SECONDS,
): { grant: string; expiresAt: Date } {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + ttlSeconds;
  // `iat` is not decoration: revocation names a moment and refuses every grant
  // issued before it, so a grant that cannot say when it was issued cannot be
  // reasoned about and the authority refuses it. Leaving it out made every
  // credential this app published dead on arrival, and nothing failed loudly —
  // the app kept publishing, the agent kept being told it was unauthenticated.
  const payload = base64url(
    Buffer.from(JSON.stringify({ s: [...scopes].sort(), exp: expires, iat: issued }), "utf8"),
  );
  const signature = base64url(createHmac("sha256", secret).update(payload).digest());
  return { grant: `dk1.${payload}.${signature}`, expiresAt: new Date(expires * 1000) };
}

/**
 * Keep the file to this user on Windows, where the mode is ignored.
 *
 * `userData` is already inside the user's profile, but "already covered by an
 * inherited ACL" is a fact about a directory someone else may change. Breaking
 * inheritance and granting exactly one account states it on the file itself.
 * Best effort: a failure here is worth a line in the log, not a refusal to start.
 */
async function restrictToOwner(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const account = `${userInfo().username}`;
  await new Promise<void>((done) => {
    execFile(
      "icacls",
      [path, "/inheritance:r", "/grant:r", `${account}:F`],
      { windowsHide: true },
      (error) => {
        if (error) console.warn(`Could not restrict ${path} to ${account}:`, error.message);
        done();
      },
    );
  });
}

/**
 * Publish the attachment, or replace the one already there.
 *
 * Written whole rather than merged: the fields describe one running service with
 * one live grant, and a half-updated file after a restart would name a live port
 * with a dead credential.
 */
export async function publishAttachment(
  service: { port: number; secret: string },
  presentationId?: string,
): Promise<void> {
  const { grant, expiresAt } = mintGrant(service.secret);
  const attachment: Attachment = {
    version: ATTACHMENT_VERSION,
    port: service.port,
    grant,
    scopes: [...GRANT_SCOPES],
    expiresAt: expiresAt.toISOString(),
    pid: process.pid,
    appVersion: app.getVersion(),
    ...(presentationId ? { presentationId } : {}),
  };

  const path = attachmentPath();
  // Not written through a staging file and a rename, unlike `workspace.json`. A
  // torn read here costs a reader one refusal and a retry; a staging file would
  // briefly leave a credential at a second path, and a crash between the write
  // and the rename would leave it there indefinitely.
  await writeFile(path, JSON.stringify(attachment, null, 2), { encoding: "utf8", mode: 0o600 });
  await restrictToOwner(path);
}

/**
 * Withdraw it.
 *
 * Called on a clean shutdown and whenever the service is not there — a failed
 * start, a stop by the acceptance harness. Missing is the honest state for both:
 * the difference between "the app is not running" and "the app is running but its
 * service is down" is not one an external client can act on differently.
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
