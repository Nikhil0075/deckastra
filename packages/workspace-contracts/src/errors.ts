/**
 * What a failed workspace request is.
 *
 * The transport is an implementation detail — HTTP today, a loopback sidecar on
 * the desktop, possibly a typed IPC channel later — so callers must not branch on
 * `Response`. They branch on this. Two fields exist because two call sites need
 * more than a message and would otherwise reach past the client to get it:
 *
 * - `status`, because a 409 from the transaction endpoint is optimistic
 *   concurrency and not an error to report as one, and a 429 from generation is a
 *   quota refusal — the system working, not something that broke.
 * - `detail`, because a quota refusal carries the limit, the usage and the reset
 *   time, and a message string cannot say those.
 */
export interface WorkspaceErrorShape {
  /** Transport status. 0 when the request never reached the authority. */
  readonly status: number;
  /** The server's `detail`, unparsed. A string, an object, or undefined. */
  readonly detail: unknown;
  readonly message: string;
}

/** Narrow a caught value to the error contract. */
export function isWorkspaceError(value: unknown): value is Error & WorkspaceErrorShape {
  return (
    value instanceof Error &&
    typeof (value as Partial<WorkspaceErrorShape>).status === "number" &&
    "detail" in value
  );
}

/** The quota refusal body (doc 01 S6). Present on a 429 from generation. */
export interface QuotaDetail {
  limit: string;
  used: number;
  allowed: number;
  resets_at: string;
}

/** Read a quota refusal out of an error, or `null` when it is not one. */
export function quotaDetail(error: unknown): QuotaDetail | null {
  if (!isWorkspaceError(error) || error.status !== 429) return null;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return null;
  return typeof (detail as QuotaDetail).limit === "string" ? (detail as QuotaDetail) : null;
}
