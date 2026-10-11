import { useRef } from "react";

import type { EditorApi } from "../../lib/useEditor";
import { Button, Section } from "../../ui";
import { ThemeFile } from "../ThemePanel";
import { GenerateMedia } from "./GenerateMedia";

export interface ImportGeneratePanelProps {
  editor: EditorApi;
  presentationId: string;
  /** The current slide, which a picture is added to and a generation is for. */
  slideId?: string;
  onAddImage: (file: File) => void | Promise<void>;
  /** Open translation, which lives with the other languages in the Assistant. */
  onTranslate?: () => void;
}

/**
 * Import & generate (2026-10-12): everything that brings something into the
 * deck from outside it or has it made. Each part is the same component it is
 * elsewhere (the Add library's upload, its Generate section, the theme
 * gallery's Import tab), gathered where someone looking for "bring in" or
 * "make me" will find it, rather than a second implementation of any of them.
 */
export function ImportGeneratePanel({ editor, presentationId, slideId, onAddImage, onTranslate }: ImportGeneratePanelProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  return (
    <div className="dk-modepanel" data-testid="import-generate-panel">
      <Section title="Pictures and video" defaultOpen>
        <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()} data-testid="import-upload-image">
          Upload a picture
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          aria-label="Picture file"
          tabIndex={-1}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onAddImage(file);
          }}
        />
        <p className="dk-field__hint">PNG, JPEG, GIF, WebP or SVG, added to this slide. You can also paste a picture or drop one on the slide.</p>
      </Section>
      <Section title="Generate" defaultOpen>
        <GenerateMedia presentationId={presentationId} slideId={slideId} currentVersionId={editor.currentVersionId} saveNow={editor.saveNow} />
      </Section>
      <Section title="Theme from a file">
        <ThemeFile editor={editor} presentationId={presentationId} />
      </Section>
      {onTranslate ? (
        <Section title="Translate">
          <p className="dk-muted">Add a language and translate the deck. Each language is kept beside the original.</p>
          <Button size="sm" variant="secondary" icon="language" onClick={onTranslate} data-testid="import-translate">
            Open languages
          </Button>
        </Section>
      ) : null}
    </div>
  );
}
