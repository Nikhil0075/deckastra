#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent half of the agent-to-person handoff (manual-authoring plan MA-28).
 *
 * An agent, through the real stdio MCP server against the running app, builds a
 * deck of the shapes generated decks are made of — a card that is a group
 * holding a group, a chart, a table — plans motion in roles, and leaves one
 * destructive change pending. It uses only caller-authored operations
 * (`document_propose`), the route that never calls a model. Then it stops and
 * prints what it made as one JSON line; the desktop's `handoff` acceptance step
 * takes over as the person, with real input, on the same deck.
 *
 * Run by that step, or by hand against a running app with agent access on:
 *
 *     node apps/mcp-server/scripts/handoff.mjs
 */

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function newId(prefix) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const random = crypto.getRandomValues(new Uint8Array(26));
  return `${prefix}_${[...random].map((byte) => alphabet[byte % 32]).join("")}`;
}
const text = (words, extra = {}) => ({
  version: 1,
  blocks: [{ id: newId("blk"), type: "paragraph", spans: [{ text: words, ...extra }] }],
});
const payload = (result) => {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};

async function main() {
  const command = process.env.DECKASTRA_MCP_COMMAND || process.execPath;
  const args = process.env.DECKASTRA_MCP_ARGS
    ? JSON.parse(process.env.DECKASTRA_MCP_ARGS)
    : [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "mcp-server", "src", "cli.ts")];
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, DECKASTRA_MCP_CLIENT: "handoff" }, stderr: "pipe" });
  const client = new Client({ name: "deckastra-handoff", version: "0" });
  await client.connect(transport);
  const call = async (name, args) => payload(await client.callTool({ name, arguments: args }));
  const calls = [];
  const propose = async (intent, operations) => {
    const outline = await call("document_read", { presentation_id: deck });
    const result = await call("document_propose", { presentation_id: deck, expected_version_id: outline.versionId, intent, operations });
    calls.push({ intent, outcome: result.outcome, risk: result.risk_tier });
    return result;
  };

  const deck = (await call("document_create", { title: `Agent handoff ${new Date().toISOString()}` })).presentation_id;
  let outline = await call("document_read", { presentation_id: deck });
  const first = outline.slides[0].id;

  const headline = newId("el");
  const card = newId("el");
  const inner = newId("el");
  const cardText = newId("el");
  const cardBox = newId("el");
  await propose("Headline and a card", [
    {
      op: "add",
      path: `/slides/id:${first}/elements/-`,
      value: {
        id: headline,
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 80, width: 1680, height: 160 },
        content: text("Agent-written headline"),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 88 },
      },
    },
    {
      op: "add",
      path: `/slides/id:${first}/elements/-`,
      value: {
        id: card,
        type: "group",
        name: "Card",
        transform: { x: 120, y: 360, width: 720, height: 400 },
        style: { fill: { type: "solid", color: "token:colors.surface" }, cornerRadius: 16 },
        children: [
          {
            id: inner,
            type: "group",
            name: "Card body",
            transform: { x: 40, y: 40, width: 640, height: 320, rotation: 4 },
            children: [
              { id: cardBox, type: "shape", shape: "rectangle", transform: { x: 0, y: 0, width: 640, height: 120 }, text: text("Label in a shape") },
              {
                id: cardText,
                type: "text",
                transform: { x: 0, y: 160, width: 640, height: 120 },
                content: text("Card body text"),
                typography: { fontFamily: "token:typography.body.fontFamily", fontSize: 36 },
              },
            ],
          },
        ],
      },
    },
  ]);

  const chart = newId("el");
  const table = newId("el");
  const second = newId("sld");
  await propose("A data slide", [
    {
      op: "add",
      path: "/slides/-",
      value: {
        id: second,
        elements: [
          {
            id: chart,
            type: "chart",
            chartType: "column",
            transform: { x: 120, y: 120, width: 800, height: 480 },
            data: { type: "inline", rows: [{ q: "Q1", revenue: 10 }, { q: "Q2", revenue: 14 }, { q: "Q3", revenue: 19 }] },
            encoding: { category: "q", value: "revenue" },
            altText: "Revenue by quarter",
          },
          {
            id: table,
            type: "table",
            transform: { x: 1000, y: 120, width: 800, height: 300 },
            columns: [{ id: newId("el"), label: "Region" }, { id: newId("el"), label: "Share", align: "right" }],
            rows: [
              { id: newId("el"), cells: [{ content: "North" }, { content: "41%" }] },
              { id: newId("el"), cells: [{ content: "South" }, { content: "59%" }] },
            ],
            headerRow: true,
          },
        ],
      },
    },
  ]);

  outline = await call("document_read", { presentation_id: deck });
  const motion = await call("motion_propose", {
    presentation_id: deck,
    slide_id: first,
    expected_version_id: outline.versionId,
    sequence: ["headline"],
    pacing: "tight",
    intent: "Reveal the headline",
  });
  calls.push({ intent: "motion", outcome: motion.outcome, tracks: motion.track_count });

  // Destructive, so the server holds it for a person.
  const pending = await propose("Remove the data slide", [{ op: "remove", path: `/slides/id:${second}` }]);

  await client.close();
  const pendingId = pending.outcome === "pending" ? pending.transaction_id ?? pending.proposal_id : null;
  process.stdout.write(
    `${JSON.stringify({ presentationId: deck, headline, card, inner, cardText, cardBox, chart, table, second, pendingProposalId: pendingId, calls })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
