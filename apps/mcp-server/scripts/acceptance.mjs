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

function payload(result) {
  return JSON.parse(result.content[0].text);
}

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
    "offers no way for an agent to approve its own change",
    !tools.includes("proposal_approve") && !tools.some((name) => name.includes("share")),
  );

  const workspace = payload(await client.callTool({ name: "workspace_list", arguments: {} }));
  const presentationId = workspace.openPresentationId;
  check("names the deck the user has open", Boolean(presentationId), presentationId ?? "none");

  const outline = payload(
    await client.callTool({ name: "document_read", arguments: { presentation_id: presentationId } }),
  );
  check("reads a deck as an outline", outline.slideCount > 0, `${outline.slideCount} slides`);

  // --- a low-risk change applies, and the deck really changed
  const title = `Renamed by an agent at ${new Date().toISOString()}`;
  const applied = payload(
    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: presentationId,
        expected_version_id: outline.versionId,
        intent: "Retitle the deck",
        operations: [{ op: "replace", path: "/metadata/title", value: title }],
      },
    }),
  );
  check("a low-risk change applies immediately", applied.outcome === "applied", applied.risk_tier);

  const after = payload(
    await client.callTool({ name: "document_read", arguments: { presentation_id: presentationId } }),
  );
  check("the change reached the store", after.title === title, after.title ?? "unchanged");

  // --- the exit gate: a change authored against a version that has moved on
  const stale = await client.callTool({
    name: "document_propose",
    arguments: {
      presentation_id: presentationId,
      expected_version_id: outline.versionId, // the version before the retitle
      intent: "Retitle again from a stale read",
      operations: [{ op: "replace", path: "/metadata/title", value: "Should never land" }],
    },
  });
  check(
    "a stale change is refused, not applied",
    stale.isError === true,
    stale.content[0].text.slice(0, 90),
  );

  const unchanged = payload(
    await client.callTool({ name: "document_read", arguments: { presentation_id: presentationId } }),
  );
  // The assertion the status code stands for: the refusal did not cost the
  // earlier change, and the agent's stale title never landed.
  check("the refusal left the deck alone", unchanged.title === title, unchanged.title ?? "unchanged");

  // --- a destructive change waits for the user
  const slide = after.slides[0];
  const destructive = payload(
    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: presentationId,
        expected_version_id: after.versionId,
        intent: "Clear the opening slide",
        operations: slide.elements
          .slice(0, 2)
          .map((element) => ({ op: "remove", path: `/slides/id:${slide.id}/elements/id:${element.id}` })),
      },
    }),
  );
  check(
    "a destructive change waits for the user",
    destructive.outcome === "pending",
    `${destructive.risk_tier}, expires ${destructive.expires_at}`,
  );

  const pending = payload(
    await client.callTool({ name: "proposal_list", arguments: { presentation_id: presentationId } }),
  );
  check("the pending change is visible to the user", pending.length > 0, `${pending.length} waiting`);
  check(
    "it is attributed to this client, not the product's own agent",
    pending.every((row) => (row.agent_id ?? "").startsWith("mcp:")),
    pending[0]?.agent_id ?? "none",
  );

  // --- export
  const job = payload(
    await client.callTool({
      name: "document_export",
      arguments: { presentation_id: presentationId, kind: "pdf" },
    }),
  );
  check("an export starts", Boolean(job.id), job.status);

  let final = job;
  for (let attempt = 0; attempt < 60 && !["completed", "failed"].includes(final.status); attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    final = payload(await client.callTool({ name: "export_status", arguments: { export_id: job.id } }));
  }
  check(
    "the export finishes",
    final.status === "completed",
    final.status === "completed" ? `${final.bytes} bytes` : (final.error ?? final.status),
  );

  await client.close();

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
