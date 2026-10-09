// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSetupGuide, agentConfiguration, type AgentLauncher } from "../src/components/AgentSetupGuide";

const launcher: AgentLauncher = {
  command: "C:/Program Files/Deckastra/Deckastra.exe",
  args: ["C:/Program Files/Deckastra/resources/mcp/cli.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
  clientLabelKey: "DECKASTRA_MCP_CLIENT",
};

function configurationOnScreen(): string {
  return screen.getByRole("tabpanel").querySelector("pre")?.textContent ?? "";
}

afterEach(cleanup);

describe("coding-agent setup", () => {
  it("renders a copy-ready VS Code configuration by default", () => {
    render(<AgentSetupGuide launcher={launcher} onCopy={async () => {}} />);

    expect(screen.getByText(".vscode/mcp.json")).toBeTruthy();
    const configuration = JSON.parse(configurationOnScreen()) as {
      servers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(configuration.servers.deckastra).toEqual({
      type: "stdio",
      command: launcher.command,
      args: launcher.args,
      env: { ELECTRON_RUN_AS_NODE: "1", DECKASTRA_MCP_CLIENT: "copilot" },
    });
  });

  it("uses each client's native file and configuration shape", () => {
    render(<AgentSetupGuide launcher={launcher} onCopy={async () => {}} />);

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText("~/.codex/config.toml")).toBeTruthy();
    expect(configurationOnScreen()).toContain("[mcp_servers.deckastra]");
    expect(configurationOnScreen()).toContain('DECKASTRA_MCP_CLIENT = "codex"');

    fireEvent.click(screen.getByRole("tab", { name: "Antigravity" }));
    expect(screen.getByText(".agents/mcp_config.json")).toBeTruthy();
    expect(JSON.parse(configurationOnScreen())).toHaveProperty("mcpServers.deckastra");

    fireEvent.click(screen.getByRole("tab", { name: "Gemini CLI" }));
    expect(screen.getByText(".gemini/settings.json")).toBeTruthy();
    expect(JSON.parse(configurationOnScreen())).toHaveProperty("mcpServers.deckastra");

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(screen.getByText(".mcp.json")).toBeTruthy();
  });

  it("copies exactly the configuration on screen and reports failure", async () => {
    const onCopy = vi.fn<(text: string) => Promise<void>>().mockResolvedValueOnce().mockRejectedValueOnce(new Error("clipboard"));
    render(<AgentSetupGuide launcher={launcher} onCopy={onCopy} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy configuration" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(onCopy).toHaveBeenCalledWith(agentConfiguration("copilot", launcher));

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy configuration" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/copy it manually/i));
  });
});
