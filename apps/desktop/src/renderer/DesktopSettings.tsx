import { useEffect, useState } from "react";
import { Button } from "@deckastra/editor-ui/ui";
import {
  AccountSettings,
  AgentSetupGuide,
  CreditsMeter,
  SettingsShell,
  type AgentLauncher,
  type SettingsSectionId,
} from "@deckastra/editor-ui";

import type { AccountState } from "../shared/account";
import type { AgentAccess, DesktopBridge } from "../shared/ipc";

/**
 * The desktop's Settings (roadmap 08 §1.3): the shared shell, with the sections
 * this install can actually offer.
 *
 * It replaces the Intelligence drawer, and keeps the drawer's one rule: an
 * installed app must not ask anyone to set an environment variable to find out
 * what happens to their words. Account signs in through the system browser;
 * Plans and billing shows the account's AI credits (never a purchase: none can
 * exist before track 3); AI and privacy says what leaves the machine; Agents
 * holds the switch that lets Claude Code or Codex in. Own API keys are retired
 * (track 2), and so is the field that took one.
 *
 * Read fresh each time it opens: the answer depends on the service's
 * configuration, which a restart can change underneath a cached account.
 */
export function DesktopSettings({
  open,
  onClose,
  section,
  onSection,
  access,
  onAgentAccessChange,
  bridge,
}: {
  open: boolean;
  onClose: () => void;
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  access: AgentAccess | null;
  onAgentAccessChange: (allow: boolean) => void;
  bridge: DesktopBridge;
}) {
  return (
    <SettingsShell
      open={open}
      onClose={onClose}
      section={section}
      onSection={onSection}
      content={{
        account: (
          <>
            <DesktopAccount />
            <AccountSettings />
          </>
        ),
        plans: <Plans onSignIn={() => onSection("account")} />,
        ai: <AiAndPrivacy />,
        agents: <Agents access={access} onChange={onAgentAccessChange} bridge={bridge} />,
      }}
    />
  );
}

function AiAndPrivacy() {
  return (
    <div className="dk-settings__section" data-testid="settings-ai">
      <h3 className="dk-settings__heading">Creating decks</h3>
      <p className="dk-muted">
        Templates and StoryPlans are composed on this computer by deterministic layout code. Connect your own agent
        in Agents when you want it to write the story; Deckastra does not run a hidden writing model.
      </p>
      <h3 className="dk-settings__heading">What is sent</h3>
      <p className="dk-muted">
        Your decks stay on this computer. Only paid media, translation and voice requests send the content needed for
        that request to Deckastra&apos;s service. Editing, templates, design checks and exports do not.
      </p>
    </div>
  );
}

/**
 * Who is signed in (FRONTEND_BACKEND_HANDOFF.md, Desktop). The page learns a
 * state and an email and nothing else: the main process keeps every token, and
 * signing in happens in the system browser.
 */
function DesktopAccount() {
  const bridge = typeof window === "undefined" ? undefined : window.deckastraAccount;
  const [state, setState] = useState<AccountState | null>(null);
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge
      ?.state()
      .then((value) => !cancelled && setState(value))
      .catch(() => !cancelled && setError("Your sign-in could not be read."));
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  const act = async (kind: "in" | "out") => {
    setBusy(kind);
    setError(null);
    try {
      setState(await (kind === "in" ? bridge.signIn() : bridge.signOut()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dk-settings__section" data-testid="settings-sign-in">
      <h3 className="dk-settings__heading">Deckastra account</h3>
      {state === null && !error ? (
        <p className="dk-muted" role="status">
          Reading your sign-in…
        </p>
      ) : state && !state.configured ? (
        <p className="dk-muted">Signing in is not available in this build.</p>
      ) : state?.signedIn ? (
        <>
          <p data-testid="settings-signed-in">Signed in as {state.email ?? "your account"}.</p>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act("out")} data-testid="settings-sign-out">
            {busy === "out" ? "Signing out…" : "Sign out"}
          </Button>
        </>
      ) : state ? (
        <>
          <p className="dk-muted">
            Sign in to use AI help with your account&apos;s credits. Everything else works without an account.
          </p>
          <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void act("in")} data-testid="settings-sign-in-button">
            {busy === "in" ? "Finish signing in in your browser…" : "Sign in"}
          </Button>
        </>
      ) : null}
      {error ? (
        <p className="dk-settings__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Plans({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="dk-settings__section" data-testid="settings-plans">
      <h3 className="dk-settings__heading">AI credits</h3>
      <CreditsMeter variant="card" onOpenSettings={onSignIn} />
      <p className="dk-muted">Credits pay for AI help only. Editing, checks and exports never use them.</p>
    </div>
  );
}

/**
 * The agent switch, in full. The bar's chip says the state at a glance; this is
 * where the decision is explained. Its own test ids, so the chip's popover and
 * this panel are never the same element to the acceptance harness.
 */
function Agents({
  access,
  onChange,
  bridge,
}: {
  access: AgentAccess | null;
  onChange: (allow: boolean) => void;
  bridge: DesktopBridge;
}) {
  const [launcher, setLauncher] = useState<AgentLauncher | null>(null);
  const [setupError, setSetupError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge
      .agentSetup()
      .then((value) => {
        if (!cancelled) setLauncher(value);
      })
      .catch(() => {
        if (!cancelled) setSetupError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const until = access?.expiresAt
    ? new Date(access.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="dk-settings__section" data-testid="settings-agents">
      <h3 className="dk-settings__heading">Agents</h3>
      <p className="dk-muted">
        Your coding agent can write and change decks here, using the same commands you have. It suggests changes;
        anything large or destructive waits for you. Nothing is sent anywhere by this app: the agent runs where you run it.
      </p>
      {access ? (
        <>
          <p role="status" data-testid="settings-agent-status">
            {access.allowed
              ? `Agents can read, edit and export your decks${until ? ` until ${until}` : ""}. They cannot approve their own changes or share a deck.`
              : "Agents cannot reach this app."}
          </p>
          <Button
            size="sm"
            variant={access.allowed ? "danger" : "primary"}
            onClick={() => onChange(!access.allowed)}
            data-testid="settings-agent-toggle"
          >
            {access.allowed ? "Stop agent access" : "Allow agent access"}
          </Button>
        </>
      ) : (
        <p className="dk-muted">Reading whether agents may connect…</p>
      )}
      {launcher ? (
        <AgentSetupGuide launcher={launcher} onCopy={(text) => bridge.writeClipboardText(text)} />
      ) : setupError ? (
        <p className="dk-settings__error" role="alert">
          The setup command could not be prepared. Restart Deckastra and try again.
        </p>
      ) : (
        <p className="dk-muted" role="status">Preparing setup instructions…</p>
      )}
    </div>
  );
}
