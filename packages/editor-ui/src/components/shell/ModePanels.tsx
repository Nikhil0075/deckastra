import { useState } from "react";

import type { EditorApi } from "../../lib/useEditor";
import { Section, StatusChip } from "../../ui";
import { AskPanel } from "../AskPanel";
import { AssistantPanel } from "../AssistantPanel";
import { CriticIssues } from "../CriticIssues";
import { LanguagesPanel } from "../LanguagesPanel";
import { ProposalsPanel } from "../ProposalsPanel";
import { SourcesPanel } from "../SourcesPanel";

/**
 * AI mode's right panel (Figma frame "previewing a proposal as an image").
 *
 * What agents propose comes first, each as Before and After pictures of the
 * deck on screen; then the place to ask for a change; then the deck's languages
 * (integration plan 01 §3.2), whose translations arrive as proposals in the
 * same list; then what the Critic left open and where this slide's claims came
 * from. The story checkpoint is not here: it belongs to a deck being generated,
 * before there is a deck to open, so it lives with New deck.
 */
export function AiPanel({
  editor,
  presentationId,
  resolveAssetUrl,
  languagesOpen,
  onLanguagesOpen,
}: {
  editor: EditorApi;
  presentationId: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Controlled by the shell, so "Add or manage languages…" in the bar can open it. */
  languagesOpen?: boolean;
  onLanguagesOpen?: (open: boolean) => void;
}) {
  const slide = editor.document.slides[editor.slideIndex];
  const [pending, setPending] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const issues = editor.document.extensions?.["deckastra.unresolvedIssues"];
  const languageCount = 1 + Object.keys(editor.sourceDocument.locales ?? {}).length;
  return (
    <div className="dk-modepanel">
      <Section
        title="Pending changes"
        defaultOpen
        meta={pending ? <StatusChip tone="waiting">{pending} waiting</StatusChip> : undefined}
        data-testid="ai-pending"
      >
        <ProposalsPanel
          presentationId={presentationId}
          // The saved deck, and the language on screen to draw it in: a
          // translation's pictures are drawn in the language it writes.
          document={editor.sourceDocument}
          locale={editor.locale}
          refreshToken={refreshToken}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
          currentVersionId={editor.currentVersionId}
          onCount={setPending}
        />
      </Section>
      <Section title="Assistant" defaultOpen>
        <AssistantPanel editor={editor} presentationId={presentationId} onCompleted={() => setRefreshToken((count) => count + 1)} />
      </Section>
      <Section title="Ask" defaultOpen>
        <AskPanel
          presentationId={presentationId}
          selectedIds={editor.selection.selectedIds}
          slideId={slide?.id}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
          currentVersionId={editor.currentVersionId}
        />
      </Section>
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
      <Section title="Critic issues">
        <CriticIssues value={issues} slideId={slide?.id} />
        {issues ? null : <p className="dk-muted">No open review issues on this deck.</p>}
      </Section>
      <Section title="Sources" meta={slide ? `Slide ${editor.slideIndex + 1}` : undefined}>
        {slide ? <SourcesPanel key={slide.id} presentationId={presentationId} slideId={slide.id} /> : null}
      </Section>
    </div>
  );
}
