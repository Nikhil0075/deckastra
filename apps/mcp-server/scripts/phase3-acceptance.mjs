#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 3 exit control: build and verify a ten-slide reviewed template in no
 * more than five Deckastra requests through the real MCP transport.
 *
 * Start the desktop app with agent access enabled, then run:
 *   node apps/mcp-server/scripts/phase3-acceptance.mjs
 */

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const command = process.env.DECKASTRA_MCP_COMMAND || process.execPath;
const args = process.env.DECKASTRA_MCP_ARGS
  ? JSON.parse(process.env.DECKASTRA_MCP_ARGS)
  : [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "mcp-server", "src", "cli.ts")];

const transport = new StdioClientTransport({
  command,
  args,
  env: { ...process.env, DECKASTRA_MCP_CLIENT: "phase3-acceptance" },
  stderr: "pipe",
});
const client = new Client({ name: "deckastra-phase3-acceptance", version: "1" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

let calls = 0;
const call = async (name, arguments_) => {
  calls += 1;
  if (calls > 5) throw new Error(`Phase 3 exceeded its five-request budget at ${name}.`);
  const result = await client.callTool({ name, arguments: arguments_ });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no JSON text.`);
  return JSON.parse(text);
};

try {
  await client.connect(transport);
  const catalog = await call("preset_list", { purpose: "technical" });
  const template = catalog.presets.find((preset) => preset.id === "technical-architecture");
  if (!template) throw new Error("technical-architecture was not listed.");
  if (template.slides.length !== 10) throw new Error(`Expected a 10-slide template; got ${template.slides.length}.`);

  const created = await call("deck_from_template", {
    template_id: template.id,
    title: "Phase 3 MCP acceptance",
  });
  const outline = await call("document_read", { presentation_id: created.presentation_id });
  if (outline.slideCount !== 10) throw new Error(`Expected 10 composed slides; got ${outline.slideCount}.`);
  if (!outline.slides.every((slide) => slide.animationTrackCount > 0)) {
    throw new Error("At least one composed slide did not receive its template motion style.");
  }
  const patterns = [...new Set(outline.slides.map((slide) => slide.pattern))];
  if (patterns.length !== 10) throw new Error(`Expected 10 semantic patterns; got ${patterns.length}.`);

  console.log(JSON.stringify({
    passed: true,
    calls,
    presentation_id: created.presentation_id,
    version_id: created.version_id,
    slide_count: outline.slideCount,
    motion_style: template.motionStyle,
    patterns,
  }, null, 2));
} finally {
  await client.close();
}
