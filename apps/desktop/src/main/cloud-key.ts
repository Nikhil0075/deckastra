import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";

/**
 * The user's cloud API key, kept by the operating system (final package review,
 * item 23).
 *
 * Encrypted with `safeStorage` — DPAPI on Windows, the Keychain on macOS — so
 * the bytes on disk are useless to another account, and written with the same
 * ownership the agent attachment uses. **It never goes back to the renderer.**
 * The page asks whether a key is set and when it was set, and nothing else: a
 * window that could read it is a window that could send it somewhere.
 *
 * Refusing to store it in the clear is deliberate. Where `safeStorage` is
 * unavailable the answer is "this machine cannot keep it safely", not a plain
 * file with the user's credential in it.
 */

const FILE = "cloud-key.json";

export interface CloudKeyState {
  /** Whether a key is stored. Never the key. */
  set: boolean;
  /** When it was stored, ISO 8601. */
  updatedAt: string | null;
  /** Whether this machine can store one at all. */
  storable: boolean;
}

interface Stored {
  version: 1;
  /** `safeStorage` ciphertext, base64. */
  secret: string;
  updatedAt: string;
}

function path(): string {
  return join(app.getPath("userData"), FILE);
}

async function read(): Promise<Stored | null> {
  try {
    const parsed = JSON.parse(await readFile(path(), "utf8")) as Stored;
    return parsed?.version === 1 && typeof parsed.secret === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Only the main process calls this, and only to hand the key to the service it
 * starts. Returns null when there is none, or when it cannot be decrypted — a
 * key encrypted for another account, after a profile was copied between
 * machines, is not an error to crash on.
 */
export async function readCloudKey(): Promise<string | null> {
  const stored = await read();
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored.secret, "base64")) || null;
  } catch {
    return null;
  }
}

export async function cloudKeyState(): Promise<CloudKeyState> {
  const stored = await read();
  return {
    set: stored !== null,
    updatedAt: stored?.updatedAt ?? null,
    storable: safeStorage.isEncryptionAvailable(),
  };
}

/** What a key may look like, before anything is stored or spawned with it. */
export function checkKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 20 || trimmed.length > 500) {
    throw new Error("That does not look like an API key. Paste the whole key from the Anthropic console.");
  }
  // It becomes an environment variable for a child process. A newline or a null
  // in one is not a key, whatever else it is.
  if (/[\s\0]/.test(trimmed)) throw new Error("An API key cannot contain spaces or line breaks.");
  return trimmed;
}

/** Store a key, or remove the stored one with `null`. */
export async function setCloudKey(key: string | null): Promise<CloudKeyState> {
  if (key === null) {
    await rm(path(), { force: true });
    return cloudKeyState();
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer cannot store a key securely, so Deckastra will not store one at all. Use an AI agent instead.",
    );
  }
  const stored: Stored = {
    version: 1,
    secret: safeStorage.encryptString(checkKey(key)).toString("base64"),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path(), JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  await restrictToOwner(path());
  return cloudKeyState();
}

/**
 * Windows ignores the mode, and an inherited permission is not a decision
 * anybody made. Same treatment as the agent attachment.
 */
async function restrictToOwner(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  const account = `${userInfo().username}`;
  await new Promise<void>((done) => {
    execFile("icacls", [file, "/inheritance:r", "/grant:r", `${account}:F`], { windowsHide: true }, (error) => {
      if (error) console.warn(`Could not restrict ${file} to ${account}:`, error.message);
      done();
    });
  });
}
