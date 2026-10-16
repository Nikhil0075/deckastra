import { useEffect, useState } from "react";
import { Button, Popover } from "@deckastra/editor-ui/ui";
import { useOptionalWorkspaceClient } from "@deckastra/workspace-client/react";

import type { AgentAccess } from "../shared/ipc";

/**
 * Whether agents may reach this install, and the switch that decides it — a
 * chip in the editor's top bar that opens to the explanation and the switch.
 *
 * The credential an agent gets is already narrow — read, write and export, never
 * approving its own work and never minting a share link, refused by the service
 * rather than by which tools an adapter registered. But narrow is not the same as
 * asked for, so nothing is published until this says yes, and it says no on a
 * fresh install and after every update.
 *
 * The chip is always visible and says the state in words: grey "Agents off",
 * yellow "Agents on" — yellow because a live grant is something the user should
 * keep an eye on, which is the one thing yellow means in this palette.
 *
 * It lapses after twelve hours. A permission that never expires is one nobody
 * revisits, and the honest place to say when it ends is next to the switch that
 * started it.
 *
 * The popover keeps its content mounted while closed, so the status line and
 * the switch exist in the page whether or not it is open — the consent smoke
 * step reads the one and presses the other.
 */
export function AgentAccessControl({
  access,
  onChange,
}: {
  access: AgentAccess | null;
  onChange: (allow: boolean) => void;
}) {
  const lastSeen = useAgentLastSeen(Boolean(access?.allowed));
  if (!access) return null;
  const seen = activityWords(lastSeen);

  const until = access.expiresAt
    ? new Date(access.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <Popover
      label="Agent access"
      align="end"
      keepMounted
      className="dk-agent-access"
      trigger={(props) => (
        <Button
          size="sm"
          variant="secondary"
          className={access.allowed ? "dk-agent-chip dk-agent-chip--on" : "dk-agent-chip"}
          // The whole sentence is the name and the tooltip; the time is the
          // part a narrow bar drops (UI audit follow-up: at 1366px the full
          // chip pushed the bar's end group across the mode switch).
          aria-label={access.allowed ? `Agents on${until ? ` until ${until}` : ""}` : "Agents off"}
          title={access.allowed ? `Agents on${until ? ` until ${until}` : ""}` : "Agents off"}
          data-testid="agent-access-open"
          {...props}
        >
          {access.allowed ? (
            <>
              {seen.active ? "Agent connected" : "Agents on"}
              {until ? <span className="dk-agent-chip__until"> · until {until}</span> : null}
            </>
          ) : (
            "Agents off"
          )}
        </Button>
      )}
    >
      <span className="dk-accent-rule" aria-hidden="true" />
      <p className="dk-agent-access__text" role="status">
        {access.allowed
          ? `Agents can read, edit and export your decks until ${until}. They cannot approve their own changes or share a deck.`
          : "Agents cannot reach this app. Turn this on to let Claude Code or Codex work on your decks."}
      </p>
      {access.allowed ? (
        <p className="dk-agent-access__text" data-testid="agent-activity" data-agent-active={seen.active ? "true" : "false"}>
          {seen.words}
        </p>
      ) : null}
      <Button
        variant={access.allowed ? "danger" : "primary"}
        onClick={() => onChange(!access.allowed)}
        data-testid="agent-access-toggle"
      >
        {access.allowed ? "Stop agent access" : "Allow agent access"}
      </Button>
    </Popover>
  );
}

/**
 * When a connected agent last reached the service, polled while access is on
 * (release E2E step 3: "Deckastra shows the agent connection or activity").
 * Seconds since the epoch, or null when none has since the service started.
 */
function useAgentLastSeen(enabled: boolean): number | null {
  const client = useOptionalWorkspaceClient();
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const ask = client?.session.agentActivity;
    if (!enabled || !ask) {
      setLastSeen(null);
      return;
    }
    let live = true;
    const read = () =>
      void ask()
        .then((answer) => {
          if (live) setLastSeen(answer.last_request_at);
        })
        .catch(() => undefined);
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") read();
      setTick((value) => value + 1);
    }, 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [client, enabled]);
  return lastSeen;
}

/** "Connected now" within two minutes of the last request; otherwise when. */
export function activityWords(lastSeen: number | null, now = Date.now()): { active: boolean; words: string } {
  if (lastSeen === null) return { active: false, words: "No agent has connected yet. Point Claude Code or Codex at the Deckastra MCP server (Settings › Agents & services)." };
  const seconds = Math.max(0, Math.round(now / 1000 - lastSeen));
  if (seconds < 120) return { active: true, words: "An agent is connected and working now." };
  const minutes = Math.round(seconds / 60);
  return { active: false, words: minutes < 60 ? `An agent last connected ${minutes} minutes ago.` : `An agent last connected ${Math.round(minutes / 60)} hour${minutes < 90 ? "" : "s"} ago.` };
}
