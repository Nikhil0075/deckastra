import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { accountToken } from "./account";
import { cloudConfig } from "./cloud";

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
    const paths: Record<string, string> = { "/infer": "/v1/assistant/infer", "/capabilities": "/v1/account/capabilities", "/credits": "/v1/account/credits" };
    const path = paths[request.url ?? ""];
    if (!path || request.method !== (request.url === "/infer" ? "POST" : "GET")) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const token = await accountToken();
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
        redirect: "error", signal: AbortSignal.timeout(210_000) });
      response.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Sign in to use Deckastra AI credits." }));
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
