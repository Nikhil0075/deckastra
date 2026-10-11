import { useSyncExternalStore } from "react";
import type { ExportJob } from "@deckastra/workspace-contracts";

/**
 * Long jobs the person started, kept where they can find them again (UI audit
 * Unit 9: the task centre).
 *
 * An export used to live only in the panel that started it. Closing the deck
 * list's export drawer, or leaving the deck, unmounted the panel and forgot a
 * job the service was still running: the file was made, and nobody was told.
 * This store outlives every screen in the window. A panel reports its job here
 * as it goes, and hands the job over when it unmounts, so the polling carries
 * on and the result has somewhere to land.
 *
 * Per window and in memory, on purpose: a task is "what I started in this
 * session". A finished export's file stays on the service either way, and the
 * export panel can always make another.
 */

export type TaskStatus = "running" | "ready" | "failed" | "cancelled";

export interface Task {
  /** The export job's id. One job is one task, however many times it is reported. */
  id: string;
  presentationId: string;
  /** The deck's name, for "PDF of Quarterly review". */
  deckTitle: string | null;
  job: ExportJob;
  status: TaskStatus;
  /** 0–1 while running, when the service says. */
  progress: number | null;
  /** Something a person can read: the stage, the failure, or where it ended. */
  message: string | null;
  startedAt: number;
}

/** What a task needs to poll on its own. A narrow slice of `WorkspaceClient`. */
export interface TaskExportsClient {
  status(jobId: string, options?: { signal?: AbortSignal }): Promise<ExportJob>;
}

const KIND_WORDS: Record<string, string> = {
  pdf: "PDF",
  pptx: "PowerPoint",
  mp4: "Video",
  mydeck: "Deckastra file",
  png: "Picture",
};

/** "PDF of Quarterly review", or "PDF export" without a name. */
export function taskTitle(task: Pick<Task, "job" | "deckTitle">): string {
  const kind = KIND_WORDS[task.job.kind] ?? task.job.kind.toUpperCase();
  return task.deckTitle ? `${kind} of ${task.deckTitle}` : `${kind} export`;
}

export function statusOf(job: ExportJob): TaskStatus {
  if (job.status === "completed") return "ready";
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "queued" || job.status === "running") return "running";
  return "failed";
}

function messageOf(job: ExportJob, status: TaskStatus): string | null {
  if (status === "failed") return job.error ?? job.message ?? "The export failed.";
  if (status === "cancelled") return "Cancelled.";
  if (status === "running") return job.stage ?? (job.status === "queued" ? "Waiting to start" : null);
  return null;
}

const tasks = new Map<string, Task>();
let snapshot: readonly Task[] = [];
const listeners = new Set<() => void>();
/** Jobs this store is polling itself, so a second handover does not start a second loop. */
const following = new Map<string, AbortController>();

function publish(): void {
  // Newest first, and a new array each time: useSyncExternalStore compares by
  // identity, and a mutated array would never re-render anyone.
  snapshot = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  for (const listener of listeners) listener();
}

/**
 * A panel saying where its job is. Idempotent by job id: the panel reports on
 * every poll, and a task is updated in place rather than listed twice.
 */
export function reportExport(presentationId: string, deckTitle: string | null, job: ExportJob): void {
  const status = statusOf(job);
  const known = tasks.get(job.id);
  tasks.set(job.id, {
    id: job.id,
    presentationId,
    deckTitle: deckTitle ?? known?.deckTitle ?? null,
    job,
    status,
    progress: status === "running" && Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : null,
    message: messageOf(job, status),
    startedAt: known?.startedAt ?? Date.now(),
  });
  publish();
}

/**
 * Keep polling a job nobody is watching any more: the panel that started it
 * has gone. Ends on its own when the job ends; at most one loop per job.
 */
export function followExport(
  client: TaskExportsClient,
  presentationId: string,
  deckTitle: string | null,
  job: ExportJob,
  { intervalMs = 800 }: { intervalMs?: number } = {},
): void {
  reportExport(presentationId, deckTitle, job);
  if (statusOf(job) !== "running" || following.has(job.id)) return;
  const controller = new AbortController();
  following.set(job.id, controller);
  void (async () => {
    let current = job;
    try {
      while (statusOf(current) === "running") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, intervalMs);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Stopped", "AbortError"));
            },
            { once: true },
          );
        });
        current = await client.status(current.id, { signal: controller.signal });
        reportExport(presentationId, deckTitle, current);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        // The job may well have finished; what failed is asking. Said as such,
        // rather than as a failed export.
        const known = tasks.get(job.id);
        if (known && known.status === "running") {
          tasks.set(job.id, { ...known, status: "failed", progress: null, message: "Lost touch with this export. Export it again from Share." });
          publish();
        }
      }
    } finally {
      following.delete(job.id);
    }
  })();
}

/** A panel taking a job back (it is on screen again): the store stops its own loop. */
export function stopFollowing(jobId: string): void {
  following.get(jobId)?.abort();
  following.delete(jobId);
}

export function dismissTask(id: string): void {
  stopFollowing(id);
  if (tasks.delete(id)) publish();
}

/** Clear everything that has ended. Running tasks stay. */
export function clearFinishedTasks(): void {
  let changed = false;
  for (const [id, task] of tasks) {
    if (task.status !== "running") {
      tasks.delete(id);
      changed = true;
    }
  }
  if (changed) publish();
}

export function useTasks(): readonly Task[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** For tests: start from nothing. */
export function resetTasksForTests(): void {
  for (const controller of following.values()) controller.abort();
  following.clear();
  tasks.clear();
  publish();
}
