"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  newId,
  plainText,
  isGroup,
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
  makeStarterElement,
  type StarterElementKind,
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

import { useBrowserMeasurer } from "../lib/measurer";
import { altTextFor, altTextProperty, needsAltText } from "../lib/accessibility";
import { ThemePanel } from "./ThemePanel";
import { checkFrameBudget } from "@deckastra/renderer";

import { AskPanel } from "./AskPanel";
import { ProposalsPanel } from "./ProposalsPanel";
import { AccessibilityPanel } from "./AccessibilityPanel";
import { CriticIssues } from "./CriticIssues";
import { ConflictRecovery } from "./ConflictRecovery";
import { ExportPanel } from "./ExportPanel";
import { SharePanel } from "./SharePanel";
import { MotionPanel } from "./MotionPanel";
import { MotionPreview } from "./MotionPreview";

import type { OpenPresenterWindow } from "@deckastra/workspace-contracts";

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

export interface EditorShellProps extends UseEditorInput {
  onExit?: () => void;
  /**
   * How the presenter view gets its own window, forwarded to `PresentMode`.
   *
   * The shell does not use it itself. It is here because present mode is reached
   * from the toolbar rather than from a route, so a host has no other way to hand
   * it down — and a host that cannot replace `window.open` cannot put the
   * presenter view on a second display.
   */
  openPresenter?: OpenPresenterWindow;
}

export function EditorShell(props: EditorShellProps) {
  const editor = useEditor(props);
  const { document: doc, slideIndex, selection, setSelection, apply, nodes } = editor;

  const [presenting, setPresenting] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardPayload | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  // Last drag's frame times. Shown rather than logged: doc 04 §31.5 is explicit
  // that an untracked budget regresses quietly, and this is the smallest thing
  // that makes the drag budget observable while telemetry is Phase 9.
  const [frames, setFrames] = useState<{ summary: string; over: boolean }>();
  const [canvasWidth, setCanvasWidth] = useState(880);
  // The motion playhead. Editor state, not document state — where the author has
  // scrubbed to is exactly the kind of thing doc 02 §4.1 keeps out of the file.
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(0);
  // Whether the author has asked to see the motion. Until they do the canvas
  // shows the slide at rest — see MotionPreview for why.
  const [scrubbing, setScrubbing] = useState(false);

  const slide = doc.slides[slideIndex];
  const index = useMemo(() => buildIndex(nodes), [nodes]);
  const measurer = useBrowserMeasurer();
  const scene = useMemo(() => buildDocumentScene(doc, { measurer }), [doc, measurer]);

  const order = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const slideScene = scene.slides[slideIndex];

  useEffect(() => {
    // Changing slide ends the preview. The playhead belongs to the slide it was
    // scrubbed on, and carrying it across would show the new slide part-way
    // through an entrance nobody asked to see.
    setScrubbing(false);
    setPlayheadMs(0);
  }, [slideIndex]);

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

  const addStarter = useCallback(
    (kind: StarterElementKind, shape?: "rectangle" | "ellipse") => {
      if (!slide) return;
      const element = makeStarterElement({ kind, viewport: doc.viewport, shape });

      apply(addElement(doc, { slideId: slide.id, element }), {
        label: `Add ${shape ?? kind}`,
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
    return (
      <PresentMode
        scene={scene}
        onExit={() => setPresenting(false)}
        initialSlide={slideIndex}
        // Scoped to the deck, so two decks presented at once do not drive each
        // other's second screen.
        channelName={`deckastra-present-${props.presentationId}`}
        {...(props.openPresenter ? { openPresenter: props.openPresenter } : {})}
      />
    );
  }

  if (!editor.recoveryReady) return <p role="status">Loading saved edits…</p>;
  if (!slide) return <><ConflictRecovery editor={editor} /><div style={{ padding: 40 }}>This deck has no slides.</div></>;

  const selected = selection.primaryId ? resolveElementById(doc, selection.primaryId) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <Toolbar
        editor={editor}
        onAdd={addStarter}
        onDelete={deleteSelection}
        onGroup={group}
        onPresent={() => setPresenting(true)}
        onExit={props.onExit}
      />

      <ConflictRecovery editor={editor} />

      {notice ? (
        <div style={{ padding: "10px 20px", background: "rgba(242,193,78,0.14)", fontSize: 14 }}>
          {notice}
        </div>
      ) : null}

      {frames ? (
        <div
          style={{
            padding: "4px 20px",
            fontSize: 12,
            color: frames.over ? "var(--warning)" : "var(--fg-subtle)",
            borderBottom: "1px solid var(--border)",
            fontVariantNumeric: "tabular-nums",
          }}
          title="Frame timing during the last drag. The budget (doc 04 §31.1) is met when the work fits inside frames the compositor was going to paint anyway."
        >
          Last drag: {frames.summary}
          {frames.over ? " — dropping frames" : ""}
        </div>
      ) : null}

      {/* Applies the sampled styles to the canvas's real elements. It renders
          nothing; the motion it drives is the editor's own DOM.

          Unmounted while presenting: present mode drives the same elements from
          its own adapter, and two adapters writing the same styles is a race. */}
      {slideScene && !presenting ? (
        <MotionPreview
          document={doc}
          scene={slideScene}
          slideIndex={slideIndex}
          timeMs={playheadMs}
          playToken={playing}
          engaged={scrubbing}
          onTime={setPlayheadMs}
        />
      ) : null}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <SlideStrip editor={editor} scene={scene} onAdd={() =>
          apply(createSlide(doc).operations, { label: "Add slide" })
        } />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
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
            <EditorCanvas
              editor={editor}
              width={canvasWidth}
              onFrameStats={(stats) => {
                const verdict = checkFrameBudget(stats);
                setFrames({ summary: verdict.summary, over: !verdict.withinBudget });
              }}
            />
          </div>

          {/* Under the canvas, not in the side panel: a timeline is horizontal
              and an author needs to see the slide while scrubbing it. */}
          {slideScene ? (
            <MotionPanel
              document={doc}
              scene={slideScene}
              slideIndex={slideIndex}
              selectedIds={selection.selectedIds}
              apply={(operations, label) =>
                apply(operations as never, { label })
              }
              playheadMs={playheadMs}
              onScrub={(at) => {
                setScrubbing(true);
                setPlayheadMs(at);
              }}
              onPlay={() => {
                setScrubbing(true);
                setPlaying((count) => count + 1);
              }}
            />
          ) : null}
        </div>

        <SidePanel
          editor={editor}
          selectedElement={selected?.element}
          onReorder={reorder}
          onToggle={toggleFlag}
          presentationId={props.presentationId}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- toolbar

function Toolbar({
  editor,
  onAdd,
  onDelete,
  onGroup,
  onPresent,
  onExit,
}: {
  editor: ReturnType<typeof useEditor>;
  onAdd: (kind: StarterElementKind, shape?: "rectangle" | "ellipse") => void;
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

      <button style={toolButton} onClick={() => onAdd("text")}>Text</button>
      <button style={toolButton} onClick={() => onAdd("shape", "rectangle")}>Rect</button>
      <button style={toolButton} onClick={() => onAdd("shape", "ellipse")}>Ellipse</button>
      <select
        aria-label="Insert object"
        defaultValue=""
        onChange={(event) => {
          const kind = event.target.value as StarterElementKind;
          if (kind) onAdd(kind);
          event.target.value = "";
        }}
        style={{ ...toolButton, paddingRight: 26 }}
      >
        <option value="" disabled>More…</option>
        <option value="line">Line</option>
        <option value="icon">Icon</option>
        <option value="chart">Chart</option>
        <option value="diagram">Diagram</option>
        <option value="table">Table</option>
        <option value="code">Code</option>
      </select>

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
      return <button style={{ ...toolButton, ...base }} onClick={onRetry}>Save changes</button>;
    case "saved":
      return <span style={base}>Saved</span>;
    case "updated":
      // Said once, plainly. The deck on screen just changed without the user
      // touching it, and silence would read as the app misbehaving.
      return (
        <span
          style={{ ...base, color: "var(--accent, var(--fg-muted))" }}
          role="status"
          title="Someone else changed this deck — an agent, or another window — and it was taken in. Undo starts fresh from here."
        >
          Updated elsewhere
        </span>
      );
    case "conflict":
      return (
        <span style={{ ...base, color: "var(--warning)" }} title={save.message}>
          Local work retained — review conflict
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
  presentationId,
}: {
  editor: ReturnType<typeof useEditor>;
  selectedElement?: PresentationElement;
  onReorder: (direction: "forward" | "backward" | "front" | "back") => void;
  onToggle: (flag: "locked" | "visible") => void;
  presentationId: string;
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
      <ThemePanel key={presentationId} editor={editor} presentationId={presentationId} />
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

          <InspectorFields editor={editor} element={selectedElement} />

          {isGroup(selectedElement) ? (
            <label style={{ display: "grid", gap: 6, marginBottom: 16 }}>
              Resize behavior
              <select
                disabled={selectedElement.locked === true}
                value={selectedElement.resizeMode ?? (selectedElement.containerLayout ? "resizeContainer" : "scaleChildren")}
                onChange={(event) => editor.apply(
                  setProperty(editor.document, selectedElement.id, "resizeMode", event.target.value),
                  { label: "Change group resize behavior" },
                )}
              >
                <option value="scaleChildren">Scale objects and text</option>
                <option value="resizeContainer">Resize container only</option>
              </select>
            </label>
          ) : null}

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

      <CriticIssues value={editor.document.extensions?.["deckastra.unresolvedIssues"]} slideId={slide?.id} />

      <div style={{ margin: "16px -16px 0" }}>
        <AccessibilityPanel
          document={doc}
          slideId={slide?.id}
          onSelect={(targetSlideId, elementId) => {
            const targetIndex = doc.slides.findIndex((candidate) => candidate.id === targetSlideId);
            if (targetIndex < 0) return;
            editor.setSlideIndex(targetIndex);
            if (elementId) {
              setSelection((current) => ({ ...current, selectedIds: [elementId], primaryId: elementId }));
            }
          }}
        />
      </div>

      {/* Above Ask rather than in a menu: an export is a thing people look for,
          and its report is something they should read rather than dismiss. */}
      <div style={{ margin: "16px -16px 0" }}>
        <SharePanel presentationId={presentationId} />
        <ExportPanel presentationId={presentationId} />
      </div>

      {/* Journey C. Placed at the bottom of the panel the user is already
          looking at while they have something selected, rather than in a modal
          that hides the thing they are asking about. */}
      <div style={{ margin: "16px -16px -16px" }}>
        <ProposalsPanel
          presentationId={presentationId}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
        />
        <AskPanel
          presentationId={presentationId}
          selectedIds={selection.selectedIds}
          slideId={slide?.id}
          onApplied={editor.adoptDocument}
          saveNow={editor.saveNow}
        />
      </div>
    </aside>
  );
}

function InspectorFields({
  editor,
  element,
}: {
  editor: ReturnType<typeof useEditor>;
  element: PresentationElement;
}) {
  const disabled = element.locked === true;
  const change = (property: string, value: unknown, label = "Edit object") => {
    editor.apply(setProperty(editor.document, element.id, property, value), {
      label,
      coalesceKey: `inspector:${element.id}:${property}`,
    });
  };
  const number = (property: string, value: number, label: string, min?: number, max?: number) => (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={property === "opacity" ? 0.05 : 1}
      disabled={disabled}
      onChange={(event) => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next)) {
          change(property, Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next)), label);
        }
      }}
      style={inspectorInput}
    />
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr)", gap: "8px 10px", marginBottom: 18 }}>
      <label htmlFor="object-name" style={inspectorLabel}>Name</label>
      <input
        id="object-name"
        value={element.name ?? ""}
        placeholder="Optional"
        disabled={disabled}
        onChange={(event) => change("name", event.target.value, "Rename object")}
        style={inspectorInput}
      />
      <span style={inspectorLabel}>Position</span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {number("transform.x", element.transform.x, "Move object")}
        {number("transform.y", element.transform.y, "Move object")}
      </div>
      <span style={inspectorLabel}>Size</span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {number("transform.width", element.transform.width, "Resize object", 1)}
        {number("transform.height", element.transform.height, "Resize object", 1)}
      </div>
      <label htmlFor="object-rotation" style={inspectorLabel}>Rotation</label>
      {number("transform.rotation", element.transform.rotation ?? 0, "Rotate object")}
      <label htmlFor="object-opacity" style={inspectorLabel}>Opacity</label>
      {number("opacity", element.opacity ?? 1, "Change opacity", 0, 1)}

      {element.type === "text" ? (
        <>
          <label htmlFor="text-content" style={inspectorLabel}>Text</label>
          <textarea
            id="text-content"
            value={textContent((element as unknown as { content: Parameters<typeof textContent>[0] }).content)}
            disabled={disabled}
            rows={4}
            onChange={(event) => change("content", plainText(event.target.value, newId("blk")), "Edit text")}
            style={inspectorInput}
          />
          <label htmlFor="text-size" style={inspectorLabel}>Font size</label>
          {number("typography.fontSize", (element as unknown as { typography: { fontSize?: number } }).typography.fontSize ?? 26, "Change font size", 1)}
        </>
      ) : null}

      {element.type === "shape" ? (
        <>
          <label htmlFor="shape-kind" style={inspectorLabel}>Shape</label>
          <select id="shape-kind" value={String((element as unknown as { shape: unknown }).shape)} disabled={disabled} onChange={(event) => change("shape", event.target.value, "Change shape")} style={inspectorInput}>
            {(["rectangle", "ellipse", "triangle", "diamond", "pill", "star", "arrow", "chevron", "parallelogram", "speechBubble"] as const).map((kind) => <option key={kind}>{kind}</option>)}
          </select>
        </>
      ) : null}

      {element.type === "line" ? (
        <>
          <label htmlFor="line-routing" style={inspectorLabel}>Routing</label>
          <select id="line-routing" value={String((element as unknown as { routing?: unknown }).routing ?? "straight")} disabled={disabled} onChange={(event) => change("routing", event.target.value, "Change line routing")} style={inspectorInput}>
            <option value="straight">Straight</option><option value="orthogonal">Orthogonal</option><option value="curved">Curved</option>
          </select>
          <label htmlFor="line-marker" style={inspectorLabel}>End</label>
          <select id="line-marker" value={String((element as unknown as { endMarker?: unknown }).endMarker ?? "none")} disabled={disabled} onChange={(event) => change("endMarker", event.target.value, "Change line marker")} style={inspectorInput}>
            {(["none", "arrow", "openArrow", "dot", "square", "diamond"] as const).map((marker) => <option key={marker}>{marker}</option>)}
          </select>
        </>
      ) : null}

      {element.type === "icon" ? (
        <>
          <label htmlFor="icon-name" style={inspectorLabel}>Icon</label>
          <input id="icon-name" value={String((element as unknown as { icon: { name: unknown } }).icon.name)} disabled={disabled} onChange={(event) => change("icon.name", event.target.value, "Change icon")} style={inspectorInput} />
        </>
      ) : null}

      {element.type === "chart" ? (
        <>
          <label htmlFor="chart-kind" style={inspectorLabel}>Chart</label>
          <select id="chart-kind" value={String((element as unknown as { chartType: unknown }).chartType)} disabled={disabled} onChange={(event) => change("chartType", event.target.value, "Change chart type")} style={inspectorInput}>
            {(["bar", "column", "line", "area", "pie", "donut", "scatter", "stackedBar", "stackedColumn", "combo"] as const).map((kind) => <option key={kind}>{kind}</option>)}
          </select>
        </>
      ) : null}

      {element.type === "code" ? (
        <>
          <label htmlFor="code-language" style={inspectorLabel}>Language</label>
          <input id="code-language" value={String((element as unknown as { language: unknown }).language)} disabled={disabled} onChange={(event) => change("language", event.target.value, "Change code language")} style={inspectorInput} />
          <label htmlFor="code-content" style={inspectorLabel}>Code</label>
          <textarea id="code-content" value={String((element as unknown as { code: unknown }).code)} disabled={disabled} rows={8} onChange={(event) => change("code", event.target.value, "Edit code")} style={{ ...inspectorInput, fontFamily: "ui-monospace, monospace" }} />
        </>
      ) : null}

      {element.type === "image" ? (
        <>
          <label htmlFor="image-fit" style={inspectorLabel}>Fit</label>
          <select id="image-fit" value={String((element as unknown as { fit?: unknown }).fit ?? "cover")} disabled={disabled} onChange={(event) => change("fit", event.target.value, "Change image fit")} style={inspectorInput}>
            <option value="cover">Cover</option><option value="contain">Contain</option><option value="fill">Fill</option><option value="none">None</option>
          </select>
        </>
      ) : null}

      {needsAltText(element) ? (
        <>
          <label htmlFor="object-alt-text" style={inspectorLabel}>Alt text</label>
          <textarea
            id="object-alt-text"
            value={altTextFor(element)}
            placeholder="Describe the visual's meaning"
            disabled={disabled}
            rows={3}
            onChange={(event) => {
              const property = altTextProperty(element);
              if (property === "metadata.altText" && !element.metadata) {
                change("metadata", { altText: event.target.value }, "Edit alternative text");
              } else {
                change(property, event.target.value, "Edit alternative text");
              }
            }}
            style={inspectorInput}
          />
        </>
      ) : null}
    </div>
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

const inspectorLabel: CSSProperties = {
  color: "var(--fg-subtle)",
  fontSize: 11,
  alignSelf: "center",
};

const inspectorInput: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
  padding: "5px 7px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--surface-alt)",
  color: "var(--fg-muted)",
  fontSize: 12,
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
