import { useEffect, useState } from "react";
import { Button, Drawer } from "@deckastra/editor-ui/ui";

/**
 * What this release is, said once, before anyone finds out by looking for
 * something that is not there (final package review: the scope exclusions).
 *
 * The 0.9 beta is local-only. Decks live on this computer, there is no cloud
 * workspace, no sharing, no sync and no model inside the app. Every one of
 * those is a thing a presentation tool usually has, so the honest place to say
 * it is the first launch — not a support answer after someone has spent an
 * afternoon looking for the share button.
 *
 * Shown once per install. The flag is browser storage rather than the workspace
 * database: it is a fact about this window having been read to, not about the
 * user's documents, and losing it costs one extra notice.
 */

const SEEN = "deckastra.intro.v1";

export function FirstRunNotice({ onOpenIntelligence }: { onOpenIntelligence: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN)) setOpen(true);
    } catch {
      // No storage, no notice. It is a greeting, not a gate.
    }
  }, []);

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN, new Date().toISOString());
    } catch {
      /* As above. */
    }
  };

  return (
    <Drawer open={open} onClose={dismiss} title="Deckastra 0.9 beta" width={460} data-testid="first-run">
      <div className="dk-intelligence">
        <p className="dk-muted">
          Everything here stays on this computer: your decks, their history and their images live in this app's own
          folder. Nothing is uploaded.
        </p>
        <p className="dk-muted">
          <strong>Not in this release:</strong> shared cloud workspaces, links that let other people open a deck,
          syncing between computers, opening or saving <code>.mydeck</code> files, and models that run on your own
          machine. To share a deck, export it as a PDF or a PowerPoint file.
        </p>
        <p className="dk-muted">
          To have decks written for you, open <strong>Intelligence</strong>: add your own Anthropic API key, or let
          Claude Code or Codex drive the app.
        </p>
        <div className="dk-intelligence__key">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              dismiss();
              onOpenIntelligence();
            }}
            data-testid="first-run-intelligence"
          >
            Open Intelligence
          </Button>
          <Button size="sm" variant="primary" onClick={dismiss} data-testid="first-run-dismiss">
            Start using Deckastra
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
