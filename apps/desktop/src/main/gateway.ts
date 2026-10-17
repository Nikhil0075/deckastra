import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { accountToken } from "./account";
import { cloudConfig } from "./cloud";
import { isSignInFailure, networkReply, signInReply, upstreamReply, type BridgeReply } from "./gateway-reply";

let environment: NodeJS.ProcessEnv | null = null;

/** Private loopback bridge: the sidecar gets a per-launch secret, never Google credentials. */
export async function gatewayEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (environment) return environment;
  const secret = randomBytes(32).toString("base64url");
  const deviceFile = join(app.getPath("userData"), "device-id");
  let deviceId = "";
  try { deviceId = await readFile(deviceFile, "utf8"); } catch { /* new profile */ }
  if (!/^[a-f0-9-]{36}$/.test(deviceId)) {
    deviceId = randomUUID(); await writeFile(deviceFile, deviceId, { mode: 0o600 });
  }
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}` || request.headers.origin) {
      response.writeHead(401); response.end(); return;
    }
    const paths: Record<string, string> = {
      "/infer": "/v1/assistant/infer", "/video": "/v1/assistant/video",
      "/quote": "/v1/assistant/quote", "/translate": "/v1/assistant/translate", "/speech": "/v1/assistant/speech",
      "/capabilities": "/v1/account/capabilities", "/credits": "/v1/account/credits",
    };
    // The voice list is the one read that names something: a language tag,
    // checked here so nothing else can ride along in the query.
    const voices = /^\/voices\?locale=([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})$/.exec(request.url ?? "");
    const path = voices ? `/v1/speech/voices?locale=${voices[1]}` : paths[request.url ?? ""];
    if (!path || request.method !== (["/infer", "/video", "/quote", "/translate", "/speech"].includes(request.url ?? "") ? "POST" : "GET")) {
      response.writeHead(404); response.end(); return;
    }
    const send = (reply: BridgeReply) => {
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
    };
    let token: string;
    try {
      token = await accountToken();
    } catch (error) {
      // Only a missing or refused sign-in says "sign in"; a renewal that could
      // not reach Google is a network failure (release 8, 2026-10-17).
      send(isSignInFailure(error) ? signInReply(error instanceof Error ? error.message : "") : networkReply(error));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8_000_000) { response.writeHead(413); response.end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const upstream = await fetch(cloudConfig().apiUrl + path, { method: request.method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Deckastra-Device": deviceId },
        ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        redirect: "error", signal: AbortSignal.timeout(request.url === "/video" ? 600_000 : 210_000) });
      send(upstreamReply(upstream.status, upstream.headers.get("content-type"), Buffer.from(await upstream.arrayBuffer()),
        upstream.headers.get("x-request-id")));
    } catch (error) {
      send(networkReply(error));
    }
  });
  server.requestTimeout = 240_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The AI gateway bridge could not start.");
  server.unref();
  environment = { DECKASTRA_GATEWAY_URL: `http://127.0.0.1:${address.port}`, DECKASTRA_GATEWAY_SECRET: secret };
  return environment;
}
