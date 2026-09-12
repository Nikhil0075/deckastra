import type { WorkspaceErrorShape } from "@deckastra/workspace-contracts";

/**
 * A refusal from the workspace authority.
 *
 * Carries the status and the raw `detail` alongside the message because two
 * callers legitimately need more than a sentence: a 409 from the transaction
 * endpoint is optimistic concurrency, which the autosave queue handles rather
 * than reports, and a 429 from generation is a quota refusal carrying the limit,
 * the usage and the reset time. Without those fields both would have to reach
 * past the client to a `Response` that the desktop transport does not have.
 */
export class WorkspaceRequestError extends Error implements WorkspaceErrorShape {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = "WorkspaceRequestError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Turn a `detail` into something worth showing a person.
 *
 * FastAPI answers with a string for a plain refusal and an object for a
 * structured one, and the panels already depend on both being unwrapped this way.
 * Kept verbatim from the three copies it replaces so no message changes wording.
 */
export function messageFromDetail(detail: unknown, status: number, fallback?: string): string {
  if (typeof detail === "string" && detail) return detail;
  if (detail && typeof detail === "object") {
    const nested = (detail as { message?: unknown }).message;
    if (typeof nested === "string" && nested) return nested;
  }
  return fallback ?? `Request failed (${status})`;
}
