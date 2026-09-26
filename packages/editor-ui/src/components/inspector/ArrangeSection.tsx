import { useState } from "react";

import { alignOperations, distributeOperations, type AlignEdge, type Boxed } from "../../lib/align";
import type { EditorApi } from "../../lib/useEditor";
import { Button, Section } from "../../ui";
import { Hint } from "./controls";

/**
 * Align and distribute (manual-authoring review MA-16). The rules are in
 * `lib/align.ts`; this says them where the buttons are, because "align left"
 * means nothing until you know *to what*.
 */

const ALIGN: { edge: AlignEdge; label: string }[] = [
  { edge: "left", label: "Left" },
  { edge: "centerX", label: "Centre" },
  { edge: "right", label: "Right" },
  { edge: "top", label: "Top" },
  { edge: "centerY", label: "Middle" },
  { edge: "bottom", label: "Bottom" },
];

export function ArrangeSection({ editor }: { editor: EditorApi }) {
  const [message, setMessage] = useState<string | undefined>();
  const { selection, document } = editor;
  const count = selection.selectedIds.length;
  if (count === 0) return null;

  const selected: Boxed[] = selection.selectedIds.flatMap((id) => {
    const node = editor.nodes.find((candidate) => candidate.id === id);
    return node ? [{ id, bounds: node.bounds }] : [];
  });
  const relative = count >= 2 ? "the selection" : "the slide";

  const report = (locked: string[]) =>
    setMessage(locked.length > 0 ? `${locked.length} locked object${locked.length === 1 ? " stayed" : "s stayed"} where ${locked.length === 1 ? "it was" : "they were"}.` : undefined);

  return (
    <Section title="Arrange" defaultOpen={count >= 2}>
      <span className="dk-label">Align to {relative}</span>
      <div className="dk-button-grid" data-testid="align-buttons">
        {ALIGN.map(({ edge, label }) => (
          <Button
            key={edge}
            size="sm"
            variant="ghost"
            data-align={edge}
            onClick={() => {
              const result = alignOperations(document, selected, edge, document.viewport);
              report(result.locked);
              if (result.operations.length > 0) editor.apply(result.operations, { label: `Align ${label.toLowerCase()}` });
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {count >= 3 ? (
        <>
          <span className="dk-label">Space evenly</span>
          <div className="dk-button-grid">
            {(["x", "y"] as const).map((axis) => (
              <Button
                key={axis}
                size="sm"
                variant="ghost"
                data-distribute={axis}
                onClick={() => {
                  const result = distributeOperations(document, selected, axis);
                  if ("refusal" in result) {
                    setMessage(result.refusal);
                    return;
                  }
                  report(result.locked);
                  if (result.operations.length > 0) {
                    editor.apply(result.operations, { label: axis === "x" ? "Space evenly across" : "Space evenly down" });
                  }
                }}
              >
                {axis === "x" ? "Across" : "Down"}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      <Hint>
        {count >= 2
          ? "Objects line up with the edges of everything selected. Locked objects stay put and are lined up against."
          : "With one object selected it lines up with the slide. Select more to line them up with each other."}
      </Hint>
      {message ? (
        <p className="dk-field__hint" role="status">
          {message}
        </p>
      ) : null}
    </Section>
  );
}
