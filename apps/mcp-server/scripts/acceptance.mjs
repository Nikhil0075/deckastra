#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The D2 acceptance harness: an external agent, against a running app.
 *
 * Every claim D2 makes is about software someone installed and is using — an
 * agent attaching to *their* Deckastra, changing *their* deck, and being refused
 * when it should be. None of that can be asserted from a unit test, which is why
 * this drives the real stdio transport against the real server against the real
 * service, exactly as Claude Code or Codex would.
 *
 * **It works on a deck it creates.** The first version edited whatever deck the
 * user happened to have open and left a pending proposal in it, which is a poor
 * thing for a check to do to someone's work. This makes its own, does everything
 * to that, and leaves it behind under an obvious name.
 *
 * It is a script rather than a test because it needs the app open. Start
 * Deckastra, then:
 *
 *     node apps/mcp-server/scripts/acceptance.mjs
 */

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * An id the schema accepts: `{prefix}_{26 Crockford base32 characters}`.
 *
 * Not a timestamp dressed up as one. Ids are validated, and a malformed one is
 * refused as an invalid document — which would look like the proposal path being
 * broken rather than this script being sloppy.
 */
function newId(prefix) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const random = crypto.getRandomValues(new Uint8Array(26));
  return `${prefix}_${[...random].map((byte) => alphabet[byte % 32]).join("")}`;
}

const payload = (result) => {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const picture = (result) => result.content.find((part) => part.type === "image");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "mcp-server", "src", "cli.ts")],
    env: { ...process.env, DECKASTRA_MCP_CLIENT: "acceptance" },
    stderr: "pipe",
  });

  const client = new Client({ name: "deckastra-acceptance", version: "0" });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  check("attaches to the running app", tools.length > 0, `${tools.length} tools`);
  check(
    "offers no way for an agent to approve its own change or share a deck",
    !tools.includes("proposal_approve") && !tools.some((name) => name.includes("share")),
  );

  // --- its own deck, so nothing here touches the user's work
  const created = payload(
    await client.callTool({
      name: "document_create",
      arguments: { title: `MCP acceptance ${new Date().toISOString()}` },
    }),
  );
  const deck = created.presentation_id;
  check("creates a deck of its own to work on", Boolean(deck), deck);

  const workspace = payload(await client.callTool({ name: "workspace_list", arguments: {} }));
  const listed = workspace.workspaces.flatMap((one) => one.projects.flatMap((project) => project.decks ?? []));
  check("lists it back", listed.some((one) => one.id === deck), `${listed.length} decks visible`);

  // --- author a slide's worth of content
  let outline = payload(await client.callTool({ name: "document_read", arguments: { presentation_id: deck } }));
  const slide = outline.slides[0];
  const applied = payload(
    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: deck,
        expected_version_id: outline.versionId,
        intent: "Give the opening slide a headline",
        operations: [
          {
            op: "add",
            path: `/slides/id:${slide.id}/elements/-`,
            value: {
              id: newId("el"),
              type: "text",
              semanticRole: "headline",
              transform: { x: 120, y: 300, width: 1600, height: 200 },
              content: {
                version: 1,
                blocks: [
                  {
                    id: newId("blk"),
                    type: "paragraph",
                    spans: [{ text: "Written by an agent" }],
                  },
                ],
              },
              typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 88 },
            },
          },
        ],
      },
    }),
  );
  check("a low-risk change applies immediately", applied.outcome === "applied", applied.risk_tier);

  // --- the stale refusal, against the version it has already superseded
  const stale = await client.callTool({
    name: "document_propose",
    arguments: {
      presentation_id: deck,
      expected_version_id: outline.versionId,
      intent: "Retitle from a stale read",
      operations: [{ op: "replace", path: "/metadata/title", value: "Should never land" }],
    },
  });
  check("a stale change is refused", stale.isError === true, stale.content[0].text.slice(0, 80));

  // --- motion, planned in roles
  outline = payload(await client.callTool({ name: "document_read", arguments: { presentation_id: deck } }));
  const capabilities = payload(await client.callTool({ name: "motion_capabilities", arguments: {} }));
  const animated = payload(
    await client.callTool({
      name: "motion_propose",
      arguments: {
        presentation_id: deck,
        slide_id: slide.id,
        expected_version_id: outline.versionId,
        sequence: ["headline"],
        pacing: "tight",
        intent: "Reveal the headline",
      },
    }),
  );
  check(
    "motion is planned in roles and timed by the app",
    animated.outcome === "applied" && animated.track_count >= 1,
    `${animated.track_count} track(s), budget ${capabilities.entrance_budget_ms}ms`,
  );

  // --- see it
  outline = payload(await client.callTool({ name: "document_read", arguments: { presentation_id: deck } }));
  const preview = await client.callTool({
    name: "slide_preview",
    arguments: { presentation_id: deck, slide_id: slide.id },
  });
  const image = picture(preview);
  check("renders a picture of its own work", Boolean(image?.data), preview.content[0].text.slice(0, 70));

  // --- a change the user has to approve
  const destructive = payload(
    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: deck,
        expected_version_id: outline.versionId,
        intent: "Remove the slide",
        operations: [{ op: "remove", path: `/slides/id:${slide.id}` }],
      },
    }),
  );
  check(
    "a destructive change waits for the user",
    destructive.outcome === "pending",
    `${destructive.risk_tier}, expires ${destructive.expires_at}`,
  );
  const pending = payload(await client.callTool({ name: "proposal_list", arguments: { presentation_id: deck } }));
  check(
    "it is attributed to this client, not the product's own agent",
    pending.every((row) => (row.agent_id ?? "").startsWith("mcp:")),
    pending[0]?.agent_id ?? "none",
  );

  // --- export, and a cancellation
  let job = payload(
    await client.callTool({ name: "document_export", arguments: { presentation_id: deck, kind: "pdf" } }),
  );
  // Cancelled while it is *rendering*, not while it is queued. Cancelling a
  // queued job only removes it from the queue, which always worked; the case
  // worth proving is the one where a browser is already open.
  for (let attempt = 0; attempt < 40 && job.status === "queued"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    job = payload(await client.callTool({ name: "export_status", arguments: { export_id: job.id } }));
  }
  const cancelled = payload(await client.callTool({ name: "export_cancel", arguments: { export_id: job.id } }));
  check(
    "an export can be cancelled",
    ["cancelled", "running", "queued"].includes(cancelled.status),
    `asked while ${job.status}, now ${cancelled.status}`,
  );
  let settled = cancelled;
  for (let attempt = 0; attempt < 30 && settled.status !== "cancelled"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    settled = payload(await client.callTool({ name: "export_status", arguments: { export_id: job.id } }));
  }
  check("and reaches a terminal cancelled state", settled.status === "cancelled", settled.status);

  const second = payload(
    await client.callTool({ name: "document_export", arguments: { presentation_id: deck, kind: "pdf" } }),
  );
  let final = second;
  for (let attempt = 0; attempt < 90 && !["completed", "failed"].includes(final.status); attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    final = payload(await client.callTool({ name: "export_status", arguments: { export_id: second.id } }));
  }
  check(
    "an export finishes",
    final.status === "completed",
    final.status === "completed" ? `${final.bytes} bytes` : (final.error ?? final.status),
  );

  await client.close();

  console.log(`\nWorked on ${deck} — a deck this script created; the user's decks were not touched.`);
  const failed = results.filter((result) => !result.passed);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
