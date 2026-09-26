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
  const undoExternal = editor.externalChange ? editor.undoExternalChange : undefined;
  // Held here rather than threaded through the shell: the only thing that reads
  // it is the sentence beside this button, and a refusal has to appear where the
  // user pressed.
  const [refusal, setRefusal] = useState<string | null>(null);

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
        // Said once, plainly, *and* offered a way back. Announcing the change and
        // clearing local history left the user with a deck that moved under them
        // and nothing to press: the toolbar's undo only knows about edits made
        // here, and this one was made somewhere else.
        return (
          <span className="dk-save dk-save--notice" role="status">
            Updated elsewhere
            {undoExternal ? (
              <Button
                size="sm"
                variant="ghost"
                className="dk-save__action"
                title="Undo the change that arrived from elsewhere. Refused if your own later edits would be disturbed."
                onClick={() => {
                  setRefusal(null);
                  void undoExternal().then((answer) => {
                    if (!answer.ok) setRefusal(answer.message ?? "That change could not be undone.");
                  });
                }}
              >
                Undo that change
              </Button>
            ) : null}
            {refusal ? (
              <span className="dk-save dk-save--warning" role="status">
                {refusal}
              </span>
            ) : null}
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
