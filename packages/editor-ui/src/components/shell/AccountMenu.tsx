import type { SettingsSectionId } from "../SettingsShell";
import { CreditsMeter } from "../CreditsMeter";
import { Menu, type MenuItem } from "../../ui";
import { Icon } from "../../ui/icons";

/**
 * Who is signed in, at the end of both top bars (roadmap 08 §1.4, UI audit
 * Unit 8).
 *
 * The menu opens on an identity card: the avatar, the name and email, and the
 * account's credits where the service keeps any. Below it, Settings,
 * Appearance and Sign out. Light or dark used to be three radios here; it is a
 * setting, so it moved to Settings › Appearance and this links there.
 */
export interface AccountIdentity {
  name?: string | null;
  email?: string | null;
}

export interface AccountMenuProps {
  /** Absent when nobody is signed in (a desktop used without an account). */
  identity?: AccountIdentity | null;
  /** Opens Settings, at a section when one is named. */
  onOpenSettings?: (section?: SettingsSectionId) => void;
  onSignOut?: () => void;
}

/** "Nikhil Ranjan Murmu" → "NM"; "ann@example.com" → "A". */
export function initials(identity: AccountIdentity | null | undefined): string | null {
  const name = identity?.name?.trim();
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    const first = words[0]?.[0] ?? "";
    const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase() || null;
  }
  const email = identity?.email?.trim();
  return email ? email[0]!.toUpperCase() : null;
}

export function AccountMenu({ identity, onOpenSettings, onSignOut }: AccountMenuProps) {
  const letters = initials(identity);
  const who = identity?.email ?? identity?.name ?? null;
  const name = identity?.name?.trim() || null;
  const email = identity?.email?.trim() || null;

  const items: MenuItem[] = [
    ...(onOpenSettings
      ? [
          { id: "settings", label: "Settings…", icon: "settings" as const, onSelect: () => onOpenSettings() },
          { id: "appearance", label: "Appearance…", onSelect: () => onOpenSettings("appearance") },
        ]
      : []),
    ...(onSignOut ? [{ id: "sign-out", label: "Sign out", icon: "signOut" as const, onSelect: onSignOut }] : []),
  ];

  const card = (
    <div className="dk-account-card" data-testid="account-card">
      <span className="dk-account-card__avatar" aria-hidden="true">
        {letters ?? <Icon name="person" size={20} />}
      </span>
      <span className="dk-account-card__name">{name ?? email ?? "Not signed in"}</span>
      <span className="dk-account-card__detail">{name && email ? email : who ? "Signed in" : "Your decks are kept on this computer."}</span>
      {who ? (
        <span className="dk-account-card__credits">
          <CreditsMeter variant="inline" />
        </span>
      ) : null}
    </div>
  );

  return (
    <Menu
      label={who ? `Account: ${who}` : "Account"}
      align="end"
      header={card}
      trigger={(props) => (
        <button
          type="button"
          className="dk-avatar"
          aria-label={who ? `Account: ${who}` : "Account"}
          title={who ?? "Account"}
          data-testid="account-menu"
          {...props}
        >
          {letters ? <span aria-hidden="true">{letters}</span> : <Icon name="person" size={16} />}
        </button>
      )}
      items={items}
    />
  );
}
