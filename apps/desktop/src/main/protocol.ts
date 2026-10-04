import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";

/**
 * Serve the renderer from a real origin instead of `file://`.
 *
 * This is not cosmetic. A `file://` page has an **opaque origin**, and three
 * things the editor already depends on stop working there:
 *
 * - `localStorage` throws rather than returning empty, so the recovery journal —
 *   the thing that holds a user's unsaved work across a crash — cannot be written.
 * - `navigator.locks` is unavailable outside a secure context, and the journal
 *   uses an exclusive lock to decide which window owns it.
 * - `BroadcastChannel` never delivers, so present mode's two windows cannot find
 *   each other.
 *
 * A custom scheme registered as `standard` and `secure` gives a stable origin
 * that survives reinstalls, satisfies all three, and — unlike a loopback HTTP
 * server — is not reachable from anything else on the machine.
 */
export const APP_SCHEME = "deckastra";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/**
 * The workspace service, on the renderer's own origin.
 *
 * A reserved path rather than a second host, and that is the whole design. Same
 * origin means no CORS, no preflight, and `connect-src 'self'` — but far more
 * importantly it means the page never learns the loopback port or the bearer
 * token, because the main process holds both and injects them here. A
 * compromised renderer cannot reach the service except through the requests this
 * proxy is willing to make, and nothing else on the machine can reach it at all.
 */
export const API_PREFIX = "/__api/";
export const API_BASE = `${APP_ORIGIN}${API_PREFIX.slice(0, -1)}`;

/** Must run before `app.whenReady()`; Chromium fixes the scheme table at startup. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // No `allowServiceWorkers`: nothing here needs one, and a service worker
        // is a cache that outlives the code that installed it.
      },
    },
  ]);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/**
 * The Content-Security-Policy the renderer runs under.
 *
 * `default-src 'none'` and then only what the editor actually needs. Two entries
 * carry the weight:
 *
 * - **`connect-src 'self'` and nothing else.** The only thing the page can reach
 *   is the service proxy on this origin. It cannot name another host, and it
 *   cannot reach the loopback port even if it somehow learned the number. A
 *   document that could make the renderer fetch a URL is an SSRF primitive with
 *   the user's network position.
 * - **`style-src 'unsafe-inline'`.** The renderer is inline-style-driven by
 *   design — the scene resolves to concrete numbers and React writes them as
 *   style attributes. Removing it would mean a nonce on every element.
 */
const CSP = [
  "default-src 'none'",
  // `'self'` throughout. The earlier version wrote the scheme as a quoted source
  // (`'deckastra:'`), which is not valid CSP — Chromium ignored the whole entry
  // and said so in a console nobody was reading. And `style-src` without a source
  // allowed inline styles while **blocking the app's own stylesheet**, so the
  // desktop build ran unthemed from D0 until the acceptance harness started
  // recording console output.
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The workspace service, and nothing else. `'self'` covers it because the
  // proxy lives on this origin; a page that tried to reach any other host — or
  // the loopback port directly, if it somehow learned it — is refused here.
  "connect-src 'self'",
  // Narration and sounds (integration plan 01 §3.4): recordings come through
  // the service proxy on this origin, and a fresh recording or a decoded file
  // plays from a blob. Never another host — the same rule as `connect-src`.
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Serve `root` under the app scheme.
 *
 * Path traversal is refused by resolving against the root and checking the
 * result is still inside it — `..` in a URL is not exotic, and the renderer is
 * the one place a malicious document gets to influence a string.
 */
export interface ServeOptions {
  /** Where the workspace service is listening, once it has announced itself. */
  service: () => { port: number; secret: string } | null;
}

export function serveRenderer(root: string, options: ServeOptions): void {
  const base = resolve(root);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);

    if (url.pathname.startsWith(API_PREFIX)) {
      return proxyToService(request, url, options.service());
    }

    const requested = decodeURIComponent(url.pathname);
    const relative = normalize(requested).replace(/^[/\\]+/, "");
    const file = resolve(join(base, relative === "" ? "index.html" : relative));

    if (file !== base && !file.startsWith(base + sep)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const info = await stat(file);
      if (!info.isFile()) return new Response("Not found", { status: 404 });
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-security-policy": CSP,
        // The renderer is served from disk and never embedded anywhere.
        "x-content-type-options": "nosniff",
      },
    });
  });
}

/**
 * Forward one request to the workspace service.
 *
 * Deliberately not a general proxy. It rebuilds the request rather than passing
 * it through, so the page cannot decide what reaches the service:
 *
 * - **The path is re-derived** from this origin's URL, so it cannot name another
 *   host, and the query string is carried but the fragment is not.
 * - **Headers are an allowlist.** `Authorization` is set here and *only* here; a
 *   page that sent its own would have it discarded, which is what makes "the
 *   renderer never holds the token" true rather than merely intended.
 * - **Redirects are not followed.** The service does not issue any, and following
 *   one would let a bug there turn this into a request to somewhere else.
 */
async function proxyToService(
  request: Request,
  url: URL,
  service: { port: number; secret: string } | null,
): Promise<Response> {
  if (!service) {
    // Starting, restarting, or failed. 503 rather than a hang: the editor shows
    // a refusal it can retry, and a spinner that never resolves is the worst
    // possible report of "the service is down".
    return new Response(JSON.stringify({ detail: "The workspace service is not running." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const target = `http://127.0.0.1:${service.port}${url.pathname.slice(API_PREFIX.length - 1)}${url.search}`;

  const headers = new Headers();
  headers.set("authorization", `Bearer ${service.secret}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  try {
    const response = await fetch(target, init);
    const out = new Headers();
    // Only what the client needs to read the body. Copying the service's headers
    // wholesale would hand the page whatever it sets next.
    for (const name of ["content-type", "content-disposition", "cache-control"]) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: out });
  } catch (error) {
    return new Response(
      JSON.stringify({ detail: error instanceof Error ? error.message : "The workspace service is unreachable." }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
}
