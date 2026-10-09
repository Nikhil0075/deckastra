import { useChromeTheme, type ThemePreference } from "../../lib/chrome-theme";
import { Menu, type MenuItem } from "../../ui";
import { Icon } from "../../ui/icons";

/**
 * Who is signed in, and the person's own settings (roadmap 08 §1.4, concept
 * 08-home.png): the avatar at the end of both top bars.
 *
 * It took over the bar's contrast button, so light or dark lives here, as the
 * same three radios ("follow the operating system" is a real third answer).
 * Settings and signing out are offered when the host can do them.
 */
export interface AccountIdentity {
  name?: string | null;
  email?: string | null;
}

export interface AccountMenuProps {
  /** Absent when nobody is signed in (a desktop used without an account). */
  identity?: AccountIdentity | null;
  onOpenSettings?: () => void;
  onSignOut?: () => void;
}

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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
  const { preference, setPreference } = useChromeTheme();
  const letters = initials(identity);
  const who = identity?.email ?? identity?.name ?? null;

  const items: MenuItem[] = [
    ...THEMES.map((theme) => ({
      id: `theme-${theme.value}`,
      label: theme.label,
      checked: preference === theme.value,
      onSelect: () => setPreference(theme.value),
    })),
    ...(onOpenSettings ? [{ id: "settings", label: "Settings…", icon: "settings" as const, onSelect: onOpenSettings }] : []),
    ...(onSignOut ? [{ id: "sign-out", label: "Sign out", icon: "signOut" as const, onSelect: onSignOut }] : []),
  ];

  return (
    <Menu
      label={who ? `Account: ${who}` : "Account and appearance"}
      align="end"
      trigger={(props) => (
        <button
          type="button"
          className="dk-avatar"
          aria-label={who ? `Account: ${who}` : "Account and appearance"}
          title={who ?? "Account and appearance"}
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
