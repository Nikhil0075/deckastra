import { describe, expect, it } from "vitest";

import { isSignInFailure, networkReply, upstreamReply } from "../src/main/gateway-reply";

const body = (reply: { body: Buffer }) => JSON.parse(reply.body.toString("utf8")) as Record<string, unknown>;

describe("the cloud bridge's answers", () => {
  it("passes a success on with its own content type", () => {
    const reply = upstreamReply(200, "audio/mpeg", Buffer.from("abc"), "req1");
    expect(reply.headers["Content-Type"]).toBe("audio/mpeg");
    expect(reply.body.toString()).toBe("abc");
  });

  it("keeps a JSON failure, adding the status and request id", () => {
    const reply = upstreamReply(502, "application/json", Buffer.from(JSON.stringify({ detail: "Translation API not enabled", code: "E_PROVIDER_FAILED" })), "req2");
    expect(body(reply)).toMatchObject({ detail: "Translation API not enabled", code: "E_PROVIDER_FAILED", upstream_status: 502, request_id: "req2" });
  });

  it("makes a plain-text, HTML or empty failure into JSON that says what happened", () => {
    expect(body(upstreamReply(500, "text/plain", Buffer.from("Internal Server Error"), null)).detail).toBe("Deckastra's cloud service failed (HTTP 500): Internal Server Error");
    expect(body(upstreamReply(502, "text/html", Buffer.from("<html><body><h1>502 Bad Gateway</h1></body></html>"), null)).detail).toMatch(/502 Bad Gateway/);
    expect(body(upstreamReply(503, null, Buffer.alloc(0), null)).detail).toBe("Deckastra's cloud service failed (HTTP 503) and gave no reason.");
    // Labelled JSON and is not.
    expect(body(upstreamReply(500, "application/json", Buffer.from("oops"), null)).code).toBe("E_UPSTREAM");
  });

  it("says sign in only for a sign-in failure, and a network failure for a network one", () => {
    expect(isSignInFailure(new Error("Sign in to use AI credits."))).toBe(true);
    expect(isSignInFailure(new TypeError("fetch failed"))).toBe(false);
    const down = networkReply(new TypeError("fetch failed"));
    expect(down.status).toBe(502);
    expect(body(down).detail).not.toMatch(/sign in/i);
    const slow = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(networkReply(slow).status).toBe(504);
  });
});
