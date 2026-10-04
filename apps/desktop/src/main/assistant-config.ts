import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ALLOWED = new Set([
  "DECKASTRA_MODEL_DIR", "DECKASTRA_MODEL_PACK", "DECKASTRA_MODEL_SERVER_CMD", "DECKASTRA_MODEL_SERVER", "DECKASTRA_MODEL_STARTUP_SECONDS",
  "DECKASTRA_ASSISTANT_PACK", "DECKASTRA_ASSISTANT_MODE", "DECKASTRA_ASSISTANT_RUNTIME", "DECKASTRA_ASSISTANT_HARDWARE", "DECKASTRA_ASSISTANT_QUALIFICATION", "DECKASTRA_ASSISTANT_MAX_COST_USD", "DECKASTRA_ASSISTANT_COST_LEDGER",
  "DECKASTRA_VERTEX_PROJECT", "DECKASTRA_VERTEX_LOCATION", "DECKASTRA_VERTEX_IDENTITY", "DECKASTRA_VERTEX_MODELS", "DECKASTRA_VERTEX_PRICES", "DECKASTRA_VERTEX_THINKING", "DECKASTRA_GOOGLE_CREDENTIALS", "DECKASTRA_SPEECH", "DECKASTRA_SPEECH_USD_PER_MILLION",
  "DECKASTRA_VERTEX_QUALIFICATION", "DECKASTRA_WORKSPACE_ASSISTANT_CEILINGS",
]);

/** Installer-created configuration belongs to the service; never the renderer. */
export async function assistantEnvironment(environment = process.env): Promise<NodeJS.ProcessEnv> {
  const path = environment.DECKASTRA_ASSISTANT_CONFIG ?? (environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, "Deckastra", "assistant", "local-config.json") : undefined);
  if (!path) return {};
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const values: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Assistant configuration must be an object.");
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid assistant configuration field: ${key}`);
    if (environment[key] === undefined) result[key] = value;
  }
  return result;
}
