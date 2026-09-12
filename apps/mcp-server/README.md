# Deckastra MCP server

Agent access to a running Deckastra desktop app (milestone D2).

Claude Code and Codex drive the same command authority a person does: the
workspace service inside the user's own desktop app, reached over loopback with
that launch's secret. There is no second store and no headless mode — **if the
app is not open, this refuses**, because two writers on one SQLite database is
the corruption case the app's single-instance lock already exists to prevent.

## Wiring it up

The server is started by the agent that uses it, over stdio. It runs `node`
directly against `tsx` rather than through `npx`: on native Windows an MCP
client cannot spawn `npx` without a `cmd /c` wrapper, and a server that fails to
start says nothing useful about why. Use absolute paths — the client's working
directory is not this repository.

### From an installed app (no repository needed)

The installer ships the server beside the exporter, and the app's own binary runs
it in Node mode. On Windows:

```json
{
  "mcpServers": {
    "deckastra": {
      "command": "C:/Users/<you>/AppData/Local/Programs/Deckastra/Deckastra.exe",
      "args": ["C:/Users/<you>/AppData/Local/Programs/Deckastra/resources/mcp/cli.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "DECKASTRA_MCP_CLIENT": "claude-code" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` is required, not decorative: without it the binary starts
as an app — and an Electron main process never receives piped stdin on Windows,
so the server would wait for a request that cannot arrive.

### From a checkout

**Claude Code** — a project-scoped `.mcp.json` at the repository root (the
desktop app asks you to approve it the first time):

```json
{
  "mcpServers": {
    "deckastra": {
      "command": "node",
      "args": [
        "D:/Presentation_app/node_modules/tsx/dist/cli.mjs",
        "D:/Presentation_app/apps/mcp-server/src/cli.ts"
      ],
      "env": { "DECKASTRA_MCP_CLIENT": "claude-code" }
    }
  }
}
```

Or, with the CLI on PATH:

```bash
claude mcp add deckastra -e DECKASTRA_MCP_CLIENT=claude-code -- node D:/Presentation_app/node_modules/tsx/dist/cli.mjs D:/Presentation_app/apps/mcp-server/src/cli.ts
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.deckastra]
command = "node"
args = [
  "D:/Presentation_app/node_modules/tsx/dist/cli.mjs",
  "D:/Presentation_app/apps/mcp-server/src/cli.ts",
]
env = { DECKASTRA_MCP_CLIENT = "codex" }
```

`DECKASTRA_MCP_CLIENT` is a label, not a credential: it decides what a deck's
history and the approval prompt say about who proposed a change. The launch
secret is what authorises, and it is read from the attachment file the app
publishes — so **Deckastra must be open** before the agent starts, or the server
exits with a message saying so.

`DECKASTRA_ATTACHMENT` overrides where that file is looked for — a portable
install, an unusual profile, or a test.

## What the credential allows

The app publishes a **grant**, not its own launch secret: `read`, `write` and
`export`, signed with the launch secret and expiring after twelve hours. The
authority enforces it (`apps/api/deckastra_api/grants.py`), so approving a
proposal and minting a share link are refused with 403 — by the service, not by
this adapter's choice of tools. A grant recovered from a backup authorises
nothing, because the key that signed it died with that launch.

## The tools

| Tool | Does |
| --- | --- |
| `workspace_list` | Workspaces, projects, decks, and which deck the user has open |
| `document_read` | A deck as a bounded outline — slides, roles, text, and the ids to address them |
| `document_read_slide` | One slide in full, for when you are about to change it |
| `document_versions` | Recent history |
| `document_create` | An empty deck |
| `document_propose` | Apply caller-authored patch operations |
| `proposal_list` | What is waiting for the user's approval |
| `document_export` / `export_status` / `export_cancel` | PDF and PPTX jobs |

## What it will not do

Each absence is deliberate, and each is a rule the product would otherwise only
be asking agents to follow:

- **It cannot approve a proposal.** A change that carries real risk waits for the
  person whose deck it is. An agent that could approve its own work would reduce
  proposal-before-apply to a delay.
- **It cannot share a deck.** A share link is a bearer credential to a document.
- **It takes no paths.** Not for exports, not for repositories. Document content
  reaches this process, and a tool that took a path would let a deck someone
  emailed you choose where bytes are written.
- **It cannot declare its own risk tier**, and cannot claim to be one of the
  product's own agents — the label it sends is prefixed `mcp:` server-side.
- **It never triggers a paid model call.** `document_propose` takes operations
  you authored; it does not go through the route that pays a model to invent
  them.

## Concurrency

`document_propose` requires `expected_version_id` — the version `document_read`
returned. If the user has edited since, the change is refused with a conflict
rather than overwriting their work. This is not a rare race: an agent reads a
deck, thinks for thirty seconds, and comes back to a deck someone has been typing
into.

## Acceptance

The claims above are about software someone is using, so they are checked against
a running app rather than a mock. Start Deckastra, then:

```bash
node apps/mcp-server/scripts/acceptance.mjs
```

It drives the real stdio transport exactly as an editor-hosted agent would:
attach, read, apply a low-risk change, get refused for a stale one, watch a
destructive change become a pending proposal, and export a PDF.
