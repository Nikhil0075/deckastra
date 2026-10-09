import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { NotRunning, attach } from "./attach";
import { createAttachedClient } from "./client";
import { registerGuidance } from "./guidance";
import { registerTools } from "./tools";

/**
 * Deckastra over MCP (milestone D2).
 *
 * Claude Code and Codex drive the same command authority a person does: the
 * workspace service running inside the user's own desktop app, reached over
 * loopback with that launch's secret. There is no second store, no second write
 * path and no headless mode — if the app is not open, this refuses and says so.
 *
 * stdio, because that is what an editor-hosted agent speaks and because it means
 * the transport itself grants nothing: this process is started by the client that
 * wants it and dies with that client.
 */

export { attach, attachmentPath, NotRunning, type Attachment } from "./attach";
export { createAttachedClient } from "./client";
export { registerGuidance } from "./guidance";
export { outlineDocument, slideOf } from "./outline";
export { registerTools } from "./tools";

/**
 * How the tools identify themselves in a deck's history.
 *
 * Taken from the environment because the same binary serves every client, and
 * "which agent changed my slide" is a question the version history has to be able
 * to answer months later. It is a label, not a credential: the launch secret is
 * what authorises, and this only decides what the approval prompt says.
 */
function clientLabel(): string {
  const declared = process.env.DECKASTRA_MCP_CLIENT?.trim();
  return declared && /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(declared) ? declared : "external";
}

export async function main(): Promise<void> {
  let attached;
  try {
    attached = await attach();
  } catch (error) {
    if (error instanceof NotRunning) {
      // stderr, and a non-zero exit. An MCP client shows a failed server's
      // stderr to the user, which is the only surface that can carry "open the
      // app" to the person who can act on it — and starting successfully with
      // every tool broken would tell them nothing.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const server = new McpServer(
    { name: "deckastra", version: attached.attachment.appVersion },
    {
      instructions:
        "Deckastra is a presentation studio running on this machine. Read a deck with " +
        "document_read before changing it, and pass the version_id it returns as " +
        "expected_version_id when you propose a change, so the user's own edits are never " +
        "overwritten. Changes that carry real risk become proposals the user approves in the " +
        "app; you cannot approve them yourself.",
    },
  );

  const client = createAttachedClient(attached, clientLabel());
  registerTools(server, client, attached);
  registerGuidance(server, client, attached);
  await server.connect(new StdioServerTransport());
}
