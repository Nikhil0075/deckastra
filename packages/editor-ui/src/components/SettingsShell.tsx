import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountContext, AccountWorkspace } from "@deckastra/workspace-contracts";

import { useChromeTheme, type ThemePreference } from "../lib/chrome-theme";
import { formatPronunciations, parsePronunciations, storedPronunciations } from "../lib/pronunciations";
import { rovingIndex } from "../lib/ui-keys";
import { Drawer, InlineError, NumberField, Segmented, Skeleton } from "../ui";
import { cx } from "../ui/cx";

/**
 * The sections, in the order Unit 8 of the UI audit gives them. The ids are
 * older than the labels and stay as they are: the desktop acceptance harness
 * and the hosts address sections by id, so `ai` is still the id of what reads
 * "Privacy & data".
 */
export type SettingsSectionId =
  | "account"
  | "plans"
  | "workspaces"
  | "agents"
  | "languages"
  | "appearance"
  | "ai"
  | "about";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "account", label: "Profile" },
  { id: "plans", label: "Plan & credits" },
  { id: "workspaces", label: "Workspaces" },
  { id: "agents", label: "Agents & services" },
  { id: "languages", label: "Languages & voice" },
  { id: "appearance", label: "Appearance" },
  { id: "ai", label: "Privacy & data" },
  { id: "about", label: "About" },
];

/**
 * Whether a value names a section. Hosts take `onOpenSettings` from places
 * that wire it straight to a click handler, so a mouse event can arrive where
 * a section was expected; that must open Settings, not pick a section named
 * "[object PointerEvent]".
 */
export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && SETTINGS_SECTIONS.some(({ id }) => id === value);
}

/**
 * Settings, shared by the web and desktop shells (roadmap 08 §1.3, UI audit
 * Unit 8).
 *
 * The shell owns the frame and the navigation; each host passes the content it
 * can actually offer. A section a host does not pass is **absent**, not shown
 * empty: a page that says "coming soon" is a broken surface.
 *
 * `placement` is the host's: the desktop fills the window, because nothing
 * behind Settings needs to stay in view; the web opens a wide dialog over the
 * page it came from.
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
  placement = "center",
}: {
  open: boolean;
  onClose: () => void;
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  content: Partial<Record<SettingsSectionId, ReactNode>>;
  placement?: "center" | "full";
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
    <Drawer open={open} onClose={onClose} title="Settings" placement={placement} data-testid="settings">
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
 * Technical facts a person rarely needs and a bug report always does: ids,
 * versions, where the data is. Folded away, so the section reads in plain
 * words first.
 */
export function SettingsAdvanced({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <details className="dk-settings__advanced" data-testid={testId}>
      <summary>Advanced</summary>
      {children}
    </details>
  );
}

/**
 * The account, read fresh each time it is shown, because a restart can change
 * it underneath a cached one. Four states, each said: reading, could not read,
 * a local install, an account. Shared by Profile and Workspaces.
 */
function useFreshAccount(): { account: AccountContext | null; failed: boolean; retry: () => void } {
  const client = useWorkspaceClient();
  const [account, setAccount] = useState<AccountContext | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed(false);
    client.session
      .account({ fresh: true })
      .then((value) => live && setAccount(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [client, attempt]);

  return { account, failed, retry: () => setAttempt((count) => count + 1) };
}

function AccountUnreadable({ onRetry }: { onRetry: () => void }) {
  return (
    <InlineError onRetry={onRetry} data-testid="settings-account-error">
      Your account could not be read. Check that Deckastra is running.
    </InlineError>
  );
}

/**
 * `online` is the host saying where its decks live. A server calls its own
 * workspaces `local` (they are, from where it stands), so a web page reading
 * `origin` alone would tell a signed-in person their decks are "on this
 * computer".
 */
function keptLocally(account: AccountContext, online: boolean): boolean {
  return !online && account.workspaces.every((workspace) => workspace.origin === "local");
}

/** Profile: who this is, in plain words. */
export function AccountSettings({ online = false }: { online?: boolean } = {}) {
  const { account, failed, retry } = useFreshAccount();
  if (failed) return <AccountUnreadable onRetry={retry} />;
  if (!account) return <Skeleton label="Reading your account" lines={2} />;

  return (
    <div className="dk-settings__section" data-testid="settings-account">
      <h3 className="dk-settings__heading">Profile</h3>
      {keptLocally(account, online) ? (
        <p>Your decks are kept on this computer. Nothing here is signed in to an online account.</p>
      ) : (
        <dl className="dk-settings__facts">
          <dt>Name</dt>
          <dd>{account.user.name ?? account.user.email}</dd>
          <dt>Email</dt>
          <dd>{account.user.email}</dd>
        </dl>
      )}
    </div>
  );
}

const ACCESS_WORDS: Record<AccountWorkspace["access"], string | null> = {
  authoritative: null,
  confirmed: null,
  stale: "Not checked online for a while. It still works.",
  lapsed: "Not checked online for too long. Connect to use it again.",
  revoked: "You no longer have access to this workspace.",
};

const ROLE_WORDS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Can edit",
  commenter: "Can comment",
  viewer: "Can view",
};

/**
 * Workspaces, in plain words: where each one lives, what the person may do in
 * it, and how many projects it holds. Ids and the raw access state are under
 * Advanced, for whoever is reading this to us.
 */
export function WorkspaceSettings({ online = false }: { online?: boolean } = {}) {
  const { account, failed, retry } = useFreshAccount();
  if (failed) return <AccountUnreadable onRetry={retry} />;
  if (!account) return <Skeleton label="Reading your workspaces" lines={3} />;

  return (
    <div className="dk-settings__section" data-testid="settings-workspaces">
      <h3 className="dk-settings__heading">Workspaces</h3>
      <p className="dk-settings__lead">A workspace holds projects, and a project holds decks.</p>
      <ul className="dk-settings__list dk-settings__list--rows dk-settings__wide">
        {account.workspaces.map((workspace) => {
          const note = ACCESS_WORDS[workspace.access];
          const count = workspace.projects.length;
          return (
            <li key={workspace.id} data-workspace-id={workspace.id}>
              <span>
                <strong>{workspace.name}</strong>
                {note ? (
                  <>
                    <br />
                    <span className="dk-muted">{note}</span>
                  </>
                ) : null}
              </span>
              <span className="dk-muted">
                {workspace.origin === "local" && !online ? "On this computer" : "Online"} ·{" "}
                {ROLE_WORDS[workspace.role] ?? workspace.role} · {count} project{count === 1 ? "" : "s"}
              </span>
            </li>
          );
        })}
      </ul>
      <SettingsAdvanced testId="settings-workspaces-advanced">
        <dl className="dk-settings__facts">
          {account.workspaces.map((workspace) => (
            <WorkspaceFacts key={workspace.id} workspace={workspace} />
          ))}
        </dl>
      </SettingsAdvanced>
    </div>
  );
}

function WorkspaceFacts({ workspace }: { workspace: AccountWorkspace }) {
  return (
    <>
      <dt>{workspace.name}</dt>
      <dd className="dk-settings__code">
        {workspace.id} · {workspace.origin} · {workspace.access}
        {workspace.confirmed_at ? ` · checked ${workspace.confirmed_at}` : ""}
      </dd>
    </>
  );
}

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Light or dark for the app around the slides. It used to be three radios in
 * the account menu; it is a setting, so it lives with the settings, and the
 * menu links here. "Match the system" is a real third answer, not a reset.
 */
export function AppearanceSettings() {
  const { preference, setPreference } = useChromeTheme();
  return (
    <div className="dk-settings__section" data-testid="settings-appearance">
      <h3 className="dk-settings__heading">Theme</h3>
      <Segmented
        label="Theme"
        className="dk-settings__choice"
        value={preference}
        onChange={setPreference}
        items={THEMES.map((theme) => ({ ...theme, "data-testid": `appearance-theme-${theme.value}` }))}
      />
      <p className="dk-settings__lead">
        This changes Deckastra around your slides. Your decks keep their own colours.
      </p>
    </div>
  );
}

/**
 * Languages and voice: the person's own lists, which follow them from deck to
 * deck. The same preferences the Languages and Narration panels read, so a
 * change here is what those panels show next. Absent where the client keeps no
 * preferences.
 */
export function LanguageVoiceSettings() {
  const client = useWorkspaceClient();
  const read = client.session.readPreference;
  const write = client.session.writePreference;
  const [glossary, setGlossary] = useState("");
  const [sayAs, setSayAs] = useState("");
  const [rate, setRate] = useState(1);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!read) return;
    let live = true;
    read
      .call(client.session, "translation")
      .then((value) => {
        const terms = (value as { glossary?: unknown } | undefined)?.glossary;
        if (live && Array.isArray(terms)) setGlossary(terms.filter((term) => typeof term === "string").join(", "));
      })
      .catch(() => {});
    read
      .call(client.session, "pronunciations")
      .then((value) => live && setSayAs(formatPronunciations(storedPronunciations(value))))
      .catch(() => {});
    read
      .call(client.session, "speech")
      .then((value) => {
        const stored = Number((value as { rate?: unknown } | undefined)?.rate);
        if (live && Number.isFinite(stored) && stored >= 0.5 && stored <= 2) setRate(stored);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, read]);

  if (!read || !write) return null;

  const save = (key: "translation" | "pronunciations" | "speech", value: unknown, what: string) => {
    setSaved(null);
    write
      .call(client.session, key, value)
      .then(() => setSaved(`${what} saved.`))
      .catch(() => setSaved(`${what} could not be saved. Try again.`));
  };

  return (
    <div className="dk-settings__section" data-testid="settings-languages">
      <h3 className="dk-settings__heading">Translation</h3>
      <label className="dk-field dk-settings__wide">
        <span className="dk-label">Never translate</span>
        <input
          className="dk-input"
          value={glossary}
          placeholder="Deckastra, Q3, OKR"
          onChange={(event) => setGlossary(event.target.value)}
          onBlur={() =>
            save(
              "translation",
              { glossary: glossary.split(",").map((term) => term.trim()).filter(Boolean).slice(0, 200) },
              "Words to keep",
            )
          }
          data-testid="settings-glossary"
        />
        <span className="dk-field__hint">Names and words kept as written in every language. Separate them with commas.</span>
      </label>
      <h3 className="dk-settings__heading">Voice</h3>
      <NumberField
        label="Speaking rate"
        value={rate}
        min={0.5}
        max={2}
        step={0.05}
        unit="×"
        onCommit={(next) => {
          const value = Math.round(next * 20) / 20;
          setRate(value);
          save("speech", { rate: value }, "Speaking rate");
        }}
        data-testid="settings-speech-rate"
      />
      <label className="dk-field dk-settings__wide">
        <span className="dk-label">Say names as</span>
        <textarea
          className="dk-input"
          rows={3}
          dir="auto"
          value={sayAs}
          placeholder={"Deckastra = Deck astra\nGCP = G C P"}
          onChange={(event) => setSayAs(event.target.value)}
          onBlur={() => save("pronunciations", { list: parsePronunciations(sayAs) }, "Pronunciations")}
          data-testid="settings-say-as"
        />
        <span className="dk-field__hint">
          One name per line. Voiced lines that say a changed name are voiced again the next time you press Voice.
        </span>
      </label>
      {saved ? (
        <p className="dk-muted" role="status">
          {saved}
        </p>
      ) : null}
    </div>
  );
}
