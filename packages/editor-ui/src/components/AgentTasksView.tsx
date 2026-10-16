"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountContext, AgentTask } from "@deckastra/workspace-contracts";

import { parseServerTime, relativeTime } from "../lib/deck-list";
import { Button, InlineError, ScrollArea, SkeletonCards, StatusChip } from "../ui";

interface ManagedTask extends AgentTask {
  projectName: string;
  editable: boolean;
}

export interface AgentTasksViewProps {
  account: AccountContext;
  query: string;
  now: number;
  onOpenDeck: (presentationId: string) => void;
  onOpenDraft: (draftId: string) => void;
  onPendingCount?: (count: number) => void;
}

export function AgentTasksView({ account, query, now, onOpenDeck, onOpenDraft, onPendingCount }: AgentTasksViewProps) {
  const client = useWorkspaceClient();
  const [tasks, setTasks] = useState<ManagedTask[]>([]);
  const [filter, setFilter] = useState<"pending" | "completed">("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const projects = account.workspaces.flatMap((workspace) =>
      workspace.projects.map((project) => ({ id: project.id, name: project.name, editable: workspace.role !== "viewer" })),
    );
    setLoading(true);
    try {
      const grouped = await Promise.all(projects.map(async (project) => {
        const items = await client.agent.tasks(project.id, "all", { fresh: true });
        return items.map((task): ManagedTask => ({ ...task, projectName: project.name, editable: project.editable }));
      }));
      const next = grouped.flat().sort((a, b) => parseServerTime(b.created_at) - parseServerTime(a.created_at));
      setTasks(next);
      setError(null);
      onPendingCount?.(next.filter((task) => task.status === "open").length);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent tasks could not be read.");
    } finally {
      setLoading(false);
    }
  }, [account, client, onPendingCount]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 5_000);
    const focused = () => { void load(); };
    window.addEventListener("focus", focused);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focused);
    };
  }, [load]);

  const pendingCount = tasks.reduce((count, task) => count + (task.status === "open" ? 1 : 0), 0);
  const completedCount = tasks.length - pendingCount;
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      if ((filter === "pending") !== (task.status === "open")) return false;
      return !needle || `${task.message} ${task.resource_title} ${task.projectName} ${task.kind}`.toLocaleLowerCase().includes(needle);
    });
  }, [filter, query, tasks]);

  const close = async (task: ManagedTask) => {
    setClosing(task.id);
    try {
      if (task.resource_type === "draft") await client.drafts.closeRequest(task.id);
      else await client.agent.closeRequest(task.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That request could not be cancelled.");
    } finally {
      setClosing(null);
    }
  };

  return (
    <main className="dk-decks__main" data-home-destination="tasks">
      <div className="dk-decks__heading">
        <div>
          <h2 className="dk-decks__title">Agent Tasks</h2>
          <p className="dk-muted" aria-live="polite" aria-atomic="true">{pendingCount} pending · {completedCount} completed</p>
        </div>
        <div className="dk-agent-tasks__filters" role="group" aria-label="Agent task status">
          <Button variant={filter === "pending" ? "primary" : "secondary"} aria-pressed={filter === "pending"} onClick={() => setFilter("pending")} data-testid="agent-tasks-pending">
            Pending {pendingCount}
          </Button>
          <Button variant={filter === "completed" ? "primary" : "secondary"} aria-pressed={filter === "completed"} onClick={() => setFilter("completed")} data-testid="agent-tasks-completed">
            Completed {completedCount}
          </Button>
        </div>
      </div>
      {error ? <InlineError onRetry={() => void load()} data-testid="agent-tasks-error">{error}</InlineError> : null}
      <ScrollArea className="dk-decks__scroll">
        {loading && tasks.length === 0 && !error ? (
          <SkeletonCards label="Reading agent tasks" count={4} gridClassName="dk-agent-tasks__grid" data-testid="agent-tasks-loading" />
        ) : null}
        {!loading && !error && visible.length === 0 ? (
          <div className="dk-decks__empty">
            <span className="dk-accent-rule" aria-hidden="true" />
            <p>{query.trim() ? `No ${filter} tasks match “${query}”.` : filter === "pending" ? "No agent work is pending." : "No agent tasks have been completed yet."}</p>
          </div>
        ) : null}
        <ul className="dk-agent-tasks__grid" aria-label={`${filter} agent tasks`}>
          {visible.map((task) => (
            <li key={task.id}>
              <AgentTaskCard
                task={task}
                now={now}
                closing={closing === task.id}
                onOpen={() => task.resource_type === "deck" ? onOpenDeck(task.resource_id) : onOpenDraft(task.resource_id)}
                onClose={() => void close(task)}
              />
            </li>
          ))}
        </ul>
      </ScrollArea>
    </main>
  );
}

function AgentTaskCard({ task, now, closing, onOpen, onClose }: { task: ManagedTask; now: number; closing: boolean; onOpen: () => void; onClose: () => void }) {
  const target = task.resource_type === "draft"
    ? `${task.target_summary.cards} card${task.target_summary.cards === 1 ? "" : "s"}`
    : [task.target_summary.slides ? `${task.target_summary.slides} slide${task.target_summary.slides === 1 ? "" : "s"}` : "", task.target_summary.objects ? `${task.target_summary.objects} object${task.target_summary.objects === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "Deck selection";
  const status = task.status === "open"
    ? { words: "Waiting for agent", tone: "waiting" as const }
    : task.status === "answered"
      ? { words: task.findings && !task.proposal_ids.length ? "Findings ready" : task.resource_type === "deck" ? "Ready for review" : "Answered", tone: "action" as const }
      : { words: "Completed", tone: "neutral" as const };
  return (
    <article className="dk-agent-task-card" data-testid="agent-task-card" data-task-status={task.status}>
      <div className="dk-agent-task-card__top">
        <span className="dk-eyebrow">{task.kind.toLocaleUpperCase()} · {task.resource_type === "draft" ? "ROUGH CANVAS" : "DECK"}</span>
        <StatusChip tone={status.tone}>{status.words}</StatusChip>
      </div>
      <blockquote>{task.message}</blockquote>
      <div className="dk-agent-task-card__resource">
        <strong>{task.resource_title}</strong>
        <span>{task.projectName} · {target} · requested {relativeTime(task.created_at, now)}</span>
      </div>
      {task.findings ? (
        <div className="dk-agent-task-card__findings" data-testid="agent-task-findings">
          {task.findings}
        </div>
      ) : null}
      {task.resource_deleted ? <p className="dk-agent-task-card__deleted">This item is in Trash. Restore it before opening.</p> : null}
      <div className="dk-agent-task-card__actions">
        <Button size="sm" variant="secondary" onClick={onOpen} disabled={task.resource_deleted}>
          {task.resource_type === "draft" ? "Open rough canvas" : "Open deck"}
        </Button>
        {task.status === "open" && task.editable ? (
          <Button size="sm" variant="ghost" onClick={onClose} disabled={closing} data-testid="cancel-agent-task">
            {closing ? "Cancelling…" : "Cancel request"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
