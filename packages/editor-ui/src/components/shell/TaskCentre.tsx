import { useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import { downloadExport } from "../../lib/export-download";
import { clearFinishedTasks, dismissTask, followExport, taskTitle, useTasks, type Task } from "../../lib/tasks";
import { Button, IconButton, InlineError, Popover, StatusChip, type StatusTone } from "../../ui";

/**
 * The task centre (UI audit Unit 9): exports and other long jobs, in one place
 * that survives leaving the panel or the deck that started them.
 *
 * Absent while there is nothing to show, because an empty tray is a control
 * that does nothing. Each task says its state in words beside any colour: a
 * chip reads "Working", "Ready", "Failed" or "Cancelled".
 */
export function TaskCentre() {
  const tasks = useTasks();
  if (tasks.length === 0) return null;
  const running = tasks.filter((task) => task.status === "running").length;
  const label = running ? `Tasks: ${running} working` : `Tasks: ${tasks.length} finished`;

  return (
    <Popover
      label="Tasks"
      align="end"
      className="dk-tasks"
      data-testid="task-centre-panel"
      trigger={(props) => (
        <Button
          size="sm"
          variant="ghost"
          icon="download"
          title={label}
          aria-label={label}
          data-testid="task-centre"
          data-running={running}
          {...props}
        >
          {running ? `${running} working` : "Done"}
        </Button>
      )}
    >
      <div className="dk-tasks__header">
        <h3 className="dk-label">Tasks</h3>
        <Button size="sm" variant="ghost" onClick={clearFinishedTasks} disabled={running === tasks.length}>
          Clear finished
        </Button>
      </div>
      <ul className="dk-tasks__list">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
    </Popover>
  );
}

const STATUS: Record<Task["status"], { tone: StatusTone; words: string }> = {
  running: { tone: "waiting", words: "Working" },
  ready: { tone: "action", words: "Ready" },
  failed: { tone: "danger", words: "Failed" },
  cancelled: { tone: "neutral", words: "Cancelled" },
};

function TaskRow({ task }: { task: Task }) {
  const client = useWorkspaceClient();
  const [problem, setProblem] = useState<string | null>(null);
  const status = STATUS[task.status];
  const percent = task.progress === null ? null : Math.round(task.progress * 100);

  const retry = async () => {
    setProblem(null);
    try {
      const restarted = await client.exports.retry(task.job.id);
      dismissTask(task.id);
      followExport(client.exports, task.presentationId, task.deckTitle, restarted);
    } catch {
      setProblem("This export could not be started again.");
    }
  };

  return (
    <li className="dk-tasks__row" data-task-id={task.id} data-task-status={task.status}>
      <div className="dk-tasks__top">
        <span className="dk-tasks__title">{taskTitle(task)}</span>
        <StatusChip tone={status.tone}>{status.words}</StatusChip>
        <IconButton icon="close" label={`Dismiss ${taskTitle(task)}`} size="sm" onClick={() => dismissTask(task.id)} />
      </div>
      {task.status === "running" ? (
        <div
          className="dk-tasks__bar"
          role="progressbar"
          aria-label={taskTitle(task)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent === null ? task.message ?? "Working" : `${percent}%`}
        >
          <span className="dk-tasks__fill" style={{ width: `${percent ?? 8}%` }} />
        </div>
      ) : null}
      {task.message ? <p className="dk-tasks__detail">{task.message}</p> : null}
      {task.status === "ready" ? (
        <Button
          size="sm"
          variant="primary"
          icon="download"
          onClick={() =>
            void downloadExport(client.exports, task.job).then(
              (ok) => ok || setProblem("The file is no longer available. Export it again."),
            )
          }
          data-testid="task-download"
        >
          Download
        </Button>
      ) : task.status === "failed" ? (
        <Button size="sm" variant="secondary" onClick={() => void retry()} data-testid="task-retry">
          Try again
        </Button>
      ) : null}
      {problem ? <InlineError>{problem}</InlineError> : null}
    </li>
  );
}
