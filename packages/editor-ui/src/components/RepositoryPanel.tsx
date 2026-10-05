"use client";

import { useCallback, useEffect, useState } from "react";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { Repository, RepositoryList } from "@deckastra/workspace-contracts";

import { stalenessTone } from "../lib/repositories";
import { Icon, StatusChip } from "../ui";

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
  embedded = false,
}: {
  selected: string[];
  onSelectionChange: (ids: string[]) => void;
  workspaceId?: string;
  /** Inside a Section that already opens and closes it: no toggle of its own. */
  embedded?: boolean;
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

  const body = (
    <div className="dk-repos__body">
      {error ? (
        <p className="dk-export__error" role="alert">
          {error}
        </p>
      ) : null}

      {list === null && !error ? (
        // Loading is said, not shown as "nothing connected": that is a claim
        // about the workspace this panel has not read yet (roadmap 08 rule 5).
        <p className="dk-muted" role="status">
          Reading connected repositories…
        </p>
      ) : list === null ? (
        <button type="button" className="dk-btn dk-btn--secondary dk-btn--sm" onClick={() => void refresh()}>
          Try again
        </button>
      ) : repositories.length === 0 ? (
        <p className="dk-muted">
          Nothing connected yet. A grounded deck cites the files it was written from, so every claim on it can be
          checked.
        </p>
      ) : (
        <ul className="dk-repos__list">
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
        <a href={list.github.install_url} className="dk-btn dk-btn--secondary dk-btn--sm">
          Connect a GitHub repository
        </a>
      ) : list ? (
        // Whoever runs the server sets this up; a person reading the panel can
        // do nothing with the setting names (roadmap 08 rule 4).
        <p className="dk-muted">Connecting GitHub repositories is not set up on this server.</p>
      ) : null}

      {list?.local_allowed ? (
        <div className="dk-repos__local">
          <label className="dk-label" htmlFor="repo-path">
            Or index a directory on this machine
          </label>
          <input
            id="repo-path"
            className="dk-input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="D:\\code\\my-service"
          />
          <button
            type="button"
            className="dk-btn dk-btn--secondary dk-btn--sm"
            onClick={() =>
              void run("local", async () => {
                const created = await client.repositories.connectLocal(path, undefined, workspaceId);
                setPath("");
                await client.repositories.index(created.id, workspaceId);
                onSelectionChange([...selected, created.id]);
              })
            }
            disabled={!path.trim() || busy === "local"}
          >
            {busy === "local" ? "Indexing…" : "Connect and index"}
          </button>
        </div>
      ) : null}
    </div>
  );

  // Inside a Section (the Generate drawer), the Section is the toggle; a second
  // one inside it would be two ways to open the same thing.
  if (embedded) return <div className="dk-repos">{body}</div>;

  return (
    <section className="dk-repos dk-repos--card">
      <button type="button" className="dk-repos__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        Ground this deck in a repository
        {selected.length > 0 ? <StatusChip tone="action">{selected.length} selected</StatusChip> : null}
      </button>
      {open ? body : null}
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
    <li className={checked ? "dk-repos__row dk-repos__row--chosen" : "dk-repos__row"}>
      <div className="dk-repos__line">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!ready}
          aria-label={`Use ${repository.full_name} as a source`}
        />
        <div className="dk-repos__name">
          <div className="dk-sources__ref">{repository.full_name}</div>
          <div className="dk-muted">
            {ready ? `${repository.file_count} files · ${repository.chunk_count} chunks` : repository.index_status}
            {repository.source === "local" ? " · local checkout" : ""}
          </div>
        </div>
        <StatusChip tone={tone.tone}>{tone.label}</StatusChip>
      </div>
      <div className="dk-export__formats">
        <button type="button" className="dk-btn dk-btn--secondary dk-btn--sm" onClick={onIndex} disabled={busy}>
          {busy ? "Working…" : "Re-index"}
        </button>
        <button type="button" className="dk-btn dk-btn--ghost dk-btn--sm" onClick={onDisconnect} disabled={busy}>
          Disconnect
        </button>
      </div>

      {repository.staleness.state !== "fresh" ? <p className="dk-muted">{repository.staleness.message}</p> : null}

      {/* Which kind of search produced the evidence changes how much the
          citations are worth, so it is stated rather than implied. */}
      {ready && !repository.embedding_semantic ? (
        <p className="dk-export__note">
          Searched by wording, not meaning. Set <code>VOYAGE_API_KEY</code> on the API for semantic retrieval.
        </p>
      ) : null}

      {repository.warnings.map((warning) => (
        <p key={warning} className="dk-muted">
          {warning}
        </p>
      ))}
    </li>
  );
}
