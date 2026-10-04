import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assistantEnvironment } from "../src/main/assistant-config";

it("loads only service assistant settings and preserves explicit environment choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "deckastra-assistant-config-"));
  try {
    const path = join(root, "config.json");
    await writeFile(path, '\uFEFF' + JSON.stringify({ DECKASTRA_ASSISTANT_MODE: "local", DECKASTRA_MODEL_DIR: "models", DECKASTRA_LOCAL_SECRET: "forbidden", PATH: "forbidden" }));
    const settings = await assistantEnvironment({ DECKASTRA_ASSISTANT_CONFIG: path, DECKASTRA_ASSISTANT_MODE: "hybrid" });
    expect(settings).toEqual({ DECKASTRA_MODEL_DIR: "models" });
    await writeFile(path, JSON.stringify({ DECKASTRA_MODEL_DIR: 42 }));
    await expect(assistantEnvironment({ DECKASTRA_ASSISTANT_CONFIG: path })).rejects.toThrow("Invalid assistant configuration field");
  } finally { await rm(root, { recursive: true, force: true }); }
});
