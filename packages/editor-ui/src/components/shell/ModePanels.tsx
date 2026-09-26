import { useMemo, useState } from "react";
import { canonicalize } from "@deckastra/presentation-schema";
import { resolveElementById } from "@deckastra/presentation-core";

import type { EditorApi } from "../../lib/useEditor";
import { Button, Section, Segmented, StatusChip } from "../../ui";
import { AskPanel } from "../AskPanel";
import { CriticIssues } from "../CriticIssues";
import { ProposalsPanel } from "../ProposalsPanel";
import { SourcesPanel } from "../SourcesPanel";

/**
 * AI mode's right panel (Figma frame "previewing a proposal as an image").
 *
 * What agents propose comes first, each as Before and After pictures of the
 * deck on screen; then the place to ask for a change; then what the Critic left
 * open and where this slide's claims came from. The story checkpoint is not
 * here: it belongs to a deck being generated, before there is a deck to open,
 * so it lives with New deck.
 */
export function AiPanel({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const slide = editor.document.slides[editor.slideIndex];
  const [pending, setPending] = useState(0);
  const issues = editor.document.extensions?.["deckastra.unresolvedIssues"];
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
          document={editor.document}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
          currentVersionId={editor.currentVersionId}
          onCount={setPending}
        />
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

/**
 * Code mode: the canonical JSON of the selection, or of the slide. Read-only by
 * design (doc 01 §6.4) — an editable JSON view would be a second way to mutate
 * the document, bypassing validation and history. Copying it is the one thing
 * it offers, which is what someone reading JSON in an editor usually wants to
 * do with it (a bug report, a fixture, a diff).
 */
export function CodePanel({ editor }: { editor: EditorApi }) {
  const { document: doc, slideIndex, selection } = editor;
  const slide = doc.slides[slideIndex];
  const primary = selection.primaryId ? resolveElementById(doc, selection.primaryId)?.element : undefined;
  // Follows the selection by default; "Slide" pins the whole slide while an
  // object stays selected. Session state only, like the mode itself.
  const [scope, setScope] = useState<"selection" | "slide">("selection");
  const showElement = primary !== undefined && scope === "selection";
  const subject = showElement ? primary : slide;
  const json = useMemo(() => (subject ? JSON.stringify(canonicalize(subject), null, 2) : ""), [subject]);
  const [copied, setCopied] = useState<{ json: string; ok: boolean } | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied({ json, ok: true });
    } catch {
      // Refused (no permission, no focus): say so rather than look like it worked.
      setCopied({ json, ok: false });
    }
  };
  // A confirmation belongs to the text it copied; a different subject clears it.
  const status = copied && copied.json === json ? (copied.ok ? "Copied" : "Could not copy") : null;
  const lines = json ? json.split("\n").length : 0;

  return (
    <div className="dk-modepanel dk-code">
      <div className="dk-code__head">
        <span className="dk-label">{showElement ? `Element · ${primary.type}` : `Slide ${slideIndex + 1}`}</span>
        <span className="dk-muted">Read-only</span>
      </div>
      <div className="dk-code__tools">
        {primary ? (
          <Segmented
            label="Show"
            size="sm"
            value={scope}
            onChange={setScope}
            items={[
              { value: "selection", label: "Selection" },
              { value: "slide", label: "Slide" },
            ]}
          />
        ) : null}
        <span className="dk-muted dk-code__count">{lines} lines</span>
        <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy()} disabled={!json} data-testid="code-copy">
          Copy
        </Button>
        <span className="dk-muted" role="status" aria-live="polite">
          {status}
        </span>
      </div>
      <pre className="dk-code__body dk-scroll" tabIndex={0} aria-label="Canonical JSON" data-testid="code-json">
        {json}
      </pre>
    </div>
  );
}
