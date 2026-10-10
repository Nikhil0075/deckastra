"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { isGroup, type AnimationTrack, type PresentationElement, type ShapeKind } from "@deckastra/presentation-schema";
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
import { type EditorMode, type Zoom } from "../lib/editor-layout";
import { dockBodyHeight, loadDock, saveDock, type DockLayout, type DockState } from "../lib/dock";

import { ConflictRecovery } from "./ConflictRecovery";
import { MotionPanel } from "./MotionPanel";
import { MotionPreview } from "./MotionPreview";
import { Inspector, type ReorderDirection } from "./inspector/Inspector";
import { AppBar } from "./shell/AppBar";
import type { AccountIdentity } from "./shell/AccountMenu";
import { CanvasStage } from "./shell/CanvasStage";
import { AssistantPanel } from "./AssistantPanel";
import { MotionModePanel } from "./shell/MotionModePanel";
import { NarrationPanel } from "./NarrationPanel";
import { SlideStrip } from "./shell/SlideStrip";
import { SpeakerNotes } from "./shell/SpeakerNotes";
import { ToolRail } from "./shell/ToolRail";
import { ALL_VISIBLE, DOCK_PANELS, PANELS, dockPanelShown, isFocused, loadPanels, panelsForCommand, panelsForKey, savePanels, type Chrome, type PanelVisibility } from "../lib/panels";
import {
  ASSISTANT,
  DEFAULT_SIZES,
  INSPECTOR,
  STRIP,
  dockHeight,
  dockLimits,
  fitLayout,
  loadLayout,
  saveLayout,
  sidePanelShows,
  withDock,
  type LayoutSizes,
} from "../lib/layout-sizes";
import { useProposals } from "../lib/use-proposals";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { Dock } from "./shell/Dock";
import { CommandPalette } from "./shell/CommandPalette";

import type { OpenPresenterWindow } from "@deckastra/workspace-contracts";

import { useEditor, type UseEditorInput } from "../lib/useEditor";
import { PresentMode } from "./PresentMode";
import { saveAnnotatedCopy } from "../lib/ink-annotations";
import { VersionHistory } from "./VersionHistory";
import { ColorStudioPanel } from "./ColorStudioPanel";
import { AddLibrary, type LibraryTab } from "./shell/AddLibrary";
import type { SidePanel } from "./shell/ToolRail";
import { LayersList } from "./inspector/LayersList";
import { DesignCheckPanel } from "./DesignCheckPanel";
import { designCheck } from "../lib/design-check";
import { ColorStudioProvider, type ColorStudio } from "../lib/color-studio";
import { Button, IconButton, Splitter, type MenuItem } from "../ui";
import { languageLabel } from "../lib/languages";

// CodeMirror is the heaviest mode-only dependency. Keep it out of the normal
// design/AI/motion path and fetch it only when Code is actually opened.
const CodePanel = lazy(() => import("./shell/CodePanel").then((module) => ({ default: module.CodePanel })));

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
  /** Open the host's Settings (roadmap 08 §1.3). Absent: the palette does not offer it. */
  onOpenSettings?: () => void;
  /** Who is signed in, and signing out, for the bar's account menu. */
  account?: { identity?: AccountIdentity | null; onSignOut?: () => void };
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
  /** Optional richer authoring supplied by a host. The web editor passes none. */
  motionAuthoring?: MotionAuthoringExtension;
}

export interface MotionAuthoringPanelProps {
  editor: ReturnType<typeof useEditor>;
  presentationId: string;
  scene: ReturnType<typeof buildDocumentScene>;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  preview: (tracks?: AnimationTrack[]) => void;
}

export interface MotionAuthoringExtension {
  Panel: ComponentType<MotionAuthoringPanelProps>;
  /** Optional editor-only chrome drawn in slide coordinates. */
  CanvasOverlay?: ComponentType<Omit<MotionAuthoringPanelProps, "preview">>;
  presetNames: readonly string[];
}

export function EditorShell(props: EditorShellProps) {
  const editor = useEditor(props);
  const { document: doc, slideIndex, selection, setSelection, apply, nodes } = editor;

  const client = useWorkspaceClient();
  // Stable, so the Audio lanes' waveform effect does not re-run on every render.
  const loadAudio = useCallback((storageKey: string) => client.assets.fetchBlob(storageKey), [client]);
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
  // Proposals and paid language/media services sit beside any mode.
  const [assistantOpen, setAssistantOpen] = useState(false);
  // The Review view (UI audit unit 4): agents' pending changes, compared at a
  // size that can be read, in place of the canvas until closed.
  const [review, setReview] = useState<{ open: boolean; proposalId?: string }>({ open: false });
  // How many changes wait, for the bar's Review button: one read of the list,
  // polled like the Assistant's own. Up here with the other hooks, above any
  // early return.
  const pending = useProposals({
    presentationId: props.presentationId,
    currentVersionId: editor.currentVersionId,
    onApplied: editor.adoptDocument,
    saveNow: editor.saveNow,
  });
  const pendingCount = pending.proposals?.length ?? 0;
  const openAssistant = useCallback(() => {
    setColors({ open: false });
    setAssistantOpen(true);
  }, []);
  // The command palette (Ctrl+K). Present mode has its own keys and no palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const presentingRef = useRef(false);
  // Its Languages section, opened from the bar's language menu.
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("fit");
  // The motion playhead. Editor state, not document state — where the author has
  // scrubbed to is exactly the kind of thing doc 02 §4.1 keeps out of the file.
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(0);
  // Whether the author has asked to see the motion. Until they do the canvas
  // shows the slide at rest — see MotionPreview for why.
  const [scrubbing, setScrubbing] = useState(false);
  const [previewTracks, setPreviewTracks] = useState<AnimationTrack[] | undefined>();

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
    setPreviewTracks(undefined);
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
  // The dock under the canvas, remembered per mode (lib/dock.ts): closed while
  // designing, open on the timeline in Motion.
  const [dockLayout, setDockLayout] = useState<DockLayout>(() => loadDock());
  const dock = dockLayout[mode];
  // Through a ref, so the keyboard handler (subscribed once) writes the dock
  // of the mode on screen now, not the mode it was subscribed in.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const setDock = useCallback((next: DockState) => {
    setDockLayout((current) => {
      const layout = { ...current, [modeRef.current]: next };
      saveDock(layout);
      return layout;
    });
  }, []);
  const chrome: Chrome = { panels, dock };
  const setChrome = useCallback(
    (next: Chrome) => {
      setPanels(next.panels);
      setDock(next.dock);
    },
    [setPanels, setDock],
  );
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  // How wide the strip and the side panel are, and how tall the dock is
  // (lib/layout-sizes.ts, UI audit unit 3): chosen by dragging a splitter,
  // remembered per browser profile, never written to the deck.
  const [sizes, setSizesState] = useState<LayoutSizes>(() => loadLayout());
  const setSizes = useCallback((next: LayoutSizes) => {
    setSizesState(next);
    saveLayout(next);
  }, []);
  const [windowSize, setWindowSize] = useState(() =>
    typeof window === "undefined" ? { width: 1440, height: 900 } : { width: window.innerWidth, height: window.innerHeight },
  );
  useEffect(() => {
    const onResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // A drag shows itself by setting the shell's variables directly, so the
  // editor is not re-rendered every frame; the release commits through state.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const previewSize = useCallback((variable: string, value: number) => {
    shellRef.current?.style.setProperty(variable, `${value}px`);
  }, []);

  const onCommand = useRef<(command: HostCommand) => void>(() => {});
  onCommand.current = (command) => {
    const theme = themeForCommand(command);
    if (theme) {
      setThemePreference(theme);
      return;
    }
    if (presenting) return;
    const nextPanels = panelsForCommand(command, chromeRef.current);
    if (nextPanels) {
      setChrome(nextPanels);
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
      case "assistant":
        openAssistant();
        break;
      case "command-palette":
        setPaletteOpen(true);
        break;
      case "layout-reset":
        // Every pane back, at its default size: the way out of a layout that
        // has got into a state someone cannot make sense of.
        setSizes({ ...DEFAULT_SIZES, dock: {} });
        setPanels({ ...ALL_VISIBLE });
        break;
      case "open-settings":
        props.onOpenSettings?.();
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
        setAssistantOpen(false);
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
      const nextPanels = panelsForKey(event, chromeRef.current);
      if (nextPanels) {
        event.preventDefault();
        setChrome(nextPanels);
        return;
      }

      // Ctrl+K: the command palette, from anywhere, typing included — it is
      // how someone who does not know where a thing lives finds it.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        if (presentingRef.current) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
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

  presentingRef.current = presenting;
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
        // The talk's ink as a new deck: never this one, which stays as presented.
        onSaveInk={async (strokes) => {
          if (strokes.size === 0) return "There is no ink to save yet.";
          const saved = await saveAnnotatedCopy(client, {
            presentationId: props.presentationId,
            presentedSlideIds: scene.slides.map((one) => one.slideId),
            strokes,
            saveNow: editor.saveNow,
          });
          return `Saved a copy with the annotations: “${saved.title}”, in this deck's project.`;
        }}
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

  // The Assistant has a column of its own (UI audit unit 4) rather than taking
  // over the side panel: a wide window shows both, a narrow one puts the side
  // panel away while the Assistant is open (`sidePanelShows`).
  const assistantPanel = assistantOpen ? (
    <AssistantPanel
      editor={editor}
      presentationId={props.presentationId}
      resolveAssetUrl={resolveAssetUrl}
      languagesOpen={languagesOpen}
      onLanguagesOpen={setLanguagesOpen}
      onClose={() => setAssistantOpen(false)}
      onReview={(proposalId) => setReview({ open: true, proposalId })}
      onVoiceOpen={() => {
        setAssistantOpen(false);
        setMode("motion");
        setPanels({ ...panels, inspector: true });
      }}
      onMediaOpen={() => {
        setAssistantOpen(false);
        setSide({ panel: "library", tab: "media" });
        setPanels({ ...panels, tools: true });
      }}
    />
  ) : null;

  const rightPanel = colors.open && mode === "design" ? (
    // Docked in the panel rather than floating over it (design review,
    // 2026-09-26): the slide stays in view and nothing is covered.
    <ColorStudioPanel editor={editor} open focus={colors.focus} onClose={() => setColors({ open: false })} />
  ) :
    mode === "code" ? (
      <Suspense fallback={<div className="dk-modepanel dk-code dk-muted">Opening JSON editor…</div>}>
        <CodePanel editor={editor} />
      </Suspense>
    ) : mode === "motion" ? (
      <div className="dk-modepanel">
      {/* Above whichever motion panel the host supplies: narration is what a
          narrated slide is paced by, and below the transition and planning
          sections it was a scroll away (integration plan 01 §3.3). */}
      <NarrationPanel editor={editor} presentationId={props.presentationId} scene={scene} resolveAssetUrl={resolveAssetUrl} />
      {props.motionAuthoring ? (
        <props.motionAuthoring.Panel
          editor={editor}
          presentationId={props.presentationId}
          scene={scene}
          resolveAssetUrl={resolveAssetUrl}
          preview={(tracks) => {
            if (!tracks) {
              stopPreview();
              return;
            }
            setPreviewTracks(tracks);
            setScrubbing(true);
            setPlayheadMs(0);
            setPlaying((count) => count + 1);
          }}
        />
      ) : <MotionModePanel editor={editor} presentationId={props.presentationId} scene={scene} resolveAssetUrl={resolveAssetUrl} />}
      </div>
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
      setAssistantOpen(false);
      setColors({ open: true, ...(focus ? { focus } : {}) });
    },
  };

  // What the window can hold of the chosen sizes (lib/layout-sizes.ts): a
  // narrow window takes the panes toward their minimums and then puts the strip
  // away for now, without forgetting what was chosen.
  const sidePanelShown = sidePanelShows(panels.inspector, assistantOpen, windowSize.width);
  const fitted = fitLayout(sizes, windowSize.width, {
    tools: panels.tools,
    library: Boolean(side.panel),
    slides: panels.slides,
    inspector: sidePanelShown,
    assistant: assistantOpen,
  });
  const dockBody = dockHeight(sizes, mode, dock.tab, windowSize.height);
  const shellStyle = {
    "--dk-strip-width": `${fitted.strip}px`,
    "--dk-inspector-width": `${fitted.inspector}px`,
    "--dk-dock-height": `${dockBody}px`,
    "--dk-assistant-width": `${Math.round(Math.min(ASSISTANT.max, Math.max(ASSISTANT.min, sizes.assistant)))}px`,
  } as React.CSSProperties;
  const layoutItems: MenuItem[] = [
    ...PANELS.map(({ name, label, shortcut }) => ({
      id: `layout-${name}`,
      label,
      kind: "checkbox" as const,
      checked: panels[name],
      shortcut,
      onSelect: () => onCommand.current(`panel-${name}` as HostCommand),
    })),
    ...DOCK_PANELS.map(({ tab, label, shortcut }) => ({
      id: `layout-${tab}`,
      label,
      kind: "checkbox" as const,
      checked: dockPanelShown(chrome, tab),
      shortcut,
      onSelect: () => onCommand.current(tab === "notes" ? "panel-notes" : "panel-dock"),
    })),
    { id: "layout-focus", label: "Focus on the slide", kind: "checkbox", checked: isFocused(chrome), shortcut: "Ctrl+.", onSelect: () => onCommand.current("panels-focus") },
    { id: "layout-all", label: "Show everything", onSelect: () => onCommand.current("panels-all") },
    { id: "layout-reset", label: "Reset workspace", icon: "undo", onSelect: () => onCommand.current("layout-reset") },
  ];

  return (
    <ColorStudioProvider value={colorStudio}>
    <div
      ref={shellRef}
      className="dk-root dk-shell"
      style={shellStyle}
      data-editor-mode={mode}
      data-presentation-id={props.presentationId}
      data-document-version={editor.currentVersionId()}
      data-strip-collapsed={fitted.stripCollapsed ? "true" : undefined}
    >
      <AppBar
        editor={editor}
        presentationId={props.presentationId}
        mode={mode}
        onMode={setMode}
        onPresent={() => setPresenting(true)}
        onExit={exit ? () => exit("all-decks") : undefined}
        extras={props.barExtras}
        account={{ ...props.account, onOpenSettings: props.onOpenSettings }}
        onHistory={() => setHistoryOpen(true)}
        layout={{ focused: isFocused(chrome), onFocus: () => onCommand.current("panels-focus"), items: layoutItems }}
        review={{
          count: pendingCount,
          open: review.open,
          onToggle: () => setReview((current) => ({ open: !current.open })),
        }}
        assistantOpen={assistantOpen}
        onAssistant={() => (assistantOpen ? setAssistantOpen(false) : openAssistant())}
        onManageLanguages={() => {
          openAssistant();
          setLanguagesOpen(true);
        }}
      />

      <ConflictRecovery editor={editor} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        // The menu's dispatcher, so the palette and the menu mean one thing.
        onCommand={(command) => onCommand.current(command)}
        onAsk={() => {}}
        canExit={Boolean(exit)}
        canOpenSettings={Boolean(props.onOpenSettings)}
      />

      {props.notices}
      {editor.locale ? (
        // Said while it is true: in a language, typing writes that language's
        // words, and everything else is shared by every language (plan 01 §3.2).
        <div className="dk-banner dk-banner--notice dk-banner--actions" role="status" data-testid="locale-banner">
          <span dir="auto">
            Showing {languageLabel(editor.locale)}. Typing changes the {languageLabel(editor.locale).split(" · ")[0]} words; moving,
            resizing and styling change every language.
          </span>
          <Button size="sm" variant="ghost" onClick={() => editor.setLocale(null)} data-testid="locale-banner-original">
            Show original
          </Button>
        </div>
      ) : null}
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
          tracksOverride={previewTracks}
        />
      ) : null}

      {review.open ? (
        <div className="dk-shell__body">
          <ReviewWorkspace
            editor={editor}
            presentationId={props.presentationId}
            initialProposalId={review.proposalId}
            onClose={() => setReview({ open: false })}
            onCount={() => void pending.refresh()}
          />
        </div>
      ) : (
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
            presentationId={props.presentationId}
            afterSlideId={slide?.id}
            currentVersionId={editor.currentVersionId}
            saveNow={editor.saveNow}
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
        {panels.slides && !fitted.stripCollapsed ? (
          <>
            <SlideStrip
              editor={editor}
              scene={scene}
              resolveAssetUrl={resolveAssetUrl}
              width={fitted.strip}
              onAdd={() => apply(createSlide(doc).operations, { label: "Add slide" })}
              onNotice={flash}
              onTransition={(target) => {
                editor.setSlideIndex(target);
                setMode("motion");
              }}
            />
            <Splitter
              label="Slides width"
              orientation="vertical"
              value={fitted.strip}
              min={STRIP.min}
              max={STRIP.max}
              defaultValue={STRIP.default}
              grows={1}
              onPreview={(value) => previewSize("--dk-strip-width", value)}
              onChange={(value) => setSizes({ ...sizes, strip: value })}
              data-testid="splitter-strip"
            />
          </>
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
            <CanvasStage
              editor={editor}
              zoom={zoom}
              onZoom={setZoom}
              overlay={mode === "motion" && props.motionAuthoring?.CanvasOverlay
                ? <props.motionAuthoring.CanvasOverlay
                    editor={editor}
                    presentationId={props.presentationId}
                    scene={scene}
                    resolveAssetUrl={resolveAssetUrl}
                  />
                : undefined}
            />
          </div>

          {/* Notes and the timeline, as tabs of one dock under the slide
              (lib/dock.ts): notes are written while looking at the slide, and a
              timeline is horizontal and scrubbed while watching it. Closed while
              designing, so the slide has the window; open in Motion, where the
              timeline is the work. */}
          <Dock
            state={dock}
            onChange={setDock}
            height={dockBody}
            resizer={
              <Splitter
                label="Dock height"
                orientation="horizontal"
                value={dockBody}
                {...dockLimits(windowSize.height)}
                defaultValue={dockBodyHeight(mode, dock.tab)}
                grows={-1}
                onPreview={(value) => previewSize("--dk-dock-height", value)}
                onChange={(value) => setSizes(withDock(sizes, mode, dock.tab, value, windowSize.height))}
                data-testid="splitter-dock"
              />
            }
            panels={{
              notes: <SpeakerNotes editor={editor} />,
              timeline: slideScene ? (
                <div className="dk-dock">
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
                    presetNames={props.motionAuthoring?.presetNames}
                    showAddAnimation={!props.motionAuthoring}
                    loadAudio={loadAudio}
                  />
                </div>
              ) : null,
            }}
          />
        </main>

        <VersionHistory
          editor={editor}
          presentationId={props.presentationId}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />


        {/* The assistant shows even with the side panel put away: asking for it
            is asking for this region back. */}
        {sidePanelShown ? (
          <Splitter
            label="Side panel width"
            orientation="vertical"
            value={fitted.inspector}
            min={INSPECTOR.min}
            max={INSPECTOR.max}
            defaultValue={INSPECTOR.default}
            grows={-1}
            onPreview={(value) => previewSize("--dk-inspector-width", value)}
            onChange={(value) => setSizes({ ...sizes, inspector: value })}
            data-testid="splitter-panel"
          />
        ) : null}
        {sidePanelShown ? (
          <aside className="dk-panel" data-region="panel" aria-label={mode === "code" ? "Code" : mode === "motion" ? "Motion" : "Inspector"}>
            {rightPanel}
          </aside>
        ) : null}
        {assistantPanel ? (
          <>
            <Splitter
              label="Assistant width"
              orientation="vertical"
              value={Math.round(Math.min(ASSISTANT.max, Math.max(ASSISTANT.min, sizes.assistant)))}
              min={ASSISTANT.min}
              max={ASSISTANT.max}
              defaultValue={ASSISTANT.default}
              grows={-1}
              onPreview={(value) => previewSize("--dk-assistant-width", value)}
              onChange={(value) => setSizes({ ...sizes, assistant: value })}
              data-testid="splitter-assistant"
            />
            <aside className="dk-panel dk-panel--assistant" data-region="assistant" aria-label="Assistant">
              {assistantPanel}
            </aside>
          </>
        ) : null}
      </div>
      )}
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
