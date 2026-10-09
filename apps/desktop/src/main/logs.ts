import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * A log an installed user can hand to somebody (final package review, item 18).
 *
 * An installed launch has no terminal, so until now a failed start or a failed
 * export left nothing behind at all. These are small rotating files in the
 * profile: what the app did, and what its service printed.
 *
 * **What is written is chosen, not filtered.** The review's correction: a pass
 * that tries to recognise arbitrary document text in arbitrary output cannot be
 * relied on, so nothing here logs prompts, briefs, slide text or deck titles in
 * the first place. Our own entries are structured — an event name and named
 * fields — and the one stream that is not ours, the service's stderr, goes
 * through `redact` for the credentials whose *shape* is known: bearer tokens,
 * API keys, the launch secret. That is a narrow claim and it is the one made.
 */

const MAX_BYTES = 2 * 1024 * 1024;
/** The current file plus this many older ones. Enough for a session, bounded. */
const KEEP = 2;

export type LogStream = "app" | "service";

export function logsDir(): string {
  return join(app.getPath("userData"), "logs");
}

function file(stream: LogStream): string {
  return join(logsDir(), `${stream}.log`);
}

/**
 * Credentials whose shape is known. Not an attempt to recognise a document: a
 * generic "remove anything sensitive" pass over free text is a promise nobody
 * can keep, so what is not logged matters more than what is scrubbed.
 */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[redacted]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(authorization|x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/\b(DECKASTRA_LOCAL_SECRET|DECKASTRA_GATEWAY_SECRET|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|idToken|refreshToken|id_token|refresh_token)(=|["']?\s*[:=]\s*["']?)[^\s"',}]+/g, "$1$2[redacted]")
    // A grant is three base64url segments; the service prints one when it
    // refuses a request, and it is a working credential until it expires.
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted token]");
}

function rotate(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
  } catch {
    return; // Nothing written yet.
  }
  try {
    rmSync(`${path}.${KEEP}`, { force: true });
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      } catch {
        /* that one does not exist yet */
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    /* A log that cannot rotate must not take the app down with it. */
  }
}

/** One line of the service's own output, as it printed it. */
export function logRaw(stream: LogStream, text: string): void {
  write(stream, redact(text.replace(/\s+$/, "")));
}

/**
 * Something the app did, as an event and named fields. Values are ours — states,
 * counts, versions, error messages we produced — never user content.
 */
export function logEvent(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  write("app", redact(`${event}${parts.length ? ` ${parts.join(" ")}` : ""}`));
}

function write(stream: LogStream, line: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    const path = file(stream);
    rotate(path);
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* Logging is a convenience; it never fails the thing it was logging. */
  }
}

/** The tail of a log, for a diagnostics report. Already redacted on the way in. */
export function tail(stream: LogStream, lines = 400): string[] {
  try {
    const text = readFileSync(file(stream), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}
