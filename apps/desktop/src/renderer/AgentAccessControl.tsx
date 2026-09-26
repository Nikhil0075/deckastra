import { Button, Popover } from "@deckastra/editor-ui/ui";

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
  if (!access) return null;

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
          data-testid="agent-access-open"
          {...props}
        >
          {access.allowed ? `Agents on${until ? ` · until ${until}` : ""}` : "Agents off"}
        </Button>
      )}
    >
      <span className="dk-accent-rule" aria-hidden="true" />
      <p className="dk-agent-access__text" role="status">
        {access.allowed
          ? `Agents can read, edit and export your decks until ${until}. They cannot approve their own changes or share a deck.`
          : "Agents cannot reach this app. Turn this on to let Claude Code or Codex work on your decks."}
      </p>
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
