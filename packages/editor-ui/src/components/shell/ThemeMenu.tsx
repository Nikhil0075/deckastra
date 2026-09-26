import { useChromeTheme, type ThemePreference } from "../../lib/chrome-theme";
import { IconButton, Menu } from "../../ui";

const CHOICES: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The chrome theme switch, for the top bars. A menu of three radios rather
 * than a toggle: "follow the operating system" is a real third answer, and a
 * two-state toggle would silently take it away the first time it was pressed.
 */
export function ThemeMenu() {
  const { preference, resolved, setPreference } = useChromeTheme();
  return (
    <Menu
      label="Appearance"
      align="end"
      trigger={(props) => (
        <IconButton
          icon="theme"
          label={`Appearance: ${preference === "system" ? `system (${resolved})` : resolved}`}
          size="sm"
          variant="secondary"
          data-testid="theme-menu"
          {...props}
        />
      )}
      items={CHOICES.map((choice) => ({
        id: choice.value,
        label: choice.label,
        checked: preference === choice.value,
        onSelect: () => setPreference(choice.value),
      }))}
    />
  );
}
