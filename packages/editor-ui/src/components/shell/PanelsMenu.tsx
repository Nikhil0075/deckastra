import { ALL_VISIBLE, PANELS, isFocused, toggleFocus, togglePanel, type PanelVisibility } from "../../lib/panels";
import { IconButton, Menu } from "../../ui";

/**
 * Show or hide the parts of the editor around the slide (lib/panels.ts).
 *
 * Checkbox items, not radios: each panel is on or off by itself. "Focus on the
 * slide" and "Show everything" are the two ways back that do not depend on
 * remembering which panel was closed.
 */
export function PanelsMenu({
  visibility,
  onChange,
}: {
  visibility: PanelVisibility;
  onChange: (next: PanelVisibility) => void;
}) {
  const everything = PANELS.every(({ name }) => visibility[name]);
  const focused = isFocused(visibility);
  return (
    <Menu
      label="Panels"
      align="end"
      trigger={(props) => (
        <IconButton
          icon={everything ? "eye" : "eyeOff"}
          label={everything ? "Panels" : "Panels: some hidden"}
          size="sm"
          variant="secondary"
          data-testid="panels-menu"
          {...props}
        />
      )}
      items={[
        ...PANELS.map(({ name, label, shortcut }) => ({
          id: `panel-${name}`,
          label,
          kind: "checkbox" as const,
          checked: visibility[name],
          shortcut,
          onSelect: () => onChange(togglePanel(visibility, name)),
        })),
        {
          id: "panels-focus",
          label: focused ? "Leave focus mode" : "Focus on the slide",
          shortcut: "Ctrl+.",
          onSelect: () => onChange(toggleFocus(visibility)),
        },
        {
          id: "panels-all",
          label: "Show everything",
          disabled: everything,
          onSelect: () => onChange({ ...ALL_VISIBLE }),
        },
      ]}
    />
  );
}
