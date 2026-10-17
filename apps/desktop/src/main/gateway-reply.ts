/**
 * What the desktop's cloud bridge hands its local service (release 8,
 * 2026-10-17).
 *
 * The bridge used to label every upstream answer `application/json` and turn
 * every failure into "Sign in to use Deckastra AI credits." So a hosted 500
 * with a plain-text body reached the Python client as "JSON" it could not
 * parse (`JSONDecodeError`), and a dropped connection told a signed-in person
 * to sign in. Both hid the real cause.
 *
 * Now: a success keeps the upstream content type; a failure is always JSON
 * with a `detail` a person can read, the upstream status and request id, and a
 * `code` saying which kind of failure it was. "Sign in" is said only when the
 * account has no usable sign-in.
 */

export interface BridgeReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const LIMIT = 600;

function json(status: number, value: Record<string, unknown>, requestId?: string | null): BridgeReply {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    },
    body: Buffer.from(JSON.stringify(value)),
  };
}

/** Readable words from an HTML error page or plain text, or nothing. */
function plainWords(text: string): string {
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, LIMIT);
}

/** The upstream answer, passed on — or, for a failure, made into JSON the client can always read. */
export function upstreamReply(status: number, contentType: string | null, body: Buffer, requestId: string | null): BridgeReply {
  const type = (contentType ?? "").toLowerCase();
  if (status >= 200 && status < 300) {
    return {
      status,
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Cache-Control": "no-store",
        ...(requestId ? { "X-Request-ID": requestId } : {}),
      },
      body,
    };
  }
  if (type.includes("json")) {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        return json(status, { ...value, upstream_status: status, request_id: value.request_id ?? requestId ?? null }, requestId);
      }
    } catch {
      /* Labelled JSON and is not: described below like any other body. */
    }
  }
  const words = plainWords(body.toString("utf8"));
  const detail = words
    ? `Deckastra's cloud service failed (HTTP ${status}): ${words}`
    : status === 401
      ? "Sign in to use Deckastra AI credits."
      : `Deckastra's cloud service failed (HTTP ${status}) and gave no reason.`;
  return json(status, { detail, code: status === 401 ? "E_SIGN_IN" : "E_UPSTREAM", upstream_status: status, request_id: requestId }, requestId);
}

/** No usable sign-in on this machine: the one case where "sign in" is the fix. */
export function signInReply(reason: string): BridgeReply {
  return json(401, { detail: reason || "Sign in to use Deckastra AI credits.", code: "E_SIGN_IN" });
}

/** The cloud could not be reached at all: a network failure, never a sign-in one. */
export function networkReply(error: unknown): BridgeReply {
  const name = error instanceof Error ? error.name : "";
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return json(timedOut ? 504 : 502, {
    detail: timedOut
      ? "Deckastra's cloud service did not answer in time. Try again."
      : "The desktop could not reach Deckastra's cloud service. Check the connection and try again.",
    code: timedOut ? "E_GATEWAY_TIMEOUT" : "E_GATEWAY_NETWORK",
  });
}

/** Whether a failure to get a token means the person must sign in, or something else went wrong. */
export function isSignInFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sign in/i.test(message);
}
