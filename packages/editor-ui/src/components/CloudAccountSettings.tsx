import { useEffect, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountCapabilities, AccountDeletion } from "@deckastra/workspace-contracts";

import { serviceWords } from "../lib/assistant-words";
import { Button, InlineError, Skeleton, StatusChip, TextField } from "../ui";

/**
 * Settings sections for an account kept online (FRONTEND_BACKEND_HANDOFF.md,
 * "Web and account state"). Each one is absent where the client cannot offer
 * what it needs, like every other Settings section.
 */

/** What the hosted AI can do for this account, task by task. */
const TASK_WORDS: Record<string, string> = {
  image: "Making pictures",
};

export function AiTaskSettings() {
  const client = useWorkspaceClient();
  const read = client.session.capabilities;
  const [answer, setAnswer] = useState<AccountCapabilities | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!read) return;
    let live = true;
    setFailed(false);
    read({ fresh: true })
      .then((value) => live && setAnswer(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [read, attempt]);

  if (!read) return null;
  const tasks = answer ? Object.entries(answer.tasks) : [];
  const none = answer !== null && tasks.every(([, task]) => !task.available);

  return (
    <div className="dk-settings__section" data-testid="settings-ai-tasks">
      <h3 className="dk-settings__heading">AI help</h3>
      {failed ? (
        <InlineError onRetry={() => setAttempt((count) => count + 1)} data-testid="ai-tasks-error">
          What AI help can do could not be read just now.
        </InlineError>
      ) : !answer ? (
        <Skeleton label="Reading what AI help can do" lines={3} />
      ) : none ? (
        <p data-testid="ai-tasks-off">
          AI help is not switched on yet. Everything else, from editing to exporting, works as usual and uses no credits.
        </p>
      ) : (
        <ul className="dk-settings__list" data-testid="ai-tasks">
          {tasks.map(([name, task]) => (
            <li key={name} data-task={name} data-available={task.available}>
              <span>{TASK_WORDS[name] ?? name}</span>
              {task.available ? (
                <StatusChip tone="neutral">Available</StatusChip>
              ) : (
                <span className="dk-muted">{serviceWords(task.reason, "Not available yet")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="dk-settings__heading">What is sent</h3>
      <p className="dk-muted">
        Decks you keep online are stored in your account. When you ask for AI help, only your request and what you
        chose for it to work on are sent for that request. Editing, checks and exports never use credits.
      </p>
    </div>
  );
}

/**
 * Deleting the online account. Typed confirmation, because it cannot be undone.
 * The host signs out once the service accepts (`onDeleted`), since from then on
 * the account refuses every request.
 */
export function AccountDeletionSettings({ onDeleted }: { onDeleted: (receipt: AccountDeletion) => void | Promise<void> }) {
  const client = useWorkspaceClient();
  const remove = client.session.deleteAccount;
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!remove) return null;

  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const receipt = await remove();
      await onDeleted(receipt);
    } catch (caught) {
      setProblem(deletionProblem(caught));
      setBusy(false);
    }
  };

  return (
    <div className="dk-settings__section" data-testid="settings-delete-account">
      <h3 className="dk-settings__heading">Delete account</h3>
      <p className="dk-muted">
        Deletes your online account, the decks and files kept in it, and its credits. Files you saved to your own
        computer are not affected. This cannot be undone.
      </p>
      {!asking ? (
        <Button size="sm" variant="danger" onClick={() => setAsking(true)} data-testid="delete-account">
          Delete account…
        </Button>
      ) : (
        <form
          className="dk-settings__confirm"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed === "DELETE" && !busy) void confirm();
          }}
        >
          <TextField
            label="Type DELETE to confirm"
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            autoFocus
            data-testid="delete-account-confirm-text"
          />
          <span className="dk-settings__confirm-actions">
            <Button
              size="sm"
              variant="danger"
              type="submit"
              disabled={typed !== "DELETE" || busy}
              data-testid="delete-account-confirm"
            >
              {busy ? "Deleting…" : "Delete my account"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                setTyped("");
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}
      {problem ? (
        <p className="dk-settings__error" role="alert" data-testid="delete-account-problem">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The service's refusal, in words that say what to do next. */
export function deletionProblem(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : "";
  if (status === 409 && /transfer ownership/i.test(message)) {
    return "You own a workspace other people use. Give it to another member, or remove them from it, before deleting your account.";
  }
  if (status === 409) return serviceWords(message, "This account cannot be deleted from here. Contact support.");
  if (status === 503) return "Account deletion is not available right now. Try again later.";
  if (status === 0) return "Could not reach Deckastra. Check your connection and try again.";
  return "Your account could not be deleted just now. Try again.";
}
