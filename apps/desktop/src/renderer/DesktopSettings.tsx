import { useEffect, useState } from "react";
import { Button, InlineError, Skeleton } from "@deckastra/editor-ui/ui";
import {
  AccountSettings,
  AgentSetupGuide,
  AppearanceSettings,
  CreditsMeter,
  LanguageVoiceSettings,
  SettingsAdvanced,
  SettingsShell,
  WorkspaceSettings,
  type AgentLauncher,
  type SettingsSectionId,
} from "@deckastra/editor-ui";

import type { AccountState } from "../shared/account";
import type { AgentAccess, DesktopBridge, DesktopInfo, HostAction } from "../shared/ipc";

/**
 * The desktop's Settings (roadmap 08 §1.3, UI audit Unit 8): the shared shell,
 * full screen, with the sections this install can actually offer.
 *
 * It replaced the Intelligence drawer, and keeps the drawer's one rule: an
 * installed app must not ask anyone to set an environment variable to find out
 * what happens to their words. Profile signs in through the system browser;
 * Plan & credits shows the account's AI credits (never a purchase: none can
 * exist before track 3); Agents & services holds the switch that lets Claude
 * Code or Codex in; Privacy & data says what leaves the machine and offers the
 * backup and the diagnostics report; About says which build this is.
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
      placement="full"
      content={{
        account: (
          <>
            <DesktopAccount />
            <AccountSettings />
          </>
        ),
        plans: <Plans onSignIn={() => onSection("account")} />,
        workspaces: <WorkspaceSettings />,
        agents: <Agents access={access} onChange={onAgentAccessChange} bridge={bridge} />,
        languages: <LanguageVoiceSettings />,
        appearance: <AppearanceSettings />,
        ai: <PrivacyAndData bridge={bridge} />,
        about: <About bridge={bridge} />,
      }}
    />
  );
}

/**
 * One of main's own dialogs, run from Settings. Main owns the dialog and the
 * path; the page names the action and says when it is done, because a backup
 * someone pressed for and never heard back about reads as one that failed.
 */
function HostActionButton({
  bridge,
  action,
  label,
  busyLabel,
  variant = "secondary",
}: {
  bridge: DesktopBridge;
  action: HostAction;
  label: string;
  busyLabel: string;
  variant?: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <Button
        size="sm"
        variant={variant}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          bridge
            .hostAction(action)
            .catch(() => setError("That did not work. Try again from the menu bar."))
            .finally(() => setBusy(false));
        }}
        data-testid={`settings-action-${action}`}
      >
        {busy ? busyLabel : label}
      </Button>
      {error ? <InlineError>{error}</InlineError> : null}
    </span>
  );
}

/**
 * What leaves this computer, and the person's own copies of what stays. The id
 * is `ai` for the acceptance harness, which reads the deck-creation sentence
 * here.
 */
function PrivacyAndData({ bridge }: { bridge: DesktopBridge }) {
  return (
    <div className="dk-settings__section" data-testid="settings-ai">
      <h3 className="dk-settings__heading">What is sent</h3>
      <p className="dk-muted">
        Your decks stay on this computer. Only paid media, translation and voice requests send the content needed for
        that request to Deckastra&apos;s service. Editing, templates, design checks and exports do not.
      </p>
      <h3 className="dk-settings__heading">Creating decks</h3>
      <p className="dk-muted">
        Templates are composed on this computer by fixed layout rules. Connect your own agent in Agents &amp; services
        when you want it to write the story; Deckastra does not run a hidden writing model.
      </p>
      <h3 className="dk-settings__heading">Backups</h3>
      <p className="dk-muted">
        A backup is one file holding every deck, its history, its pictures and any unsaved work in open windows.
      </p>
      <div className="dk-settings__actions">
        <HostActionButton bridge={bridge} action="back-up" label="Back up…" busyLabel="Backing up…" variant="primary" />
        <HostActionButton bridge={bridge} action="restore-backup" label="Restore from a backup…" busyLabel="Restoring…" />
      </div>
      <h3 className="dk-settings__heading">If something goes wrong</h3>
      <p className="dk-muted">
        A diagnostics report says how this install is doing, for a bug report. It holds no slide text, no deck titles
        and no keys.
      </p>
      <HostActionButton
        bridge={bridge}
        action="export-diagnostics"
        label="Export diagnostics…"
        busyLabel="Writing the report…"
      />
    </div>
  );
}

/** Which build this is, in words first and in detail under Advanced. */
function About({ bridge }: { bridge: DesktopBridge }) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    bridge
      .info()
      .then((value) => live && setInfo(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [bridge]);

  const build = info?.build as
    | { source?: { commit?: string | null; dirty?: boolean | null }; builtAt?: string }
    | null
    | undefined;
  const commit = build?.source?.commit ?? null;
  return (
    <div className="dk-settings__section" data-testid="settings-about">
      <h3 className="dk-settings__heading">Deckastra</h3>
      {failed ? (
        <InlineError>This build could not be described. Restart Deckastra and try again.</InlineError>
      ) : info ? (
        <p data-testid="settings-about-version">Version {info.appVersion}</p>
      ) : (
        <Skeleton label="Reading this build" lines={1} />
      )}
      <p className="dk-muted">
        Upgrades are installed by hand: install the newer version over this one. Your decks are kept.
      </p>
      <HostActionButton bridge={bridge} action="third-party-notices" label="Third-party notices" busyLabel="Opening…" />
      {info ? (
        <SettingsAdvanced testId="settings-about-advanced">
          <dl className="dk-settings__facts">
            <dt>Build</dt>
            <dd className="dk-settings__code">
              {commit ? `${commit.slice(0, 12)}${build?.source?.dirty ? " (changed)" : ""}` : "Not recorded"}
              {build?.builtAt ? ` · ${build.builtAt}` : ""}
            </dd>
            <dt>Runtime</dt>
            <dd className="dk-settings__code">
              Electron {info.electronVersion} · Chromium {info.chromeVersion} · {info.platform}
            </dd>
            <dt>Data</dt>
            <dd className="dk-settings__code">{info.dataDir}</dd>
          </dl>
        </SettingsAdvanced>
      ) : null}
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
        <Skeleton label="Reading your sign-in" lines={2} />
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
      {error ? <InlineError data-testid="settings-sign-in-error">{error}</InlineError> : null}
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
        <Skeleton label="Reading whether agents may connect" lines={2} />
      )}
      {launcher ? (
        <AgentSetupGuide launcher={launcher} onCopy={(text) => bridge.writeClipboardText(text)} />
      ) : setupError ? (
        <InlineError>The setup command could not be prepared. Restart Deckastra and try again.</InlineError>
      ) : (
        <Skeleton label="Preparing setup instructions" lines={3} />
      )}
      <h3 className="dk-settings__heading">Services</h3>
      <p className="dk-muted">
        Pictures, translation and voices are made by Deckastra&apos;s service when you ask for them, and use your
        account&apos;s credits. Each one says what it will cost before it runs.
      </p>
    </div>
  );
}
