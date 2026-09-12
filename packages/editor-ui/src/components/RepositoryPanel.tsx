"use client";

import { useCallback, useEffect, useState } from "react";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { Repository, RepositoryList } from "@deckastra/workspace-contracts";

import { stalenessTone } from "../lib/repositories";

/**
 * Connect a repository, see how current its index is, and choose which ones
 * ground a deck (Journey B).
 *
 * The panel exists as much to show staleness as to connect anything. A deck
 * generated from an index that no longer matches `main` is wrong in a way the
 * user cannot see from the slides, so the state is on the row rather than behind
 * a detail view — including "unknown", which is not the same as up to date.
 */

export function RepositoryPanel({
  selected,
  onSelectionChange,
  workspaceId,
}: {
  selected: string[];
  onSelectionChange: (ids: string[]) => void;
  workspaceId?: string;
}) {
  const client = useWorkspaceClient();
  const [list, setList] = useState<RepositoryList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setList(await client.repositories.list(workspaceId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load repositories.");
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    onSelectionChange(
      selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id],
    );
  }

  const repositories = list?.repositories ?? [];

  return (
    <section style={{ ...cardStyle, marginTop: 20 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--fg)",
          padding: 0,
          fontSize: 15,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
        }}
      >
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        Ground this deck in a repository
        {selected.length > 0 ? (
          <span style={{ ...pillStyle, borderColor: "var(--accent)", color: "var(--accent)" }}>
            {selected.length} selected
          </span>
        ) : null}
      </button>

      {open ? (
        <div style={{ marginTop: 18 }}>
          {error ? (
            <p style={{ color: "var(--danger)", fontSize: 14, marginTop: 0 }}>{error}</p>
          ) : null}

          {repositories.length === 0 ? (
            <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: "0 0 16px" }}>
              Nothing connected yet. A grounded deck cites the files it was written
              from, so every claim on it can be checked.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 18px" }}>
              {repositories.map((repository) => (
                <RepositoryRow
                  key={repository.id}
                  repository={repository}
                  checked={selected.includes(repository.id)}
                  busy={busy === repository.id}
                  onToggle={() => toggle(repository.id)}
                  onIndex={() => void run(repository.id, () => client.repositories.index(repository.id, workspaceId))}
                  onDisconnect={() =>
                    void run(repository.id, async () => {
                      await client.repositories.disconnect(repository.id, workspaceId);
                      onSelectionChange(selected.filter((id) => id !== repository.id));
                    })
                  }
                />
              ))}
            </ul>
          )}

          {list?.github.install_url ? (
            <a href={list.github.install_url} style={{ ...secondaryButtonStyle, display: "inline-block" }}>
              Connect a GitHub repository
            </a>
          ) : (
            <p style={{ color: "var(--fg-subtle)", fontSize: 13, margin: "0 0 14px" }}>
              GitHub is not configured on this server. Set <code>GITHUB_APP_ID</code>,{" "}
              <code>GITHUB_APP_PRIVATE_KEY</code> and <code>GITHUB_APP_SLUG</code> to
              enable the installation flow.
            </p>
          )}

          {list?.local_allowed ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: "1 1 340px" }}>
                <label style={labelStyle} htmlFor="repo-path">
                  Or index a directory on this machine
                </label>
                <input
                  id="repo-path"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="D:\\code\\my-service"
                  style={inputStyle}
                />
              </div>
              <button
                onClick={() =>
                  void run("local", async () => {
                    const created = await client.repositories.connectLocal(path, undefined, workspaceId);
                    setPath("");
                    await client.repositories.index(created.id, workspaceId);
                    onSelectionChange([...selected, created.id]);
                  })
                }
                disabled={!path.trim() || busy === "local"}
                style={secondaryButtonStyle}
              >
                {busy === "local" ? "Indexing…" : "Connect and index"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RepositoryRow({
  repository,
  checked,
  busy,
  onToggle,
  onIndex,
  onDisconnect,
}: {
  repository: Repository;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  onIndex: () => void;
  onDisconnect: () => void;
}) {
  const tone = stalenessTone(repository.staleness.state);
  const ready = repository.index_status === "ready";

  return (
    <li
      style={{
        border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 8,
        background: "var(--surface-alt)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!ready}
          aria-label={`Use ${repository.full_name} as a source`}
        />
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{repository.full_name}</div>
          <div style={{ color: "var(--fg-subtle)", fontSize: 12, marginTop: 2 }}>
            {ready
              ? `${repository.file_count} files · ${repository.chunk_count} chunks`
              : repository.index_status}
            {repository.source === "local" ? " · local checkout" : ""}
          </div>
        </div>

        <span style={{ ...pillStyle, borderColor: tone.colour, color: tone.colour }}>
          {tone.label}
        </span>

        <button onClick={onIndex} disabled={busy} style={smallButtonStyle}>
          {busy ? "Working…" : "Re-index"}
        </button>
        <button onClick={onDisconnect} disabled={busy} style={smallButtonStyle}>
          Disconnect
        </button>
      </div>

      {repository.staleness.state !== "fresh" ? (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--fg-muted)" }}>
          {repository.staleness.message}
        </p>
      ) : null}

      {/* Which kind of search produced the evidence changes how much the
          citations are worth, so it is stated rather than implied. */}
      {ready && !repository.embedding_semantic ? (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--warning)" }}>
          Searched by wording, not meaning. Set <code>VOYAGE_API_KEY</code> on the
          API for semantic retrieval.
        </p>
      ) : null}

      {repository.warnings.map((warning) => (
        <p key={warning} style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fg-muted)" }}>
          {warning}
        </p>
      ))}
    </li>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 20,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "var(--fg-muted)",
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 14,
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "var(--surface-alt)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "11px 18px",
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
};

const smallButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--fg-muted)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "5px 11px",
  fontSize: 12,
};

const pillStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 11,
  letterSpacing: 0.4,
  textTransform: "uppercase",
};
