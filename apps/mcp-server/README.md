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

The installed app now generates the exact command for its own location. Open
**Settings → Agents**, choose VS Code / Copilot, Claude Code, Codex,
Antigravity, or Gemini CLI, and copy the ready-to-use configuration. The files
used by those clients are:

| Client | Project or user configuration |
| --- | --- |
| VS Code / Copilot | `.vscode/mcp.json` (`servers`) |
| Claude Code | `.mcp.json` (`mcpServers`) |
| Codex | `~/.codex/config.toml` (`mcp_servers`) |
| Antigravity | `.agents/mcp_config.json` (`mcpServers`) |
| Gemini CLI | `.gemini/settings.json` (`mcpServers`) |

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

## The user has to allow it

Deckastra publishes nothing until someone presses **Allow agent access** in its
window, and that permission lapses after twelve hours. A fresh install — and an
install that has just updated — starts with it off, so the first connection after
an update needs one click.

Pressing **Stop agent access** withdraws the attachment *and* tells the service to
refuse every grant it has already signed. Withdrawing the file alone would only
stop the next reader: a grant lasts hours, so whoever held one would keep working
for the rest of the day.

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
| `document_export` / `export_status` / `export_cancel` | PDF, PPTX and narrated MP4 jobs |
| `slide_insert_pattern` | One reviewed slide pattern, filled through named slots |
| `motion_style_apply` | One reviewed motion vocabulary across a deck |
| `voice_lines` | Voice existing narration cues through the configured speech service |
| `voice_quote` | Price the exact due narration request before any cloud synthesis |
| `image_quote` / `image_generate` | Price, then generate one slide image as a reviewable proposal |

Creation also has high-level tools for templates, composition and individual
patterns. They accept narrative content and semantic roles; the engine owns
geometry, theme tokens, motion timing and export mapping.

## Prompts and resources

MCP clients can discover two prompts:

- `build_deck` creates a complete first draft from one of the six reviewed
  purpose templates.
- `revise_deck` reads the open deck, authors a version-safe proposal, previews
  affected slides, and runs Design Check.

The prompts point the agent to `deckastra://guides/authoring`, the live
`deckastra://current/theme`, and a worked resource under
`deckastra://examples/{business,product,teaching,technical,team,personal}`.
Together they describe slot semantics, role-based editing, optimistic
concurrency and the operations Deckastra deliberately refuses.

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
- **It never hides a paid service behind document editing.** `document_propose`
  takes operations you authored and calls no model. `voice_lines` is a separate,
  plainly named speech-service action, requires an accepted quote for a paid
  provider, and attaching its result still follows proposal review.

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
