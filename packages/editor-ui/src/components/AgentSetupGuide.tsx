import { useState } from "react";

import { Button } from "../ui";

export interface AgentLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Main-process-owned label key; the renderer does not invent transport details. */
  clientLabelKey: string;
}

type ClientId = "copilot" | "claude-code" | "codex" | "antigravity" | "gemini-cli";

const CLIENTS: ReadonlyArray<{ id: ClientId; label: string; location: string }> = [
  { id: "copilot", label: "VS Code / Copilot", location: ".vscode/mcp.json" },
  { id: "claude-code", label: "Claude Code", location: ".mcp.json" },
  { id: "codex", label: "Codex", location: "~/.codex/config.toml" },
  { id: "antigravity", label: "Antigravity", location: ".agents/mcp_config.json" },
  { id: "gemini-cli", label: "Gemini CLI", location: ".gemini/settings.json" },
];

function entry(launcher: AgentLauncher, client: ClientId) {
  return {
    command: launcher.command,
    args: launcher.args,
    env: { ...(launcher.env ?? {}), [launcher.clientLabelKey]: client },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function agentConfiguration(client: ClientId, launcher: AgentLauncher): string {
  const server = entry(launcher, client);
  if (client === "codex") {
    return [
      "[mcp_servers.deckastra]",
      `command = ${tomlString(server.command)}`,
      `args = [${server.args.map(tomlString).join(", ")}]`,
      `env = { ${Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")} }`,
    ].join("\n");
  }
  if (client === "copilot") {
    return JSON.stringify({ servers: { deckastra: { type: "stdio", ...server } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { deckastra: server } }, null, 2);
}

/** Copy-ready MCP configuration for every client named by the agent-first plan. */
export function AgentSetupGuide({
  launcher,
  onCopy,
}: {
  launcher: AgentLauncher;
  onCopy: (text: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<ClientId>("copilot");
  const [copied, setCopied] = useState<ClientId | null>(null);
  const [copyError, setCopyError] = useState(false);
  const client = CLIENTS.find((candidate) => candidate.id === selected)!;
  const configuration = agentConfiguration(selected, launcher);

  return (
    <section className="dk-agent-setup" aria-labelledby="agent-setup-heading">
      <div>
        <h3 className="dk-settings__heading" id="agent-setup-heading">Connect your coding agent</h3>
        <p className="dk-muted">
          Copilot Free is enough to start. Deckastra must be open, and agent access must be allowed in this panel.
        </p>
      </div>
      <div className="dk-agent-setup__clients" role="tablist" aria-label="Coding agent">
        {CLIENTS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={candidate.id === selected}
            aria-controls="agent-setup-configuration"
            className={candidate.id === selected ? "dk-agent-setup__client dk-agent-setup__client--active" : "dk-agent-setup__client"}
            onClick={() => {
              setSelected(candidate.id);
              setCopied(null);
              setCopyError(false);
            }}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div className="dk-agent-setup__config" id="agent-setup-configuration" role="tabpanel">
        <div className="dk-agent-setup__config-head">
          <span>Put this in <code>{client.location}</code></span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCopyError(false);
              void onCopy(configuration)
                .then(() => setCopied(selected))
                .catch(() => {
                  setCopied(null);
                  setCopyError(true);
                });
            }}
          >
            {copied === selected ? "Copied" : "Copy configuration"}
          </Button>
        </div>
        <pre tabIndex={0}><code>{configuration}</code></pre>
      </div>
      {copyError ? (
        <p className="dk-settings__error" role="alert">
          Could not copy the configuration. Select the text above and copy it manually.
        </p>
      ) : null}
      <ol className="dk-agent-setup__steps">
        <li>Allow agent access.</li>
        <li>Restart or reload the MCP server in your agent.</li>
        <li>Ask it to use the <code>build_deck</code> prompt, or call <code>preset_list</code>.</li>
      </ol>
    </section>
  );
}
