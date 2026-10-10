import type { ReactNode } from "react";

import { EDITOR_MODES, type EditorMode } from "../../lib/editor-layout";
import type { EditorApi } from "../../lib/useEditor";
import { Button, IconButton, Menu, Popover, Segmented, type MenuItem } from "../../ui";
import { AccountMenu, type AccountMenuProps } from "./AccountMenu";
import { ExportPanel } from "../ExportPanel";
import { SharePanel } from "../SharePanel";
import { SaveIndicator } from "./SaveIndicator";
import { LanguageMenu } from "./LanguageMenu";

export interface AppBarProps {
  editor: EditorApi;
  presentationId: string;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  onPresent: () => void;
  onExit?: () => void;
  /** Host-owned controls placed before Share (the desktop's agent-access switch). */
  extras?: ReactNode;
  /**
   * The avatar menu at the end of the bar: appearance, Settings, signing out
   * (roadmap 08 §1.4). Panels are in the View menu and the command palette,
   * not the bar.
   */
  account?: AccountMenuProps;
  /**
   * Open version history. In the bar rather than the Design panel, because
   * going back to an earlier deck is not a design choice (design review,
   * 2026-09-26).
   */
  onHistory?: () => void;
  /** Open the Languages panel (integration plan 01 §3.2). Absent: no switcher. */
  onManageLanguages?: () => void;
  /** Open or put away the assistant (roadmap 08 §1.2 rule 2). Absent: no button. */
  onAssistant?: () => void;
  assistantOpen?: boolean;
  /**
   * Focus on the slide, and the Layout menu of panels and their shortcuts (UI
   * audit unit 3). Absent: neither is shown.
   */
  layout?: { focused: boolean; onFocus: () => void; items: readonly MenuItem[] };
}

/**
 * The top bar (Figma: MAIN SCREEN). Left: where you are and whether it is
 * saved. Centre: the mode. Right: what leaves the editor — share, export,
 * present. Present is the one blue button on the bar, because it is the one
 * action the whole editor exists to prepare for.
 */
export function AppBar({ editor, presentationId, mode, onMode, onPresent, onExit, extras, account, onHistory, onManageLanguages, onAssistant, assistantOpen, layout }: AppBarProps) {
  const title = editor.document.metadata.title || "Untitled deck";

  return (
    <header className="dk-appbar" data-region="app bar">
      <div className="dk-appbar__start">
        {onExit ? (
          // Back to the deck list. The shell decides what that means; the
          // editor waits for its save queue to empty before it lets go.
          <IconButton icon="grid" label="All decks" size="sm" variant="secondary" onClick={onExit} data-testid="open-deck-list" />
        ) : (
          <span className="dk-brand" aria-hidden="true" />
        )}
        <h1 className="dk-appbar__title" title={title}>
          <span className="dk-appbar__product">Deckastra</span>
          <span className="dk-appbar__sep" aria-hidden="true">/</span>
          <span className="dk-appbar__deck">{title}</span>
        </h1>
        <span className="dk-appbar__group">
          <IconButton
            icon="undo"
            label="Undo"
            shortcut="Ctrl+Z"
            size="sm"
            disabled={!editor.canUndo}
            onClick={editor.undo}
            data-testid="undo"
          />
          <IconButton
            icon="redo"
            label="Redo"
            shortcut="Ctrl+Shift+Z"
            size="sm"
            disabled={!editor.canRedo}
            onClick={editor.redo}
            data-testid="redo"
          />
        </span>
        <SaveIndicator editor={editor} />
      </div>

      <div className="dk-appbar__center">
        <Segmented
          label="Editor mode"
          size="sm"
          value={mode}
          onChange={onMode}
          items={EDITOR_MODES.map((entry) => ({
            value: entry.value,
            label: entry.label,
            "data-testid": `mode-${entry.value}`,
          }))}
        />
      </div>

      <div className="dk-appbar__end">
        {onAssistant ? (
          // The one way to the assistant from the bar, beside any mode. Its
          // words stay at every width: it is the product's AI entry point.
          <Button
            size="sm"
            variant="secondary"
            icon="ai"
            aria-pressed={Boolean(assistantOpen)}
            title="Assistant (Ctrl+K)"
            onClick={onAssistant}
            data-testid="open-assistant"
            className="dk-appbar__assistant"
          >
            Assistant
          </Button>
        ) : null}
        {extras}
        {onManageLanguages ? <LanguageMenu editor={editor} onManage={onManageLanguages} /> : null}
        {layout ? (
          <>
            {/* Focus mode had only a shortcut, so nobody found it. */}
            <IconButton
              icon="fit"
              label={layout.focused ? "Show the panels again (Ctrl+.)" : "Focus on the slide (Ctrl+.)"}
              size="sm"
              variant="secondary"
              aria-pressed={layout.focused}
              onClick={layout.onFocus}
              data-testid="focus-toggle"
            />
            <Menu
              label="Layout"
              align="end"
              items={layout.items}
              trigger={(props) => <IconButton icon="grid" label="Layout" size="sm" variant="secondary" data-testid="layout-menu" {...props} />}
            />
          </>
        ) : null}
        {onHistory ? (
          // An icon, named in its tooltip and accessible name: a labelled button
          // here pushed the bar's end group across the mode switch.
          <IconButton icon="history" label="Version history" size="sm" variant="secondary" onClick={onHistory} data-testid="open-history" />
        ) : null}
        {/* One Share menu (roadmap 08 §1.4): the file to send, then the link.
            Kept mounted while closed: the export section polls a running job,
            and closing the menu to keep editing must not forget it. */}
        <Popover
          label="Share"
          align="end"
          keepMounted
          className="dk-appbar__popover dk-sharemenu"
          data-testid="export-popover"
          trigger={(props) => (
            <Button size="sm" variant="ghost" icon="share" title="Share or export" data-testid="open-share" {...props}>
              Share
            </Button>
          )}
        >
          <ExportPanel presentationId={presentationId} editor={editor} />
          <SharePanel presentationId={presentationId} />
        </Popover>
        <Button size="sm" variant="primary" icon="play" onClick={onPresent} data-testid="present">
          Present
        </Button>
        <AccountMenu {...account} />
      </div>
    </header>
  );
}
