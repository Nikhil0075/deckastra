import type { ReactNode } from "react";

import { EDITOR_MODES, type EditorMode } from "../../lib/editor-layout";
import type { EditorApi } from "../../lib/useEditor";
import { Button, IconButton, Popover, Segmented } from "../../ui";
import { ThemeMenu } from "./ThemeMenu";
import { ExportPanel } from "../ExportPanel";
import { SharePanel } from "../SharePanel";
import { SaveIndicator } from "./SaveIndicator";

export interface AppBarProps {
  editor: EditorApi;
  presentationId: string;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  onPresent: () => void;
  onExit?: () => void;
  /** Host-owned controls placed before Share (the desktop's agent-access switch). */
  extras?: ReactNode;
}

/**
 * The top bar (Figma: MAIN SCREEN). Left: where you are and whether it is
 * saved. Centre: the mode. Right: what leaves the editor — share, export,
 * present. Present is the one blue button on the bar, because it is the one
 * action the whole editor exists to prepare for.
 */
export function AppBar({ editor, presentationId, mode, onMode, onPresent, onExit, extras }: AppBarProps) {
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
            badge: entry.value === "code" ? <span className="dk-appbar__hint">read-only</span> : undefined,
          }))}
        />
      </div>

      <div className="dk-appbar__end">
        {extras}
        <ThemeMenu />
        <Popover
          label="Share"
          align="end"
          className="dk-appbar__popover"
          trigger={(props) => (
            <Button size="sm" variant="ghost" icon="share" data-testid="open-share" {...props}>
              Share
            </Button>
          )}
        >
          <SharePanel presentationId={presentationId} />
        </Popover>
        {/* Kept mounted while closed: the panel polls a running export, and
            closing the popover to keep editing must not forget the job. */}
        <Popover
          label="Export"
          align="end"
          keepMounted
          className="dk-appbar__popover"
          data-testid="export-popover"
          trigger={(props) => (
            <Button size="sm" variant="ghost" icon="download" data-testid="open-export" {...props}>
              Export
            </Button>
          )}
        >
          <ExportPanel presentationId={presentationId} editor={editor} />
        </Popover>
        <Button size="sm" variant="primary" icon="play" onClick={onPresent} data-testid="present">
          Present
        </Button>
      </div>
    </header>
  );
}
