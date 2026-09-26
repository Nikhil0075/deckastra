/**
 * The Bauhaus UI primitives the editor chrome is built from (plan Phase 0).
 *
 * Exported as `@deckastra/editor-ui/ui`, apart from the main entry point: a
 * host that puts its own control in the editor's top bar (the desktop's
 * agent-access switch, through `EditorShell`'s `barExtras`) has to be able to
 * draw it in the same hand, or the bar stops looking like one bar.
 *
 * Styles live in `src/styles/components.css` under the `dk-` prefix and read
 * only `--dk-*` tokens from `src/styles/tokens.css`.
 */
export { Button, IconButton } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps } from "./Button";
export { Tooltip, TOOLTIP_DELAY_MS } from "./Tooltip";
export { Label, TextField, NumberField } from "./fields";
export type { TextFieldProps, NumberFieldProps } from "./fields";
export { Menu } from "./Menu";
export type { MenuItem, MenuProps, MenuTriggerProps } from "./Menu";
export { Select } from "./Select";
export type { SelectOption, SelectProps } from "./Select";
export { Segmented, Tabs, Section } from "./choice";
export type { ChoiceItem, SegmentedProps, TabItem, TabsProps, SectionProps } from "./choice";
export { StatusChip, StatusDot, TokenChip, Kbd, AccentRule } from "./chips";
export type { StatusTone, StatusChipProps } from "./chips";
export { Popover, Drawer, ScrollArea } from "./overlays";
export type { PopoverProps, PopoverTriggerProps, DrawerProps, ScrollAreaProps } from "./overlays";
export { Icon, ICON_NAMES } from "./icons";
export type { IconName, IconProps } from "./icons";
export { cx } from "./cx";
