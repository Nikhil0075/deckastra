"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isGroup, type PresentationElement, type ShapeKind } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import { useAssetUrls } from "../lib/asset-urls";
import { uploadAndInsertImage } from "../lib/insert-image";
import {
  addElement,
  createSlide,
  groupElements,
  makeStarterElement,
  type StarterElementKind,
  moveElement,
  removeElement,
  resolveElementById,
  setProperty,
  cleanupOperationsForDeletion,
  ungroupElements,
} from "@deckastra/presentation-core";
import {
  buildIndex,
  copy as copyElements,
  duplicate as duplicateElements,
  escape as escapeSelection,
  commandScope,
  cycleLeavesScope,
  cycleSelection,
  enterGroup,
  isAllowedWhileTyping,
  nudgeDistance,
  paste as pasteElements,
  resolveCommand,
  selectAll as selectAllElements,
  type ClipboardPayload,
} from "@deckastra/editor";

import { useBrowserMeasurer } from "../lib/measurer";
import { containerPlacements } from "../lib/group-placements";
import { classifyTransfer, pastedTextOperations, writeClipboard, type Transfer } from "../lib/external-clipboard";
import { textEditRefusal } from "../lib/text-targets";
import { commitFocusedDraft } from "../lib/drafts";
import { focusNextRegion } from "../lib/regions";
import { setThemePreference } from "../lib/chrome-theme";
import {
  isDeckListCommand,
  modeForCommand,
  themeForCommand,
  type DeckListCommand,
  type HostCommand,
  type SubscribeHostCommands,
} from "../lib/host-commands";
import { dockHeightFor, type EditorMode, type Zoom } from "../lib/editor-layout";

import { ConflictRecovery } from "./ConflictRecovery";
import { MotionPanel } from "./MotionPanel";
import { MotionPreview } from "./MotionPreview";
import { Inspector, type ReorderDirection } from "./inspector/Inspector";
import { AppBar } from "./shell/AppBar";
import { CanvasStage } from "./shell/CanvasStage";
import { AiPanel, CodePanel } from "./shell/ModePanels";
import { MotionModePanel } from "./shell/MotionModePanel";
import { SlideStrip } from "./shell/SlideStrip";
import { SpeakerNotes } from "./shell/SpeakerNotes";
import { ToolRail } from "./shell/ToolRail";
import { loadPanels, panelsForCommand, panelsForKey, savePanels, type PanelVisibility } from "../lib/panels";

import type { OpenPresenterWindow } from "@deckastra/workspace-contracts";

import { useEditor, type UseEditorInput } from "../lib/useEditor";
import { PresentMode } from "./PresentMode";
import { VersionHistory } from "./VersionHistory";
import { ColorStudioPanel } from "./ColorStudioPanel";
import { AddLibrary, type LibraryTab } from "./shell/AddLibrary";
import type { SidePanel } from "./shell/ToolRail";
import { LayersList } from "./inspector/LayersList";
import { DesignCheckPanel } from "./DesignCheckPanel";
import { designCheck } from "../lib/design-check";
import { ColorStudioProvider, type ColorStudio } from "../lib/color-studio";
import { Button, IconButton } from "../ui";

/**
 * The editor shell (Figma: MAIN SCREEN): top bar, insert rail, slide strip,
 * canvas, a mode-dependent right panel, and the motion dock under the canvas.
 *
 * Journey D (doc 01 §7.4) is the goal — a complete deck buildable without AI.
 * That is not a nice-to-have: an editor that only works as an AI output viewer
 * makes the product fragile, because every gap in the model becomes a thing the
 * user simply cannot do.
 *
 * This file owns the editor's *actions* and its keyboard; the layout pieces
 * under `shell/` and `inspector/` only gesture. Mode, zoom and the playhead are
 * editor state and never reach the document (doc 02 §4.1).
 */

export interface EditorShellProps extends UseEditorInput {
  /**
   * Leave the deck for the deck list. `next` is what the list should do on
   * arrival (New deck and Generate chosen from the menu inside the editor); it is
   * passed only after the save queue drained, so a refusal to leave never starts
   * a new deck behind the person's back.
   */
  onExit?: (next?: DeckListCommand) => void;
  /**
   * The host's own commands — the desktop application menu. The editor keeps
   * every keyboard shortcut it has; this is the other way to reach them.
   */
  commands?: SubscribeHostCommands;
  /**
   * How the presenter view gets its own window, forwarded to `PresentMode`.
   *
   * The shell does not use it itself. It is here because present mode is reached
   * from the toolbar rather than from a route, so a host has no other way to hand
   * it down — and a host that cannot replace `window.open` cannot put the
   * presenter view on a second display.
   */
  openPresenter?: OpenPresenterWindow;
  /**
   * Host-owned controls for the top bar, placed before Share — the desktop's
   * agent-access switch. A slot rather than a feature flag: the editor has no
   * business knowing which shell it is in.
   */
  barExtras?: ReactNode;
  /**
   * Host-owned banners shown under the top bar (the desktop's "reconnecting to
   * the workspace service"). Inside the shell's own layout, so a banner never
   * pushes the editor past the bottom of the window.
   */
  notices?: ReactNode;
}

export function EditorShell(props: EditorShellProps) {
  const editor = useEditor(props);
  const { document: doc, slideIndex, selection, setSelection, apply, nodes } = editor;

  const client = useWorkspaceClient();
  const [presenting, setPresenting] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardPayload | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);
  // The Colours panel, and what it opens at (a theme role or a named colour).
  const [colors, setColors] = useState<{ open: boolean; focus?: string }>({ open: false });
  // The left side panel: the Add library, Layers, or the accessibility Check.
  // Editor state; it never reaches the document.
  const [side, setSide] = useState<{ panel?: SidePanel; tab: LibraryTab }>({ tab: "shapes" });
  const togglePanel = useCallback((panel: SidePanel, tab?: LibraryTab) => {
    setSide((current) => {
      // The same button again closes it, except a library button asking for a
      // different tab, which switches tab.
      if (current.panel === panel && (panel !== "library" || !tab || tab === current.tab)) return { ...current, panel: undefined };
      return { panel, tab: tab ?? current.tab };
    });
  }, []);
  const [restoreRefusal, setRestoreRefusal] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("design");
  const [zoom, setZoom] = useState<Zoom>("fit");
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
  const findings = useMemo(() => designCheck(doc, scene), [doc, scene]);
  const resolveAssetUrl = useAssetUrls(doc);

  const order = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const slideScene = scene.slides[slideIndex];

  useEffect(() => {
    // Changing slide ends the preview. The playhead belongs to the slide it was
    // scrubbed on, and carrying it across would show the new slide part-way
    // through an entrance nobody asked to see.
    setScrubbing(false);
    setPlayheadMs(0);
  }, [slideIndex]);

  // So does leaving Motion mode, or starting to type into a text box (MA-26).
  // A slide scrubbed to the first frame of a fade has invisible objects that
  // can still be clicked, and moved ones whose selection box sits where the
  // object is not; editing it in that pose is editing something you cannot see.
  const stopPreview = useCallback(() => {
    setScrubbing(false);
    setPlaying(0);
  }, []);
  useEffect(() => {
    if (mode !== "motion") stopPreview();
  }, [mode, stopPreview]);
  useEffect(() => {
    if (selection.editingTextId) stopPreview();
  }, [selection.editingTextId, stopPreview]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(undefined), 4000);
  }, []);

  // Leaving the deck (to the deck list) lets the shell unmount the editor, and
  // with it the autosave queue. So it waits for the queue to empty, and stays
  // if it cannot: work that has not reached the service would otherwise be
  // left in a recovery journal the person does not know to look for.
  const { onExit } = props;
  const exit = useMemo(
    () =>
      onExit
        ? (next?: DeckListCommand) => {
            // A field holding a draft (the speaker notes) commits on blur. A
            // click on "All decks" blurs it; a menu shortcut pressed while
            // typing does not, and the draft would unmount with the editor
            // after the save it should have been part of.
            commitFocusedDraft();
            void editor.saveNow().then((drained) => {
              if (drained) onExit(next);
              else flash("Your latest changes have not saved yet, so the deck stays open. Try again in a moment.");
            });
          }
        : undefined,
    [editor, flash, onExit],
  );

  // The host's menu. Held in a ref so the subscription is made once per host
  // rather than torn down on every render, while the handler still sees the
  // current editor. Present mode has its own keys; a menu choice made while
  // presenting is ignored rather than editing a deck nobody is looking at.
  // Which panels are on screen (lib/panels.ts): editor state, remembered per
  // browser profile, never written to the deck.
  const [panels, setPanelsState] = useState<PanelVisibility>(() => loadPanels());
  const setPanels = useCallback((next: PanelVisibility) => {
    setPanelsState(next);
    savePanels(next);
  }, []);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;

  const onCommand = useRef<(command: HostCommand) => void>(() => {});
  onCommand.current = (command) => {
    const theme = themeForCommand(command);
    if (theme) {
      setThemePreference(theme);
      return;
    }
    if (presenting) return;
    const nextPanels = panelsForCommand(command, panelsRef.current);
    if (nextPanels) {
      setPanels(nextPanels);
      return;
    }
    const nextMode = modeForCommand(command);
    if (nextMode) {
      setMode(nextMode);
      return;
    }
    if (isDeckListCommand(command)) {
      exit?.(command);
      return;
    }
    switch (command) {
      case "all-decks":
        exit?.();
        break;
      case "undo":
        editor.undo();
        break;
      case "redo":
        editor.redo();
        break;
      case "present":
        setPresenting(true);
        break;
      case "version-history":
        setHistoryOpen(true);
        break;
      case "colors":
        // Colours is part of Design; opening it from another mode goes there.
        setMode("design");
        setColors({ open: true });
        break;
    }
  };
  const { commands } = props;
  useEffect(() => commands?.((command) => onCommand.current(command)), [commands]);

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
    (kind: StarterElementKind, shape?: ShapeKind, icon?: string, iconSet?: string) => {
      if (!slide) return;
      const element = makeStarterElement({ kind, viewport: doc.viewport, shape, icon, ...(iconSet ? { iconSet } : {}) });

      apply(addElement(doc, { slideId: slide.id, element }), {
        label: `Add ${icon ? `${icon} icon` : (shape ?? kind)}`,
        selectionAfter: [element.id],
      });
      // The new object is selected; the canvas takes focus so its shortcuts —
      // arrows, Delete — act on it, as they would after clicking it.
      document.querySelector<HTMLElement>("[data-editor-canvas]")?.focus({ preventScroll: true });
    },
    [apply, doc, slide],
  );

  const [uploadError, setUploadError] = useState<string | null>(null);

  const addImage = useCallback(
    async (file: File) => {
      if (!slide) return;
      setUploadError(null);
      try {
        const { operations, elementId } = await uploadAndInsertImage(client, {
          document: doc,
          slideId: slide.id,
          file,
        });
        // One patch, through the same path a rectangle takes: the manifest entry
        // and the element arrive together and undo together. Separately, an
        // element would cite an asset the document cannot resolve, or a manifest
        // entry would name an asset nothing references and the sweeper would
        // eventually take the bytes.
        apply(operations, { label: "Add image", selectionAfter: [elementId] });
      } catch (caught) {
        // Said rather than swallowed. The most likely refusal is the storage
        // quota, which is charged when the upload is registered — and a picture
        // that silently does not appear reads as the editor being broken.
        setUploadError(caught instanceof Error ? caught.message : "That image could not be added.");
      }
    },
    [apply, client, doc, slide],
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

  /**
   * Dissolve the selected group (MA-06). The children stay where they are drawn
   * and stay selected, so the next thing a person does — move one of them —
   * needs no further clicks. One patch, so one Undo regroups exactly.
   */
  const ungroup = useCallback(() => {
    const id = selection.primaryId ?? selection.selectedIds[0];
    const found = id ? resolveElementById(doc, id) : undefined;
    if (!id || !found || !isGroup(found.element)) {
      flash("Select a group to ungroup it.");
      return;
    }
    try {
      const placements = containerPlacements(found.element, slideScene);
      const { operations, elementIds, approximated } = ungroupElements(doc, id, { placements });
      apply(operations, { label: "Ungroup", selectionAfter: elementIds });
      if (approximated.length > 0) {
        flash(
          "This group was stretched unevenly, which a rotated object cannot keep on its own. " +
            "Its rotated objects were placed as closely as they can be; Undo puts the group back.",
        );
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not ungroup that.");
    }
  }, [apply, doc, flash, selection.primaryId, selection.selectedIds, slideScene]);

  /**
   * Enter on the canvas (MA-05): edit the selected text in place, step into a
   * selected group, or say why neither applies. It is bound in the keyboard map
   * and used to do nothing at all.
   */
  const enterSelection = useCallback((): boolean => {
    if (selection.selectedIds.length !== 1) {
      if (selection.selectedIds.length > 1) flash("Select one object to edit its text.");
      return selection.selectedIds.length > 1;
    }
    const id = selection.selectedIds[0]!;
    const element = resolveElementById(doc, id)?.element;
    if (element && isGroup(element) && element.locked !== true) {
      const first = element.children[0]?.id;
      setSelection((current) => ({
        ...enterGroup(current, id),
        ...(first ? { selectedIds: [first], primaryId: first } : {}),
      }));
      return true;
    }
    const refusal = textEditRefusal(element);
    if (refusal) {
      flash(refusal);
      return true;
    }
    setSelection((current) => ({ ...current, selectedIds: [id], primaryId: id, editingTextId: id }));
    return true;
  }, [doc, flash, selection.selectedIds, setSelection]);

  const reorder = useCallback(
    (direction: ReorderDirection) => {
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
        const current = flag === "locked" ? found.element.locked === true : found.element.visible !== false;
        return setProperty(doc, id, flag, !current);
      });
      apply(operations, { label: flag === "locked" ? "Lock" : "Hide" });
    },
    [apply, doc, selection.selectedIds],
  );

  // --------------------------------------------------------- clipboard, drop

  /**
   * Put a clipboard or drop payload on the current slide (MA-23). Each thing
   * inserted is one patch: pasted objects together, each picture on its own
   * (it is uploaded on its own), text as one box.
   */
  const insertTransfer = useCallback(
    async (transfer: Transfer, at?: { x: number; y: number }) => {
      if (!slide) return;
      switch (transfer.kind) {
        case "objects": {
          const { operations, elementIds } = pasteElements(doc, transfer.payload, {
            targetSlideId: slide.id,
            ...(at ? { at } : {}),
          });
          apply(operations, { label: "Paste", selectionAfter: elementIds });
          return;
        }
        case "text": {
          const { operations, elementId } = pastedTextOperations(doc, slide.id, transfer.content, at);
          apply(operations, { label: "Paste text", selectionAfter: [elementId] });
          return;
        }
        case "images": {
          if (transfer.refused.length > 0) {
            flash(`${transfer.refused.join(", ")} could not be added: only pictures go on a slide.`);
          }
          setUploadError(null);
          // Each picture's patch is an append to the manifest and to the slide,
          // addressed by id, so the document the first was computed against is
          // as good as any for the next.
          for (const file of transfer.files) {
            try {
              const { operations, elementId } = await uploadAndInsertImage(client, {
                document: doc,
                slideId: slide.id,
                file,
                ...(at ? { at } : {}),
              });
              apply(operations, { label: "Add image", selectionAfter: [elementId] });
            } catch (caught) {
              setUploadError(caught instanceof Error ? caught.message : `${file.name || "That picture"} could not be added.`);
            }
          }
          return;
        }
        case "refused":
          flash(transfer.message);
          return;
        case "empty":
          // Nothing the system clipboard offered; the in-window copy still works
          // where a browser withholds clipboard data.
          if (clipboard) {
            const { operations, elementIds } = pasteElements(doc, clipboard, { targetSlideId: slide.id });
            apply(operations, { label: "Paste", selectionAfter: elementIds });
          } else {
            flash("There is nothing on the clipboard that can go on a slide.");
          }
          return;
      }
    },
    [apply, client, clipboard, doc, flash, slide],
  );

  useEffect(() => {
    if (presenting) return;
    const onCanvas = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        return false;
      }
      return !(active instanceof Element) || active === document.body || active.closest("[data-editor-canvas]") !== null;
    };
    const onCopy = (event: ClipboardEvent) => {
      if (!onCanvas()) return;
      const payload = copyElements(doc, selection.selectedIds);
      if (!payload) return;
      setClipboard(payload);
      if (event.clipboardData) {
        writeClipboard(event.clipboardData, payload);
        event.preventDefault();
      }
      if (event.type === "cut") deleteSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!onCanvas()) return;
      event.preventDefault();
      const transfer = classifyTransfer(event.clipboardData, parseDetached);
      void insertTransfer(transfer);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [deleteSelection, doc, insertTransfer, presenting, selection.selectedIds]);

  /** A file dropped on the canvas lands where it was dropped. */
  const onDropFiles = useCallback(
    (event: React.DragEvent) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      const canvas = document.querySelector<HTMLElement>("[data-editor-canvas]");
      const rect = canvas?.getBoundingClientRect();
      const at =
        rect && rect.width > 0
          ? {
              x: ((event.clientX - rect.left) / rect.width) * doc.viewport.width,
              y: ((event.clientY - rect.top) / rect.height) * doc.viewport.height,
            }
          : undefined;
      void insertTransfer(classifyTransfer(event.dataTransfer, parseDetached), at);
    },
    [doc.viewport.height, doc.viewport.width, insertTransfer],
  );

  // ----------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A widget already handled this key — an arrow moving the mode switch, a
      // menu, a select. Without this, ArrowRight on the mode switch would also
      // nudge the selected object: the widget's handler runs first (React
      // listens at the root) and marks the event, and this listener is on the
      // window, after it.
      if (event.defaultPrevented) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      // F6 / Shift+F6: the next part of the window (lib/regions.ts). Works while
      // typing too, because it is how a keyboard user gets out of a field.
      if (event.key === "F6" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (focusNextRegion(document, event.shiftKey)) event.preventDefault();
        return;
      }

      // Panel shortcuts work anywhere, typing included: hiding the side panel
      // while writing a note is exactly when someone wants the room.
      const nextPanels = panelsForKey(event, panelsRef.current);
      if (nextPanels) {
        event.preventDefault();
        setPanels(nextPanels);
        return;
      }

      const resolved = resolveCommand(event);
      if (!resolved) return;

      // Otherwise typing "d" in a text box duplicates the element.
      if (typing && !isAllowedWhileTyping(resolved.command)) return;

      // Canvas commands act on the canvas selection, so they apply only while
      // the canvas has focus (or nothing does). Caught on the whole window, Tab
      // on any button selected the next object instead of moving focus, and a
      // keyboard user could not Tab out of anything.
      const onCanvas =
        !(target instanceof Element) || target === document.body || target.closest("[data-editor-canvas]") !== null;
      if (commandScope(resolved.command) === "canvas" && !onCanvas) return;

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
        case "cut":
        case "paste":
          // Left to the browser, which turns the keys into `copy`, `cut` and
          // `paste` events carrying the system clipboard (handled below). A
          // keydown handler that did the work itself had to prevent the
          // default, and with it the only access to what other programs — and
          // other decks — had copied (MA-23).
          handled = false;
          break;
        case "selectAll":
          setSelection((current) => selectAllElements(current, index, order));
          break;
        case "group":
          group();
          break;
        case "ungroup":
          ungroup();
          break;
        case "enterTextEdit":
          handled = enterSelection();
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
        case "cyclePrevious": {
          const direction = command === "cycleNext" ? 1 : -1;
          // Past the last object (or before the first), Tab moves focus on
          // rather than wrapping: a cycle with no exit is a keyboard trap.
          if (cycleLeavesScope(selection, index, order, direction)) {
            handled = false;
            break;
          }
          setSelection((current) => cycleSelection(current, index, order, direction));
          break;
        }
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
    enterSelection,
    flash,
    group,
    index,
    nudge,
    order,
    reorder,
    selection,
    selection.selectedIds,
    setSelection,
    slide,
    toggleFlag,
    ungroup,
  ]);

  if (presenting) {
    return (
      <PresentMode
        scene={scene}
        onExit={() => setPresenting(false)}
        initialSlide={slideIndex}
        // The shell has the document, which is where storage keys live; present
        // mode has only a scene. A deck whose pictures appear while editing and
        // vanish on the projector would be worse than one that never showed them.
        resolveAssetUrl={resolveAssetUrl}
        // Scoped to the deck, so two decks presented at once do not drive each
        // other's second screen.
        channelName={`deckastra-present-${props.presentationId}`}
        {...(props.openPresenter ? { openPresenter: props.openPresenter } : {})}
      />
    );
  }

  if (!editor.recoveryReady) {
    return (
      <div className="dk-root dk-shell dk-shell--message">
        <p role="status">Loading saved edits…</p>
      </div>
    );
  }
  if (!slide) {
    return (
      <div className="dk-root dk-shell dk-shell--message">
        <ConflictRecovery editor={editor} />
        <p>This deck has no slides.</p>
      </div>
    );
  }

  const selected = selection.primaryId ? resolveElementById(doc, selection.primaryId) : undefined;

  const rightPanel = colors.open && mode === "design" ? (
    // Docked in the panel rather than floating over it (design review,
    // 2026-09-26): the slide stays in view and nothing is covered.
    <ColorStudioPanel editor={editor} open focus={colors.focus} onClose={() => setColors({ open: false })} />
  ) :
    mode === "ai" ? (
      <AiPanel editor={editor} presentationId={props.presentationId} />
    ) : mode === "code" ? (
      <CodePanel editor={editor} />
    ) : mode === "motion" ? (
      <MotionModePanel editor={editor} presentationId={props.presentationId} scene={scene} resolveAssetUrl={resolveAssetUrl} />
    ) : (
      <Inspector
        editor={editor}
        presentationId={props.presentationId}
        selected={selected?.element}
        onReorder={reorder}
        onToggle={toggleFlag}
        onGroup={group}
        onUngroup={ungroup}
        onDelete={deleteSelection}
        onOpenHistory={() => setHistoryOpen(true)}
      />
    );

  const colorStudio: ColorStudio = {
    document: editor.document,
    apply: (operations, label) => {
      if (operations.length) editor.apply(operations, { label });
    },
    open: (focus) => {
      setMode("design");
      setColors({ open: true, ...(focus ? { focus } : {}) });
    },
  };

  return (
    <ColorStudioProvider value={colorStudio}>
    <div className="dk-root dk-shell" data-editor-mode={mode}>
      <AppBar
        editor={editor}
        presentationId={props.presentationId}
        mode={mode}
        onMode={setMode}
        onPresent={() => setPresenting(true)}
        onExit={exit ? () => exit() : undefined}
        extras={props.barExtras}
        panels={{ visibility: panels, onChange: setPanels }}
        onHistory={() => setHistoryOpen(true)}
      />

      <ConflictRecovery editor={editor} />

      {props.notices}
      {notice ? (
        <div className="dk-banner dk-banner--notice" role="status">
          {notice}
        </div>
      ) : null}
      {editor.restoredVersion ? (
        // Kept until dismissed or undone: a restore replaces the whole deck, and
        // the toolbar's undo cannot reach past it (its history was cleared,
        // because its inverses described a document no longer on screen).
        <div className="dk-banner dk-banner--notice dk-banner--actions" role="status" data-testid="restore-banner">
          <span>Restored an earlier version. Your previous version is still in the history.</span>
          <Button
            size="sm"
            variant="ghost"
            data-testid="undo-restore"
            onClick={() => {
              setRestoreRefusal(null);
              void editor.undoRestore().then((answer) => {
                if (!answer.ok) setRestoreRefusal(answer.message ?? "The restore could not be undone.");
              });
            }}
          >
            Undo restore
          </Button>
          {restoreRefusal ? <span>{restoreRefusal}</span> : null}
        </div>
      ) : null}
      {uploadError ? (
        <div className="dk-banner dk-banner--danger" role="alert">
          {uploadError}
        </div>
      ) : null}

      {/* Applies the sampled styles to the canvas's real elements. It renders
          nothing; the motion it drives is the editor's own DOM.

          Unmounted while presenting: present mode drives the same elements from
          its own adapter, and two adapters writing the same styles is a race. */}
      {slideScene ? (
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

      <div className="dk-shell__body">
        {panels.tools ? (
          <ToolRail
            onAdd={(kind) => addStarter(kind)}
            onAddImage={addImage}
            onPanel={togglePanel}
            open={side.panel}
            libraryTab={side.tab}
            checkCount={findings.filter((finding) => finding.slideId === slide?.id && finding.code !== "THEME").length}
          />
        ) : null}
        {side.panel === "library" ? (
          <AddLibrary
            tab={side.tab}
            onTab={(tab) => setSide({ panel: "library", tab })}
            onClose={() => setSide((current) => ({ ...current, panel: undefined }))}
            onAddImage={addImage}
            document={doc}
            apply={(operations, label) => apply(operations, { label })}
            onAdd={(item) =>
              item.kind === "shape"
                ? addStarter("shape", item.shape)
                : item.kind === "line"
                  ? addStarter("line")
                  : item.kind === "icon"
                    ? addStarter("icon", undefined, item.name, item.set)
                    : addStarter(item.object)
            }
          />
        ) : side.panel === "layers" ? (
          <aside className="dk-library" aria-label="Layers" data-region="library" data-testid="layers-panel">
            <div className="dk-library__head">
              <h3 className="dk-library__title">Layers</h3>
              <IconButton icon="close" label="Close layers" size="sm" onClick={() => setSide((current) => ({ ...current, panel: undefined }))} />
            </div>
            <p className="dk-field__hint">Everything on this slide, front to back. Pick one to select it.</p>
            <LayersList editor={editor} />
          </aside>
        ) : side.panel === "check" ? (
          <aside className="dk-library" aria-label="Design check" data-region="library" data-testid="check-panel">
            <div className="dk-library__head">
              <h3 className="dk-library__title">Design check</h3>
              <IconButton icon="close" label="Close check" size="sm" onClick={() => setSide((current) => ({ ...current, panel: undefined }))} />
            </div>
            <p className="dk-field__hint">Overlaps, text that does not fit or is too small, contrast, the safe area, descriptions, and what changes in PowerPoint.</p>
            <DesignCheckPanel
              document={doc}
              slideId={slide.id}
              findings={findings}
              measurer={measurer}
              apply={(operations, label) => apply(operations, { label })}
              onSelect={(targetSlideId, elementId) => {
                const targetIndex = doc.slides.findIndex((candidate) => candidate.id === targetSlideId);
                if (targetIndex < 0) return;
                editor.setSlideIndex(targetIndex);
                if (elementId) editor.setSelection((current) => ({ ...current, selectedIds: [elementId], primaryId: elementId }));
              }}
            />
          </aside>
        ) : null}
        {panels.slides ? (
        <SlideStrip
          editor={editor}
          scene={scene}
          resolveAssetUrl={resolveAssetUrl}
          onAdd={() => apply(createSlide(doc).operations, { label: "Add slide" })}
          onNotice={flash}
          onTransition={(target) => {
            editor.setSlideIndex(target);
            setMode("motion");
          }}
        />
        ) : null}

        <main className="dk-shell__center" aria-label="Slide editor">
          {scrubbing ? (
            // Said, with a way out: the canvas is showing the slide part-way
            // through its motion, which is not the slide being edited.
            <div className="dk-banner dk-banner--notice dk-banner--actions" role="status" data-testid="motion-preview-banner">
              <span>Showing the slide part-way through its motion. Some objects may be hidden or moved.</span>
              <Button size="sm" variant="ghost" onClick={stopPreview} data-testid="stop-motion-preview">
                Back to editing
              </Button>
            </div>
          ) : null}
          {/* A press on the canvas is the start of an edit, and ends the preview
              first, so the gesture lands on the slide as it really is. */}
          <div
            className="dk-shell__canvas-wrap"
            onPointerDownCapture={scrubbing ? stopPreview : undefined}
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.types).includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={onDropFiles}
          >
            <CanvasStage editor={editor} zoom={zoom} onZoom={setZoom} />
          </div>

          {/* Under the slide they belong to, as in the Figma frame: notes are
              written while looking at the slide, not in a side panel. */}
          {panels.notes ? <SpeakerNotes editor={editor} /> : null}

          {/* Under the canvas, not in the side panel: a timeline is horizontal
              and an author needs to see the slide while scrubbing it. Taller in
              Motion mode, where it is the work. */}
          {slideScene && panels.dock ? (
            <section className="dk-dock" aria-label="Motion timeline" data-region="timeline" style={{ height: dockHeightFor(mode) }}>
              <MotionPanel
                document={doc}
                scene={slideScene}
                slideIndex={slideIndex}
                selectedIds={selection.selectedIds}
                apply={(operations, label) => apply(operations as never, { label })}
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
            </section>
          ) : null}
        </main>

        <VersionHistory
          editor={editor}
          presentationId={props.presentationId}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />


        {panels.inspector ? (
          <aside className="dk-panel" data-region="panel" aria-label={mode === "ai" ? "AI" : mode === "code" ? "Code" : mode === "motion" ? "Motion" : "Inspector"}>
            {rightPanel}
          </aside>
        ) : null}
      </div>
    </div>
    </ColorStudioProvider>
  );
}

/** Parse pasted markup detached: never connected, so nothing in it can load, run or observe anything. */
function parseDetached(markup: string): Node {
  const scratch = document.createElement("div");
  scratch.innerHTML = markup;
  return scratch;
}
