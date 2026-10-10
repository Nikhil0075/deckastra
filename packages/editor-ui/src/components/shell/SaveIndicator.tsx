import { useState } from "react";

import type { EditorApi } from "../../lib/useEditor";
import { Button } from "../../ui";

/**
 * Where the save queue stands, in the top bar.
 *
 * The wording is a contract as well as copy: the desktop acceptance harness
 * waits for "Saved" and "Save changes" in the page text, and the text is not
 * uppercased for that reason (`innerText` applies `text-transform`, so a
 * `Button`'s uppercase label would read "SAVE CHANGES" and the harness's
 * refusal check would silently never match). `.dk-save__action` undoes it.
 */
export function SaveIndicator({ editor }: { editor: EditorApi }) {
  const { save } = editor;
  const onRetry = () => void editor.saveNow();

  const status = (() => {
    switch (save.status) {
      case "saving":
        return <span className="dk-save">Saving…</span>;
      case "pending":
        return (
          <Button size="sm" variant="ghost" className="dk-save__action" onClick={onRetry}>
            Save changes
          </Button>
        );
      case "saved":
        return (
          <span className="dk-save">
            <span className="dk-save__mark" aria-hidden="true" />
            Saved
          </span>
        );
      case "updated":
        // Said here in two words; the way back is the banner under the bar
        // (ExternalChangeBanner), which has room for it at every window size.
        // In the bar, its Undo was cut off at 1366px beside a long title.
        return (
          <span className="dk-save dk-save--notice" role="status">
            Updated elsewhere
          </span>
        );
      case "conflict":
        return (
          <span className="dk-save dk-save--warning" title={save.message}>
            Local work retained — review conflict
          </span>
        );
      case "error":
        return (
          <Button size="sm" variant="ghost" className="dk-save__action dk-save--danger" onClick={onRetry} title={save.message}>
            Save failed — retry
          </Button>
        );
      default:
        return null;
    }
  })();

  return (
    // `data-save-status` is the machine-readable form, so a harness can wait for
    // a state without depending on wording.
    <span className="dk-save-slot" data-testid="save-status" data-save-status={save.status}>
      {status}
    </span>
  );
}

/**
 * A change arrived from elsewhere (an agent, another window), and here is the
 * way back. Said once, plainly, *and* offered an undo: announcing the change
 * and clearing local history left the person with a deck that moved under
 * them and nothing to press, because the toolbar's undo only knows edits made
 * here. A banner rather than a button in the bar, so it is never the thing a
 * narrow window cuts off (UI audit Unit 9).
 */
export function ExternalChangeBanner({ editor }: { editor: EditorApi }) {
  // Held here: the only thing that reads it is the sentence beside this button,
  // and a refusal has to appear where the person pressed.
  const [refusal, setRefusal] = useState<string | null>(null);
  if (editor.save.status !== "updated" || !editor.externalChange) return null;
  return (
    <div className="dk-banner dk-banner--notice dk-banner--actions" role="status" data-testid="external-change-banner">
      <span>This deck was changed outside this window.</span>
      <Button
        size="sm"
        variant="ghost"
        className="dk-save__action"
        title="Refused if your own later edits would be disturbed."
        onClick={() => {
          setRefusal(null);
          void editor.undoExternalChange().then((answer) => {
            if (!answer.ok) setRefusal(answer.message ?? "That change could not be undone.");
          });
        }}
        data-testid="undo-external-change"
      >
        Undo that change
      </Button>
      {refusal ? <span className="dk-save dk-save--warning">{refusal}</span> : null}
    </div>
  );
}
