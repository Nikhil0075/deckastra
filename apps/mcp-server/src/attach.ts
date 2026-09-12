import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Finding the running desktop app, and refusing when there isn't one (D2.1).
 *
 * The rule this module exists to enforce: **if the app is not running, refuse.**
 * The tempting alternative is to start a headless service of our own, and it is
 * wrong twice over. Two processes on one SQLite database is the corruption case
 * the app's single-instance lock already exists to prevent; and an agent writing
 * to a deck while the user has it open in an editor that never hears about the
 * change would show them a stale document and then a conflict they did not cause.
 *
 * Everything here is verification. The attachment file is a *claim* about a
 * running process, and three things can make it false: the app crashed without
 * removing it, the app was reinstalled at a different version, or something else
 * on the machine now holds that port. So the file is a starting point and the
 * service's own answer is the proof.
 */

/** The contract the desktop writes. Kept in step with `attachment.ts` there. */
export const ATTACHMENT_VERSION = 1;

export interface Attachment {
  version: number;
  port: number;
  secret: string;
  pid: number;
  presentationId?: string;
  appVersion: string;
}

export class NotRunning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRunning";
  }
}

/**
 * Where Electron puts `userData` for this product, per platform.
 *
 * Duplicated from Electron's own rule rather than imported, because importing
 * `electron` from a stdio process would pull in a whole browser to read one
 * path. `DECKASTRA_ATTACHMENT` overrides it — a portable install, an unusual
 * profile, and the tests, which must never depend on the developer's real app
 * having been launched.
 */
export function attachmentPath(): string {
  const override = process.env.DECKASTRA_ATTACHMENT;
  if (override) return override;

  const product = "Deckastra";
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), product, "attachment.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", product, "attachment.json");
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), product, "attachment.json");
}

/** Is that process still there? Signal 0 asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which is not our app
    // but is emphatically not "gone" — reporting it as a stale file would send
    // the reader looking for a crash that never happened.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Attached {
  attachment: Attachment;
  baseUrl: string;
}

/**
 * Read the attachment and prove it describes something answering right now.
 *
 * Every refusal names what to do about it. An MCP server's errors are read by a
 * model deciding what to try next, and "connection failed" invites a retry loop
 * where "the app is not running, ask the user to start Deckastra" does not.
 */
export async function attach(fetchImpl: typeof fetch = fetch): Promise<Attached> {
  const path = attachmentPath();

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new NotRunning(
      "Deckastra is not running. Its workspace is only reachable while the app is open — " +
        "ask the user to start Deckastra, then try again.",
    );
  }

  let attachment: Attachment;
  try {
    attachment = JSON.parse(raw) as Attachment;
  } catch {
    throw new NotRunning(`Deckastra's attachment file at ${path} is unreadable. Restarting the app rewrites it.`);
  }

  if (attachment.version !== ATTACHMENT_VERSION) {
    // Deliberately fatal rather than best-effort. This server can be installed
    // and updated separately from the app, so a mismatch is ordinary — and
    // guessing at a contract that changed would corrupt documents rather than
    // fail.
    throw new NotRunning(
      `This MCP server speaks attachment version ${ATTACHMENT_VERSION} and Deckastra ` +
        `${attachment.appVersion} wrote version ${attachment.version}. Update whichever is older.`,
    );
  }

  if (!alive(attachment.pid)) {
    throw new NotRunning(
      "Deckastra left an attachment behind but the process is gone — it was probably killed. " +
        "Start the app again to reconnect.",
    );
  }

  const baseUrl = `http://127.0.0.1:${attachment.port}`;

  // The proof. The file says a port; only an answer authenticated with the
  // launch secret says it is *our* service. Something else holding that port
  // would fail this, and a stale secret from a crashed launch fails it too.
  let health: Response;
  try {
    health = await fetchImpl(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${attachment.secret}` },
    });
  } catch (error) {
    throw new NotRunning(
      `Deckastra's workspace service is not answering on port ${attachment.port} ` +
        `(${error instanceof Error ? error.message : String(error)}). It may still be starting.`,
    );
  }

  if (!health.ok) {
    throw new NotRunning(
      health.status === 401 || health.status === 403
        ? "Deckastra's workspace service refused this launch secret. The app has restarted since " +
          "this attachment was written; reconnect to pick up the new one."
        : `Deckastra's workspace service answered ${health.status}. The app may still be starting.`,
    );
  }

  return { attachment, baseUrl };
}
