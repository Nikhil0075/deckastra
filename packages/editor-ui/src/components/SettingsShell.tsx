import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountContext } from "@deckastra/workspace-contracts";

import { rovingIndex } from "../lib/ui-keys";
import { Drawer } from "../ui";
import { cx } from "../ui/cx";

/** The sections roadmap 08 §1.3 names, in its order. */
export type SettingsSectionId = "account" | "plans" | "ai" | "agents" | "languages";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "account", label: "Account" },
  { id: "plans", label: "Plans and billing" },
  { id: "ai", label: "AI and privacy" },
  { id: "agents", label: "Agents" },
  { id: "languages", label: "Languages" },
];

/**
 * Settings, shared by the web and desktop shells (roadmap 08 §1.3, `08-plans.png`).
 *
 * One place for what used to be scattered: the Intelligence drawer, the agent
 * switch, and next the plan and its credits. The shell owns the frame and the
 * navigation; each host passes the content it can actually offer. A section a
 * host does not pass is **absent**, not shown empty: Plans and billing appears
 * when there is a plan to show, rather than as a page that says "coming soon".
 *
 * The section list is a vertical tablist with roving focus. Up and Down move
 * between sections and show them, so the content follows the keyboard the way
 * it follows the mouse.
 */
export function SettingsShell({
  open,
  onClose,
  section,
  onSection,
  content,
}: {
  open: boolean;
  onClose: () => void;
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  content: Partial<Record<SettingsSectionId, ReactNode>>;
}) {
  const offered = SETTINGS_SECTIONS.filter(({ id }) => content[id] !== undefined && content[id] !== null);
  const showing = offered.some(({ id }) => id === section) ? section : offered[0]?.id;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = rovingIndex(index, offered.length, event.key, { orientation: "vertical" });
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onSection(offered[next]!.id);
  };

  return (
    <Drawer open={open} onClose={onClose} title="Settings" width={760} data-testid="settings">
      <div className="dk-settings">
        <div className="dk-settings__nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {offered.map(({ id, label }, index) => (
            <button
              key={id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={id === showing}
              aria-controls="settings-panel"
              tabIndex={id === showing ? 0 : -1}
              className={cx("dk-settings__tab", id === showing && "dk-settings__tab--active")}
              onClick={() => onSection(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={`settings-tab-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="dk-settings__panel"
          role="tabpanel"
          id="settings-panel"
          aria-labelledby={showing ? `settings-tab-${showing}` : undefined}
          data-settings-section={showing}
        >
          {showing ? content[showing] : null}
        </div>
      </div>
    </Drawer>
  );
}

/**
 * Who is signed in and where their decks live. Read fresh each time it is
 * shown, because a restart can change the account underneath a cached one.
 * Four states, each said: reading, could not read, a local install, an account.
 *
 * `online` is the host saying where its decks live. A server calls its own
 * workspaces `local` (they are, from where it stands), so a web page reading
 * `origin` alone would tell a signed-in person their decks are "on this
 * computer".
 */
export function AccountSettings({ online = false }: { online?: boolean } = {}) {
  const client = useWorkspaceClient();
  const [account, setAccount] = useState<AccountContext | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.session
      .account({ fresh: true })
      .then((value) => live && setAccount(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [client]);

  if (failed) {
    return (
      <p className="dk-settings__error" role="alert">
        Your account could not be read. Check that Deckastra is running, then open Settings again.
      </p>
    );
  }
  if (!account) return <p className="dk-muted">Reading your account…</p>;

  const local = !online && account.workspaces.every((workspace) => workspace.origin === "local");
  return (
    <div className="dk-settings__section" data-testid="settings-account">
      <h3 className="dk-settings__heading">Account</h3>
      {local ? (
        <p>Your decks are kept on this computer. Nothing here is signed in to an online account.</p>
      ) : (
        <dl className="dk-settings__facts">
          <dt>Name</dt>
          <dd>{account.user.name ?? account.user.email}</dd>
          <dt>Email</dt>
          <dd>{account.user.email}</dd>
        </dl>
      )}
      <h3 className="dk-settings__heading">Workspaces</h3>
      <ul className="dk-settings__list">
        {account.workspaces.map((workspace) => (
          <li key={workspace.id}>
            <span>{workspace.name}</span>
            <span className="dk-muted">
              {workspace.origin === "local" && !online ? "On this computer" : "Online"} · {workspace.projects.length} project
              {workspace.projects.length === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
