import { useEffect, useState } from "react";
import { Button, Drawer } from "@deckastra/editor-ui/ui";

/**
 * A first look at what is here, said once (roadmap 08 §1.4: rewritten for what
 * is there rather than a list of what is not).
 *
 * Three facts someone needs before their first deck: where their work lives,
 * how to send a deck to someone, and where AI help is set up. The last two
 * point at the places that do it (the Share menu, Settings) rather than
 * explaining them here.
 *
 * Shown once per install. The flag is browser storage rather than the workspace
 * database: it is a fact about this window having been read to, not about the
 * user's documents, and losing it costs one extra notice.
 */

const SEEN = "deckastra.intro.v1";

export function FirstRunNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
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
    <Drawer open={open} onClose={dismiss} title="Welcome to Deckastra" width={460} data-testid="first-run">
      <div className="dk-intelligence">
        <p className="dk-muted">
          Your decks, their history and their pictures are kept on this computer, in this app&apos;s own folder.
        </p>
        <p className="dk-muted">
          To send a deck to someone, open <strong>Share</strong> and save it as a PDF or a PowerPoint file.
        </p>
        <p className="dk-muted">
          The <strong>Assistant</strong>, at the top of every deck, changes slides, writes alt text and narration, and plans motion. What
          it can do here, and what it sends, is in <strong>Settings</strong>. You can also let Claude Code or Codex
          work on your decks from Settings › Agents.
        </p>
        <div className="dk-intelligence__key">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              dismiss();
              onOpenSettings();
            }}
            data-testid="first-run-settings"
          >
            Open Settings
          </Button>
          <Button size="sm" variant="primary" onClick={dismiss} data-testid="first-run-dismiss">
            Start using Deckastra
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
