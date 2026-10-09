import { useRef, useState } from "react";

import type { EditorApi } from "../lib/useEditor";
import { Button, IconButton, Section, StatusChip } from "../ui";
import { CreditsMeter } from "./CreditsMeter";
import { LanguagesPanel } from "./LanguagesPanel";
import { ProposalsPanel } from "./ProposalsPanel";

export interface AssistantPanelProps {
  editor: EditorApi;
  presentationId: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Controlled by the shell, so the bar's language menu can open it. */
  languagesOpen?: boolean;
  onLanguagesOpen?: (open: boolean) => void;
  onVoiceOpen?: () => void;
  onMediaOpen?: () => void;
  onClose?: () => void;
}

/**
 * The small paid-services assistant from plan 09.
 *
 * Authoring prompts belong to the person's connected coding agent. This panel
 * only gathers the product surfaces that still need Deckastra's engine or
 * services: proposals, translation, voice, and media. Tidy remains in Design
 * Check and motion remains in Motion mode.
 */
export function AssistantPanel({
  editor,
  presentationId,
  resolveAssetUrl,
  languagesOpen,
  onLanguagesOpen,
  onVoiceOpen,
  onMediaOpen,
  onClose,
}: AssistantPanelProps) {
  const [pending, setPending] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const languages = useRef<HTMLDivElement | null>(null);
  const languageCount = 1 + Object.keys(editor.sourceDocument.locales ?? {}).length;

  return (
    <div className="dk-modepanel dk-assistant" data-testid="assistant-panel">
      <header className="dk-assistant__head">
        <h2 className="dk-assistant__title">Assistant</h2>
        <CreditsMeter refreshToken={refreshToken} />
        {onClose ? <IconButton icon="close" label="Close the assistant" size="sm" onClick={onClose} data-testid="close-assistant" /> : null}
      </header>

      <p className="dk-muted dk-assistant__intro">
        Build and revise the deck with your connected agent. Deckastra handles approvals, language, voice, and media here.
      </p>

      <Section
        title="Waiting for you"
        defaultOpen
        meta={pending ? <StatusChip tone="waiting">{pending} waiting</StatusChip> : undefined}
        data-testid="ai-pending"
      >
        <ProposalsPanel
          presentationId={presentationId}
          document={editor.sourceDocument}
          locale={editor.locale}
          refreshToken={refreshToken}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
          currentVersionId={editor.currentVersionId}
          onCount={setPending}
        />
      </Section>

      <div ref={languages}>
        <Section
          title="Languages"
          meta={`${languageCount} language${languageCount === 1 ? "" : "s"}`}
          {...(languagesOpen === undefined ? {} : { open: languagesOpen, onOpenChange: onLanguagesOpen })}
          data-testid="ai-languages"
        >
          <LanguagesPanel
            editor={editor}
            presentationId={presentationId}
            resolveAssetUrl={resolveAssetUrl}
            onProposed={() => setRefreshToken((count) => count + 1)}
          />
        </Section>
      </div>

      <Section title="Voice" data-testid="ai-voice">
        <p className="dk-muted">Write narration by click step, record takes, or voice the lines that are due.</p>
        {onVoiceOpen ? (
          <Button size="sm" variant="secondary" onClick={onVoiceOpen} data-testid="assistant-open-voice">
            Open voice tools
          </Button>
        ) : null}
      </Section>

      <Section title="Media" data-testid="ai-media">
        <p className="dk-muted">Add images, video, and audio from the deck's media library.</p>
        {onMediaOpen ? (
          <Button size="sm" variant="secondary" onClick={onMediaOpen} data-testid="assistant-open-media">
            Open media library
          </Button>
        ) : null}
      </Section>
    </div>
  );
}
