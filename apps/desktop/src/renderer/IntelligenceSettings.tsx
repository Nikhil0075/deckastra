import { useEffect, useId, useState } from "react";
import { Button, Drawer, Section, StatusChip } from "@deckastra/editor-ui/ui";
import { generationRoute } from "@deckastra/editor-ui";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { GenerationStatus } from "@deckastra/workspace-contracts";

import type { AgentAccess, CloudKeyState, DesktopBridge } from "../shared/ipc";
import { AgentAccessControl } from "./AgentAccessControl";

/**
 * Where decks are written, and how to change it (final package review, item 19).
 *
 * An installed app must not ask anyone to set an environment variable to find
 * out what happens to their words. This says which route is in use, what leaves
 * the machine on it, and what the alternatives are — and it is the only place
 * that decides. Nothing here generates anything.
 *
 * Read fresh each time it opens: the answer depends on the service's
 * configuration, which a restart can change underneath a cached account.
 */
export function IntelligenceSettings({
  open,
  onClose,
  access,
  onAgentAccessChange,
  bridge,
}: {
  open: boolean;
  onClose: () => void;
  access: AgentAccess | null;
  onAgentAccessChange: (allow: boolean) => void;
  bridge: DesktopBridge;
}) {
  const client = useWorkspaceClient();
  const keyFieldId = useId();
  const [cloud, setCloud] = useState<CloudKeyState | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [status, setStatus] = useState<GenerationStatus | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client.session
      .account({ fresh: true })
      .then((account) => {
        if (cancelled) return;
        setStatus(account.capabilities.generation);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "The service did not answer.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, open]);

  useEffect(() => {
    if (!open) return;
    void bridge.cloudKey().then(setCloud);
  }, [bridge, open]);

  /** Store a key, or remove the stored one, and read the new route back. */
  const changeKey = async (key: string | null) => {
    setBusy(true);
    setKeyError(null);
    try {
      setCloud(await bridge.setCloudKey({ key }));
      setDraftKey("");
      // The service restarted with the change, so what it will do is different now.
      setStatus((await client.session.account({ fresh: true })).capabilities.generation);
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : "That key could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const route = generationRoute(status);

  return (
    <Drawer open={open} onClose={onClose} title="Intelligence" width={460} data-testid="intelligence-drawer">
      <div className="dk-intelligence">
        <Section title="Writing a deck" defaultOpen>
          {error ? (
            <p className="dk-generate__error" role="alert">
              {error}
            </p>
          ) : route ? (
            <div className="dk-generate__route" data-testid="intelligence-route">
              <StatusChip tone={route.tone}>{route.title}</StatusChip>
              <p className="dk-muted">{route.detail}</p>
            </div>
          ) : (
            <p className="dk-muted">Reading how this install is set up…</p>
          )}
        </Section>

        <Section title="Cloud model (Anthropic)" defaultOpen>
          {/* The one route that sends anything anywhere, so the consent is
              here, beside the field, rather than in a document nobody opens. */}
          <p className="dk-muted">
            With your own Anthropic API key, Deckastra can write decks for you. Your brief, and any repositories you
            choose to ground a deck in, are sent to Anthropic. Nothing is sent until a key is saved here and you press
            Generate. The key is encrypted by Windows for your account and never leaves this computer.
          </p>
          {cloud?.storable === false ? (
            <p className="dk-generate__error" role="alert">
              This computer cannot store a key securely, so Deckastra will not store one at all. Use an AI agent instead.
            </p>
          ) : cloud?.set ? (
            <div className="dk-intelligence__key" data-testid="cloud-key-set">
              <StatusChip tone="neutral">Key saved</StatusChip>
              <span className="dk-muted">
                {cloud.updatedAt ? `Saved ${new Date(cloud.updatedAt).toLocaleDateString()}` : null}
              </span>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void changeKey(null)} data-testid="cloud-key-remove">
                Remove key
              </Button>
            </div>
          ) : (
            <div className="dk-intelligence__key">
              <label className="dk-label" htmlFor={keyFieldId}>
                Anthropic API key
              </label>
              <input
                id={keyFieldId}
                className="dk-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                value={draftKey}
                onChange={(event) => setDraftKey(event.target.value)}
                data-testid="cloud-key-input"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !draftKey.trim()}
                onClick={() => void changeKey(draftKey)}
                data-testid="cloud-key-save"
              >
                Save key
              </Button>
            </div>
          )}
          {keyError ? (
            <p className="dk-generate__error" role="alert" data-testid="cloud-key-error">
              {keyError}
            </p>
          ) : null}
        </Section>

        <Section title="AI agents" defaultOpen>
          {/* The route this release ships with, and the one that needs no key:
              the person's own Claude Code or Codex drives the app over MCP. */}
          <p className="dk-muted">
            Claude Code and Codex can write and change decks here, using the same commands you have. They propose;
            anything destructive waits for you. Nothing is sent anywhere by this app — the agent runs where you run it.
          </p>
          <AgentAccessControl access={access} onChange={onAgentAccessChange} />
        </Section>

        <Section title="What this release does not include" defaultOpen>
          <p className="dk-muted">
            Decks stay on this computer: there is no cloud workspace, no sharing and no sync in this release. Models
            that run on your own machine are not included either. A cloud key is used only to write decks you ask for.
          </p>
        </Section>

        <div className="dk-intelligence__close">
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
