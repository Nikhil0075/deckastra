import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { dialog } from "electron";

interface Service { port: number; secret: string }

/** Native paths remain in main; only bytes and authenticated API ids leave it. */
export async function importDeckFile(service: Service, path?: string): Promise<string | null> {
  if (!path) {
    const picked = await dialog.showOpenDialog({ title: "Open a Deckastra file", properties: ["openFile"],
      filters: [{ name: "Deckastra presentation", extensions: ["mydeck"] }] });
    if (picked.canceled) return null;
    path = picked.filePaths[0];
  }
  if (!path || extname(path).toLowerCase() !== ".mydeck") throw new Error("Choose a .mydeck presentation.");
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > 1024 ** 3) throw new Error("This deck file exceeds the supported size.");
  const api = `http://127.0.0.1:${service.port}`;
  const headers = { Authorization: `Bearer ${service.secret}`, "Content-Type": "application/json" };
  async function call(route: string, init: RequestInit = {}) {
    const answer = await fetch(api + route, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(90_000) });
    const body = await answer.json();
    if (!answer.ok) throw new Error(typeof body.detail === "string" ? body.detail : "The deck file could not be opened.");
    return body;
  }
  const account = await call("/v1/account");
  const project = account.workspaces?.[0]?.projects?.[0];
  if (!project) throw new Error("Create a project before importing a file.");
  const upload = await call(`/v1/projects/${project.id}/imports`, { method: "POST", body: JSON.stringify({ size_bytes: info.size }) });
  await call(`/v1/imports/${upload.id}/blob`, { method: "PUT", headers: upload.headers, body: await readFile(path) });
  await call(`/v1/imports/${upload.id}/complete`, { method: "POST" });
  for (let attempt = 0; attempt < 240; attempt++) {
    const job = await call(`/v1/imports/${upload.id}`);
    if (["completed", "existing"].includes(job.status)) return job.presentation_id;
    if (job.status === "failed") throw new Error(job.error || "This file could not be imported.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("The import is still processing. Check the deck library shortly.");
}
