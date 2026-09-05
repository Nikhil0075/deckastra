"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  newId,
  textContent,
  walkElements,
  type PresentationElement,
} from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";
import {
  addElement,
  cloneSlide,
  createSlide,
  groupElements,
  makeTextElement,
  moveElement,
  removeElement,
  removeSlide,
  resolveElementById,
  setProperty,
  cleanupOperationsForDeletion,
} from "@deckastra/presentation-core";
import {
  buildIndex,
  copy as copyElements,
  duplicate as duplicateElements,
  escape as escapeSelection,
  cycleSelection,
  isAllowedWhileTyping,
  nudgeDistance,
  paste as pasteElements,
  resolveCommand,
  selectAll as selectAllElements,
  type ClipboardPayload,
} from "@deckastra/editor";

import { useEditor, type UseEditorInput } from "../lib/useEditor";
import { EditorCanvas } from "./EditorCanvas";
import { PresentMode } from "./PresentMode";

/**
 * The editor shell: canvas, slide strip, layers, inspector and toolbar.
 *
 * Journey D (doc 01 §7.4) is the goal — a complete deck buildable without AI.
 * That is not a nice-to-have: an editor that only works as an AI output viewer
 * makes the product fragile, because every gap in the model becomes a thing the
 * user simply cannot do.
 */

export function EditorShell(props: UseEditorInput & { onExit?: () => void }) {
  const editor = useEditor(props);
  const { document: doc, slideIndex, selection, setSelection, apply, nodes } = editor;

  const [presenting, setPresenting] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardPayload | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [canvasWidth, setCanvasWidth] = useState(880);

  const slide = doc.slides[slideIndex];
  const index = useMemo(() => buildIndex(nodes), [nodes]);
  const scene = useMemo(() => buildDocumentScene(doc), [doc]);

  const order = useMemo(() => nodes.map((node) => node.id), [nodes]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(undefined), 4000);
  }, []);

  // ------------------------------------------------------------------ actions

  const deleteSelection = useCallback(() => {
    if (!slide || selection.selectedIds.length === 0) return;

    // Cleanup first, in the same patch: deleting an element and orphaning its
    // animation in two steps leaves a window where the document is invalid, and
    // an undo of only the first half is worse than either.
    const operations = [
      ...cleanupOperationsForDeletion(doc, selection.selectedIds),
      ...selection.selectedIds.flatMap((id) => removeElement(doc, id)),
    ];

    apply(operations, { label: `Delete ${selection.selectedIds.length} object(s)`, selectionAfter: [] });
  }, [apply, doc, selection.selectedIds, slide]);

  const addText = useCallback(() => {
    if (!slide) return;
    const element = makeTextElement({
      text: "New text",
      x: doc.viewport.width / 2 - 240,
      y: doc.viewport.height / 2 - 40,
      width: 480,
      height: 80,
      semanticRole: "body",
      fontSize: 32,
    });
    apply(addElement(doc, { slideId: slide.id, element }), {
      label: "Add text",
      selectionAfter: [element.id],
    });
  }, [apply, doc, slide]);

  const addShape = useCallback(
    (shape: "rectangle" | "ellipse") => {
      if (!slide) return;
      const element = {
        // The schema's minter, not an ad-hoc id: ULIDs are monotonic and sort by
        // creation time, which is what keeps patch logs and diffs readable.
        id: newId("el"),
        type: "shape",
        shape,
        transform: {
          x: doc.viewport.width / 2 - 160,
          y: doc.viewport.height / 2 - 100,
          width: 320,
          height: 200,
        },
        style: {
          fill: { type: "solid", color: "token:colors.accent" },
          cornerRadius: shape === "rectangle" ? 12 : 0,
        },
      } as unknown as PresentationElement;

      apply(addElement(doc, { slideId: slide.id, element }), {
        label: `Add ${shape}`,
        selectionAfter: [element.id],
      });
    },
    [apply, doc, slide],
  );

  const group = useCallback(() => {
    if (selection.selectedIds.length < 2) return;
    try {
      const { operations, groupId } = groupElements(doc, selection.selectedIds, { name: "Group" });
      apply(operations, { label: "Group", selectionAfter: [groupId] });
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not group those.");
    }
  }, [apply, doc, flash, selection.selectedIds]);

  const reorder = useCallback(
    (direction: "forward" | "backward" | "front" | "back") => {
      const id = selection.primaryId ?? selection.selectedIds[0];
      if (!id || !slide) return;

      const found = resolveElementById(doc, id);
      if (!found) return;

      const siblings =
        found.ancestors.length > 0
          ? (found.ancestors.at(-1) as { children: PresentationElement[] }).children
          : slide.elements;

      const last = siblings.length - 1;
      const target =
        direction === "forward"
          ? Math.min(found.index + 1, last)
          : direction === "backward"
            ? Math.max(found.index - 1, 0)
            : direction === "front"
              ? last
              : 0;

      // Array position is the ordering authority; zIndex is an override for
      // pinning, not for reordering (doc 02 §8.4).
      apply(moveElement(doc, { elementId: id, toIndex: target }), { label: "Reorder" });
    },
    [apply, doc, selection, slide],
  );

  const nudge = useCallback(
    (dx: number, dy: number, big: boolean) => {
      if (selection.selectedIds.length === 0) return;
      const distance = nudgeDistance(big, doc.theme.grid.baseUnit);

      const operations = selection.selectedIds.flatMap((id) => {
        const found = resolveElementById(doc, id);
        if (!found) return [];
        return setProperty(doc, id, "transform", {
          ...found.element.transform,
          x: found.element.transform.x + dx * distance,
          y: found.element.transform.y + dy * distance,
        });
      });

      apply(operations, { label: "Nudge", coalesceKey: `nudge:${selection.selectedIds.join(",")}` });
    },
    [apply, doc, selection.selectedIds],
  );

  const toggleFlag = useCallback(
    (flag: "locked" | "visible") => {
      const operations = selection.selectedIds.flatMap((id) => {
        const found = resolveElementById(doc, id);
        if (!found) return [];
        const current =
          flag === "locked" ? found.element.locked === true : found.element.visible !== false;
        return setProperty(doc, id, flag, flag === "locked" ? !current : !current);
      });
      apply(operations, { label: flag === "locked" ? "Lock" : "Hide" });
    },
    [apply, doc, selection.selectedIds],
  );

  // ----------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA";

      const resolved = resolveCommand(event);
      if (!resolved) return;

      // Otherwise typing "d" in a text box duplicates the element.
      if (typing && !isAllowedWhileTyping(resolved.command)) return;

      const { command, shift } = resolved;
      let handled = true;

      switch (command) {
        case "delete":
          deleteSelection();
          break;
        case "duplicate": {
          const { operations, elementIds } = duplicateElements(doc, selection.selectedIds);
          if (operations.length > 0) apply(operations, { label: "Duplicate", selectionAfter: elementIds });
          break;
        }
        case "copy":
          setClipboard(copyElements(doc, selection.selectedIds));
          break;
        case "cut":
          setClipboard(copyElements(doc, selection.selectedIds));
          deleteSelection();
          break;
        case "paste": {
          if (!clipboard || !slide) break;
          const { operations, elementIds } = pasteElements(doc, clipboard, { targetSlideId: slide.id });
          apply(operations, { label: "Paste", selectionAfter: elementIds });
          break;
        }
        case "selectAll":
          setSelection((current) => selectAllElements(current, index, order));
          break;
        case "group":
          group();
          break;
        case "undo":
          editor.undo();
          break;
        case "redo":
          editor.redo();
          break;
        case "undoLastAgentChange": {
          const result = editor.undoLastAgentChange();
          if (!result.ok && result.message) flash(result.message);
          break;
        }
        case "bringForward":
          reorder("forward");
          break;
        case "sendBackward":
          reorder("backward");
          break;
        case "bringToFront":
          reorder("front");
          break;
        case "sendToBack":
          reorder("back");
          break;
        case "escape":
          setSelection((current) => escapeSelection(current, index));
          break;
        case "cycleNext":
          setSelection((current) => cycleSelection(current, index, order, 1));
          break;
        case "cyclePrevious":
          setSelection((current) => cycleSelection(current, index, order, -1));
          break;
        case "nudgeUp":
          nudge(0, -1, shift);
          break;
        case "nudgeDown":
          nudge(0, 1, shift);
          break;
        case "nudgeLeft":
          nudge(-1, 0, shift);
          break;
        case "nudgeRight":
          nudge(1, 0, shift);
          break;
        case "toggleLock":
          toggleFlag("locked");
          break;
        case "toggleHidden":
          toggleFlag("visible");
          break;
        case "present":
          setPresenting(true);
          break;
        default:
          handled = false;
      }

      if (handled) event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    apply,
    clipboard,
    deleteSelection,
    doc,
    editor,
    flash,
    group,
    index,
    nudge,
    order,
    reorder,
    selection.selectedIds,
    setSelection,
    slide,
    toggleFlag,
  ]);

  if (presenting) {
    return <PresentMode scene={scene} onExit={() => setPresenting(false)} initialSlide={slideIndex} />;
  }

  if (!slide) return <div style={{ padding: 40 }}>This deck has no slides.</div>;

  const selected = selection.primaryId ? resolveElementById(doc, selection.primaryId) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <Toolbar
        editor={editor}
        onAddText={addText}
        onAddShape={addShape}
        onDelete={deleteSelection}
        onGroup={group}
        onPresent={() => setPresenting(true)}
        onExit={props.onExit}
      />

      {notice ? (
        <div style={{ padding: "10px 20px", background: "rgba(242,193,78,0.14)", fontSize: 14 }}>
          {notice}
        </div>
      ) : null}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <SlideStrip editor={editor} scene={scene} onAdd={() =>
          apply(createSlide(doc).operations, { label: "Add slide" })
        } />

        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            background: "#07080b",
            overflow: "auto",
            padding: 24,
          }}
          ref={(node) => {
            if (node) {
              const available = node.clientWidth - 48;
              if (available > 200 && Math.abs(available - canvasWidth) > 12) {
                setCanvasWidth(Math.min(available, 1280));
              }
            }
          }}
        >
          <EditorCanvas editor={editor} width={canvasWidth} />
        </div>

        <SidePanel
          editor={editor}
          selectedElement={selected?.element}
          onReorder={reorder}
          onToggle={toggleFlag}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- toolbar

function Toolbar({
  editor,
  onAddText,
  onAddShape,
  onDelete,
  onGroup,
  onPresent,
  onExit,
}: {
  editor: ReturnType<typeof useEditor>;
  onAddText: () => void;
  onAddShape: (shape: "rectangle" | "ellipse") => void;
  onDelete: () => void;
  onGroup: () => void;
  onPresent: () => void;
  onExit?: () => void;
}) {
  const { save, selection } = editor;

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        flexWrap: "wrap",
      }}
    >
      <strong style={{ fontSize: 14, marginRight: 8 }}>{editor.document.metadata.title}</strong>

      <button style={toolButton} onClick={onAddText}>Text</button>
      <button style={toolButton} onClick={() => onAddShape("rectangle")}>Rect</button>
      <button style={toolButton} onClick={() => onAddShape("ellipse")}>Ellipse</button>

      <Divider />

      <button style={toolButton} onClick={editor.undo} disabled={!editor.canUndo} title="Undo (Cmd+Z)">
        Undo
      </button>
      <button style={toolButton} onClick={editor.redo} disabled={!editor.canRedo} title="Redo (Cmd+Shift+Z)">
        Redo
      </button>

      <Divider />

      <button style={toolButton} onClick={onGroup} disabled={selection.selectedIds.length < 2}>
        Group
      </button>
      <button style={toolButton} onClick={onDelete} disabled={selection.selectedIds.length === 0}>
        Delete
      </button>

      <div style={{ flex: 1 }} />

      <SaveIndicator save={save} onRetry={() => void editor.saveNow()} />
      <button style={primaryButton} onClick={onPresent}>Present</button>
      {onExit ? (
        <button style={toolButton} onClick={onExit}>Close</button>
      ) : null}
    </header>
  );
}

function SaveIndicator({ save, onRetry }: { save: ReturnType<typeof useEditor>["save"]; onRetry: () => void }) {
  const base: CSSProperties = { fontSize: 13, color: "var(--fg-subtle)", marginRight: 8 };

  switch (save.status) {
    case "saving":
      return <span style={base}>Saving…</span>;
    case "pending":
      return <span style={base}>Unsaved changes</span>;
    case "saved":
      return <span style={base}>Saved</span>;
    case "conflict":
      return (
        <span style={{ ...base, color: "var(--warning)" }} title={save.message}>
          Changed elsewhere — reload
        </span>
      );
    case "error":
      return (
        <button style={{ ...toolButton, color: "var(--danger)" }} onClick={onRetry} title={save.message}>
          Save failed — retry
        </button>
      );
    default:
      return null;
  }
}

// --------------------------------------------------------------- slide strip

function SlideStrip({
  editor,
  scene,
  onAdd,
}: {
  editor: ReturnType<typeof useEditor>;
  scene: ReturnType<typeof buildDocumentScene>;
  onAdd: () => void;
}) {
  return (
    <nav
      style={{
        width: 176,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        overflowY: "auto",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {scene.slides.map((slideScene, i) => (
        <button
          key={slideScene.slideId}
          onClick={() => editor.setSlideIndex(i)}
          title={slideScene.keyMessage}
          style={{
            padding: 0,
            border: `2px solid ${i === editor.slideIndex ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 6,
            overflow: "hidden",
            background: "#000",
            lineHeight: 0,
            position: "relative",
          }}
        >
          <ScaledSlide scene={slideScene} width={148} mode="present" />
          <span
            style={{
              position: "absolute",
              left: 4,
              top: 4,
              fontSize: 10,
              background: "rgba(0,0,0,0.6)",
              padding: "1px 5px",
              borderRadius: 4,
              color: "#fff",
              lineHeight: 1.6,
            }}
          >
            {i + 1}
          </span>
        </button>
      ))}

      <button style={{ ...toolButton, justifyContent: "center" }} onClick={onAdd}>
        + Slide
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------- side panel

function SidePanel({
  editor,
  selectedElement,
  onReorder,
  onToggle,
}: {
  editor: ReturnType<typeof useEditor>;
  selectedElement?: PresentationElement;
  onReorder: (direction: "forward" | "backward" | "front" | "back") => void;
  onToggle: (flag: "locked" | "visible") => void;
}) {
  const { document: doc, slideIndex, selection, setSelection } = editor;
  const slide = doc.slides[slideIndex];

  return (
    <aside
      style={{
        width: 260,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        overflowY: "auto",
        padding: 16,
        fontSize: 13,
      }}
    >
      <h3 style={panelHeading}>Layers</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 24 }}>
        {slide
          ? [...walkElements(slide.elements)].map(({ element, depth }) => {
              const isSelected = selection.selectedIds.includes(element.id);
              return (
                <button
                  key={element.id}
                  onClick={(event) =>
                    setSelection((current) => ({
                      ...current,
                      selectedIds: event.shiftKey
                        ? [...new Set([...current.selectedIds, element.id])]
                        : [element.id],
                      primaryId: element.id,
                    }))
                  }
                  style={{
                    textAlign: "left",
                    padding: "5px 8px",
                    paddingLeft: 8 + depth * 14,
                    border: "none",
                    borderRadius: 5,
                    background: isSelected ? "rgba(76,194,255,0.16)" : "transparent",
                    color: element.visible === false ? "var(--fg-subtle)" : "var(--fg-muted)",
                    fontSize: 12,
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <span style={{ opacity: 0.5, minWidth: 52 }}>{element.type}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {labelFor(element)}
                  </span>
                  {element.locked ? <span title="Locked">🔒</span> : null}
                </button>
              );
            })
          : null}
      </div>

      {selectedElement ? (
        <>
          <h3 style={panelHeading}>Object</h3>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: "0 0 16px" }}>
            <dt style={dtStyle}>Type</dt>
            <dd style={ddStyle}>{selectedElement.type}</dd>
            <dt style={dtStyle}>Role</dt>
            <dd style={ddStyle}>{selectedElement.semanticRole ?? "—"}</dd>
            <dt style={dtStyle}>X</dt>
            <dd style={ddStyle}>{Math.round(selectedElement.transform.x)}</dd>
            <dt style={dtStyle}>Y</dt>
            <dd style={ddStyle}>{Math.round(selectedElement.transform.y)}</dd>
            <dt style={dtStyle}>W</dt>
            <dd style={ddStyle}>{Math.round(selectedElement.transform.width)}</dd>
            <dt style={dtStyle}>H</dt>
            <dd style={ddStyle}>{Math.round(selectedElement.transform.height)}</dd>
          </dl>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 24 }}>
            <button style={toolButton} onClick={() => onReorder("front")}>Front</button>
            <button style={toolButton} onClick={() => onReorder("forward")}>Fwd</button>
            <button style={toolButton} onClick={() => onReorder("backward")}>Back</button>
            <button style={toolButton} onClick={() => onReorder("back")}>Bottom</button>
            <button style={toolButton} onClick={() => onToggle("locked")}>
              {selectedElement.locked ? "Unlock" : "Lock"}
            </button>
            <button style={toolButton} onClick={() => onToggle("visible")}>
              {selectedElement.visible === false ? "Show" : "Hide"}
            </button>
          </div>
        </>
      ) : null}

      <h3 style={panelHeading}>History</h3>
      <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
        {editor.historyEntries.slice(0, 12).map((entry) => (
          <li
            key={entry.id}
            style={{ fontSize: 12, color: "var(--fg-subtle)", display: "flex", gap: 6 }}
          >
            <span style={{ opacity: 0.6 }}>{entry.source === "agent" ? "AI" : "You"}</span>
            <span>{entry.label}</span>
          </li>
        ))}
        {editor.historyEntries.length === 0 ? (
          <li style={{ fontSize: 12, color: "var(--fg-subtle)" }}>No changes yet.</li>
        ) : null}
      </ol>
    </aside>
  );
}

function labelFor(element: PresentationElement): string {
  if (element.name) return element.name;
  if (element.type === "text") {
    const content = (element as { content?: unknown }).content;
    const text = content ? textContent(content as never) : "";
    return text.slice(0, 24) || "Empty text";
  }
  return element.id.slice(3, 11);
}

function Divider() {
  return <span style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />;
}

const toolButton: CSSProperties = {
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  color: "var(--fg-muted)",
  borderRadius: 7,
  padding: "6px 11px",
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  gap: 5,
};

const primaryButton: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg)",
  border: "none",
  borderRadius: 7,
  padding: "7px 16px",
  fontSize: 13,
  fontWeight: 600,
};

const panelHeading: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.4,
  textTransform: "uppercase",
  color: "var(--fg-subtle)",
  margin: "0 0 10px",
};

const dtStyle: CSSProperties = { color: "var(--fg-subtle)", fontSize: 12 };
const ddStyle: CSSProperties = { margin: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" };
