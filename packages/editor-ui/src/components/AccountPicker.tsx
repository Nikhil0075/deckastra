"use client";

import { useEffect, useMemo, useState } from "react";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountContext } from "@deckastra/workspace-contracts";

export function AccountPicker({
  onSelectionChange,
}: {
  onSelectionChange: (selection: { workspaceId: string; projectId: string } | null) => void;
}) {
  const client = useWorkspaceClient();
  const [account, setAccount] = useState<AccountContext | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(preferred?: { workspaceId: string; projectId: string }) {
    const [next, session] = await Promise.all([client.session.account(), client.session.ensure()]);
    setAccount(next);
    const wantedWorkspace = preferred?.workspaceId || session.workspaceId;
    const workspace =
      next.workspaces.find((item) => item.id === wantedWorkspace) ?? next.workspaces[0];
    const wantedProject = preferred?.projectId || session.projectId;
    const project =
      workspace?.projects.find((item) => item.id === wantedProject) ?? workspace?.projects[0];
    const selection = workspace && project ? { workspaceId: workspace.id, projectId: project.id } : null;
    setWorkspaceId(selection?.workspaceId ?? "");
    setProjectId(selection?.projectId ?? "");
    if (selection) client.session.selectProject(selection.workspaceId, selection.projectId);
    onSelectionChange(selection);
  }

  useEffect(() => {
    void refresh().catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Could not load your account.");
      onSelectionChange(null);
    });
    // The callback is owned by the page and intentionally sampled on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workspace = useMemo(
    () => account?.workspaces.find((item) => item.id === workspaceId),
    [account, workspaceId],
  );

  function chooseWorkspace(id: string) {
    const next = account?.workspaces.find((item) => item.id === id);
    const project = next?.projects[0];
    setWorkspaceId(id);
    setProjectId(project?.id ?? "");
    const selection = project ? { workspaceId: id, projectId: project.id } : null;
    if (selection) client.session.selectProject(selection.workspaceId, selection.projectId);
    onSelectionChange(selection);
  }

  function chooseProject(id: string) {
    setProjectId(id);
    if (!workspaceId || !id) return;
    client.session.selectProject(workspaceId, id);
    onSelectionChange({ workspaceId, projectId: id });
  }

  async function run(action: () => Promise<{ workspaceId: string; projectId: string }>) {
    setBusy(true);
    setError(null);
    try {
      const preferred = await action();
      await refresh(preferred);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Account and project" style={cardStyle}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
        <label style={fieldStyle}>
          <span>Workspace</span>
          <select value={workspaceId} onChange={(event) => chooseWorkspace(event.target.value)} style={inputStyle}>
            {(account?.workspaces ?? []).map((item) => (
              <option key={item.id} value={item.id}>{item.name} · {item.role}</option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <span>Project</span>
          <select value={projectId} onChange={(event) => chooseProject(event.target.value)} style={inputStyle}>
            {(workspace?.projects ?? []).map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <span style={{ color: "var(--fg-subtle)", fontSize: 13 }}>
          {account?.user.email ?? "Loading account…"}
        </span>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--fg-muted)", fontSize: 13 }}>
          Create workspace or project
        </summary>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <input aria-label="New workspace name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="New workspace" style={inputStyle} />
          <button disabled={busy || !workspaceName.trim()} onClick={() => void run(async () => {
            const created = await client.session.createWorkspace(workspaceName);
            setWorkspaceName("");
            return { workspaceId: created.workspace_id, projectId: created.project_id };
          })}>Create workspace</button>
          <input aria-label="New project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="New project" style={inputStyle} />
          <button disabled={busy || !workspaceId || !projectName.trim()} onClick={() => void run(async () => {
            const created = await client.session.createProject(workspaceId, projectName);
            setProjectName("");
            return { workspaceId, projectId: created.id };
          })}>Create project</button>
        </div>
      </details>
      {error ? <p role="alert" style={{ color: "var(--danger)", marginBottom: 0 }}>{error}</p> : null}
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14,
  padding: 16, marginBottom: 20,
};
const fieldStyle: React.CSSProperties = { display: "grid", gap: 6, color: "var(--fg-muted)", fontSize: 13 };
const inputStyle: React.CSSProperties = {
  background: "var(--surface-alt)", border: "1px solid var(--border)", borderRadius: 8,
  color: "var(--fg)", padding: "8px 10px", minWidth: 180,
};
