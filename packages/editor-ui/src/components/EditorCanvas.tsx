"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  PresentationDocument,
  Rect,
  Transform,
} from "@deckastra/presentation-schema";
import {
  FrameSampler,
  IDENTITY,
  buildDocumentScene,
  flattenScene,
  localMatrix,
  multiply,
  transformedBounds,
  type Matrix,
} from "@deckastra/renderer";
import { useAssetUrls } from "../lib/asset-urls";
import type { FrameStats } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";
import { setProperty, resolveElementById } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";
import {
  HANDLES,
  MAX_NEIGHBOURS,
  SpatialIndex,
  buildIndex,
  click as clickSelection,
  collectSnapLines,
  commitTransform,
  constrainToAxis,
  enterGroup,
  marqueeSelect,
  move as moveTransform,
  resize as resizeTransform,
  resolveClickTarget,
  rotate as rotateTransform,
  selectionBounds,
  snapRectWithSpacing,
  type HandleId,
  type SelectionState,
  type SnapLine,
  type SpacingGuide,
} from "@deckastra/editor";

import { useBrowserMeasurer } from "../lib/measurer";
import { resizeOperations } from "../lib/resize-operations";
import { TextEditor } from "./TextEditor";
import { textTargetOf } from "../lib/text-targets";
import type { EditorApi } from "../lib/useEditor";

/**
 * The interactive canvas.
 *
 * Every gesture ends in a patch — nothing here mutates the document directly, so
 * a drag is as undoable as an AI edit and for the same reason.
 *
 * Live geometry during a gesture is kept in local state (`draft`) rather than
 * being committed on every pointermove. Committing per event would push hundreds
 * of transactions for a single drag; the coalescing key on the final commit is
 * what makes one gesture one undo entry.
 */

export interface EditorCanvasProps {
  editor: EditorApi;
  /** Rendered width in CSS pixels. */
  width: number;
  showGuides?: boolean;
  gridEnabled?: boolean;
  /**
   * Called once per gesture with the measured frame times (doc 04 §31.1).
   *
   * Reported rather than logged, so the number reaches a place a person can see
   * it. An untracked budget regresses quietly.
   */
  onFrameStats?: (frames: FrameStats) => void;
}

type Gesture =
  | { kind: "none" }
  | { kind: "marquee"; origin: { x: number; y: number }; current: { x: number; y: number } }
  | {
      kind: "move";
      origin: { x: number; y: number };
      startTransforms: Map<string, Transform>;
    }
  | {
      kind: "resize";
      handle: HandleId;
      origin: { x: number; y: number };
      startTransform: Transform;
      elementId: string;
      elementType: string;
    }
  | {
      kind: "rotate";
      centre: { x: number; y: number };
      startAngle: number;
      startRotation: number;
      elementId: string;
    };

export function EditorCanvas({
  editor,
  width,
  showGuides = true,
  gridEnabled = false,
  onFrameStats,
}: EditorCanvasProps) {
  const { document: doc, slideIndex, selection, setSelection, apply, nodes } = editor;
  const slide = doc.slides[slideIndex];
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const containerRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture>({ kind: "none" });
  const [draft, setDraftState] = useState<Map<string, Transform>>(new Map());
  const draftRef = useRef(draft);
  const setDraft = useCallback((next: Map<string, Transform>) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const [guides, setGuides] = useState<SnapLine[]>([]);
  const [spacingGuides, setSpacingGuides] = useState<SpacingGuide[]>([]);
  const modifiers = useRef({ shift: false, alt: false, mod: false });
  const pointerHit = useRef<{ id?: string; clientX: number; clientY: number; moved: boolean } | undefined>(undefined);

  // Frame-time sampling for the drag budget (doc 04 §31.1: <16ms p95). Measured
  // as the interval between frames, not the duration of the handler — a handler
  // that takes 3ms but forces a synchronous layout costs 40ms of frame time, and
  // only the interval sees it.
  const sampler = useRef(new FrameSampler());

  const scale = width / doc.viewport.width;

  // Measured, not estimated: the editor has a DOM, so it uses it. A headline
  // the estimator thinks fits on two lines and the browser breaks onto three
  // overflows onto whatever is beneath it (doc 04 §6.4).
  const measurer = useBrowserMeasurer();
  const scene = useMemo(() => buildDocumentScene(doc, { measurer }), [doc, measurer]);
  // Until this was passed, every image in the product drew the renderer's
  // labelled gap: `resolveAssetUrl` is a prop `SlideView` has always taken and
  // nothing anywhere supplied.
  const resolveAssetUrl = useAssetUrls(doc);
  const slideScene = scene.slides[slideIndex];
  // Resizing changes text layout and descendant geometry. A scene-only box
  // override cannot preview that. Rebuild from the exact eventual resize patch.
  const resizePreview = useMemo(() => {
    if (gesture.kind !== "resize") return undefined;
    const next = draft.get(gesture.elementId);
    if (!next) return undefined;
    const preview = applyPatch(doc, resizeOperations(doc, gesture.elementId, next)).document;
    const slide = preview.slides[slideIndex];
    if (!slide) return undefined;
    return buildDocumentScene({ ...preview, slides: [slide] }, { measurer }).slides[0];
  }, [doc, draft, gesture, measurer, slideIndex]);

  const index = useMemo(() => buildIndex(nodes), [nodes]);

  // Rebuilt per slide. The dragged element is excluded during a gesture so it
  // cannot snap to itself, which it would do at zero distance and never move.
  const spatial = useMemo(() => {
    const built = new SpatialIndex();
    built.rebuild(nodes.map((node) => ({ id: node.id, bounds: node.bounds })));
    return built;
  }, [nodes]);

  const toWorld = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
    },
    [scale],
  );

  const transformOf = useCallback(
    (id: string): Transform | undefined => draft.get(id) ?? resolveElementById(doc, id)?.element.transform,
    [doc, draft],
  );

  /**
   * The origin of an element's parent group in world space. Transforms in the
   * document — and therefore in `draft` — are local to their parent, while the
   * canvas, the snap lines and the selection overlay are all world space.
   */
  const offsetOf = useCallback(
    (id: string): { x: number; y: number } => index.get(id)?.offset ?? { x: 0, y: 0 },
    [index],
  );

  useEffect(() => {
    const track = (event: KeyboardEvent) => {
      modifiers.current = {
        shift: event.shiftKey,
        alt: event.altKey,
        mod: event.metaKey || event.ctrlKey,
      };
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
    };
  }, []);

  // ------------------------------------------------------------- pointer down

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      // A pointer-down anywhere while editing commits the edit; the editable's
      // own blur handles it, and starting a drag underneath would fight it.
      if (selection.editingTextId) return;
      const world = toWorld(event);

      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-element-id]");
      const hitId = target?.dataset.elementId;
      pointerHit.current = { id: hitId, clientX: event.clientX, clientY: event.clientY, moved: false };

      if (!hitId) {
        setSelection((current) => ({ ...current, selectedIds: [], primaryId: undefined }));
        setGesture({ kind: "marquee", origin: world, current: world });
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        return;
      }

      const next = clickSelection(selection, index, hitId, {
        additive: event.shiftKey,
        deep: event.altKey,
      });
      setSelection(next);

      const ids = next.selectedIds;
      if (ids.length === 0) return;

      const starts = new Map<string, Transform>();
      for (const id of ids) {
        const found = resolveElementById(doc, id);
        if (found) starts.set(id, found.element.transform);
      }

      for (const id of ids) spatial.exclude(id);
      sampler.current.reset();
      sampler.current.start();
      setGesture({ kind: "move", origin: world, startTransforms: starts });
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [doc, index, selection, setSelection, spatial, toWorld],
  );

  /**
   * Double-click steps into a group (doc 04 §10.2): the group the click would
   * otherwise have selected becomes the isolation scope, and the element under
   * the cursor is selected inside it. Without this the only way past a group is
   * alt-click, which selects the child but leaves every following click bouncing
   * back out to the group.
   */
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // Pointer capture may retarget the synthesized dblclick to the canvas.
      // Ask the browser what is physically under the pointer, then fall back to
      // the hit recorded before capture. A gesture that actually moved is not a
      // request to edit, even if Chromium still emits a click afterwards.
      if (pointerHit.current?.moved) return;
      const physical = typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(event.clientX, event.clientY)
            .map((candidate) => candidate.closest<HTMLElement>("[data-element-id]"))
            .find((candidate) => candidate && containerRef.current?.contains(candidate))
        : undefined;
      const target = physical ?? (event.target as HTMLElement).closest<HTMLElement>("[data-element-id]");
      const hitId = target?.dataset.elementId ?? pointerHit.current?.id;
      if (!hitId) return;
      event.preventDefault();

      setSelection((current) => {
        const resolved = resolveClickTarget(index, hitId, {
          isolationGroupId: current.isolationGroupId,
        });

        // At the leaf. On a text box or a shape that means editing its words —
        // the thing a double-click means everywhere else in the product.
        if (!resolved || resolved === hitId) {
          const found = resolveElementById(doc, hitId);
          if (found && found.element.locked !== true && textTargetOf(found.element)) {
            return { ...current, selectedIds: [hitId], primaryId: hitId, editingTextId: hitId };
          }
          // An equation's words are its LaTeX, which is edited in the inspector
          // with a preview beside it; a double-click goes there. When the
          // inspector is hidden there is no field, and nothing happens.
          if (found && found.element.locked !== true && found.element.type === "equation") {
            requestAnimationFrame(() => {
              const field = window.document.getElementById(`latex-${hitId}`);
              field?.focus();
              field?.scrollIntoView({ block: "nearest" });
            });
          }
          return current;
        }

        return { ...enterGroup(current, resolved), selectedIds: [hitId], primaryId: hitId };
      });
    },
    [doc, index, setSelection],
  );

  const onHandleDown = useCallback(
    (event: React.PointerEvent, handle: HandleId) => {
      event.stopPropagation();
      const id = selection.primaryId ?? selection.selectedIds[0];
      if (!id) return;

      const found = resolveElementById(doc, id);
      if (!found) return;

      spatial.exclude(id);
      sampler.current.reset();
      sampler.current.start();
      setGesture({
        kind: "resize",
        handle,
        origin: toWorld(event),
        startTransform: found.element.transform,
        elementId: id,
        elementType: found.element.type,
      });
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [doc, selection, spatial, toWorld],
  );

  const onRotateDown = useCallback(
    (event: React.PointerEvent) => {
      event.stopPropagation();
      const id = selection.primaryId ?? selection.selectedIds[0];
      if (!id) return;

      const found = resolveElementById(doc, id);
      if (!found) return;

      const t = found.element.transform;
      const origin = offsetOf(id);
      const centre = {
        x: origin.x + t.x + t.width / 2,
        y: origin.y + t.y + t.height / 2,
      };
      const world = toWorld(event);

      setGesture({
        kind: "rotate",
        centre,
        startAngle: Math.atan2(world.y - centre.y, world.x - centre.x),
        startRotation: t.rotation ?? 0,
        elementId: id,
      });
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [doc, offsetOf, selection, toWorld],
  );

  // ------------------------------------------------------------- pointer move

  const handleMove = useCallback(
    (event: { clientX: number; clientY: number }) => {
      if (gesture.kind === "none") return;
      const world = toWorld(event);

      if (gesture.kind === "marquee") {
        setGesture({ ...gesture, current: world });
        return;
      }

      if (gesture.kind === "move") {
        let delta = { x: world.x - gesture.origin.x, y: world.y - gesture.origin.y };
        // Shift constrains to the axis of greatest movement, measured over the
        // whole gesture — using the frame delta makes the axis flip on a wobble.
        if (modifiers.current.shift) delta = constrainToAxis(delta);

        const next = new Map<string, Transform>();
        for (const [id, start] of gesture.startTransforms) {
          next.set(id, moveTransform(start, delta));
        }

        // Snap the primary element, then apply the same correction to the rest so
        // a multi-selection moves as one piece.
        const primary = selection.primaryId ?? [...gesture.startTransforms.keys()][0];
        const primaryTransform = primary ? next.get(primary) : undefined;

        if (primaryTransform && !modifiers.current.mod) {
          const origin = offsetOf(primary!);
          const bounds: Rect = {
            x: origin.x + primaryTransform.x,
            y: origin.y + primaryTransform.y,
            width: primaryTransform.width,
            height: primaryTransform.height,
          };

          const neighbours = spatial
            .search(expand(bounds, 200 / scale))
            .map((id) => ({ id, bounds: spatial.boundsOf(id)! }))
            .sort((a, b) => rectDistance(bounds, a.bounds) - rectDistance(bounds, b.bounds) || a.id.localeCompare(b.id))
            .slice(0, MAX_NEIGHBOURS);

          const lines = collectSnapLines({
            slide: { x: 0, y: 0, width: doc.viewport.width, height: doc.viewport.height },
            safeArea: doc.viewport.safeArea,
            neighbours,
          });

          const snap = snapRectWithSpacing(bounds, lines, neighbours.map(neighbour => neighbour.bounds), {
            zoom: scale,
            gridEnabled,
            gridUnit: doc.theme.grid.baseUnit,
          });
          if (modifiers.current.shift) {
            const fixedAxis = delta.x === 0 ? "x" : "y";
            snap.delta[fixedAxis] = 0;
            snap.guides = snap.guides.filter(guide => guide.axis !== fixedAxis);
            snap.spacingGuides = snap.spacingGuides.filter(guide => guide.axis !== fixedAxis);
            for (const guide of snap.spacingGuides) {
              guide.between[1] = { ...bounds, x: bounds.x + snap.delta.x, y: bounds.y + snap.delta.y };
            }
          }

          if (snap.delta.x !== 0 || snap.delta.y !== 0) {
            for (const [id, transform] of next) next.set(id, moveTransform(transform, snap.delta));
          }
          setGuides(snap.guides);
          setSpacingGuides(snap.spacingGuides);
        } else {
          setGuides([]);
          setSpacingGuides([]);
        }

        setDraft(next);
        return;
      }

      if (gesture.kind === "resize") {
        const delta = { x: world.x - gesture.origin.x, y: world.y - gesture.origin.y };
        const next = resizeTransform(gesture.startTransform, gesture.handle, delta, {
          uniform: modifiers.current.shift,
          fromCenter: modifiers.current.alt,
          elementType: gesture.elementType,
          // Side handles on a text box change width only; height follows from the
          // fit mode (doc 04 §13).
          widthOnly:
            gesture.elementType === "text" && (gesture.handle === "e" || gesture.handle === "w"),
        });
        setDraft(new Map([[gesture.elementId, next]]));
        return;
      }

      if (gesture.kind === "rotate") {
        const angle = Math.atan2(world.y - gesture.centre.y, world.x - gesture.centre.x);
        const degrees = ((angle - gesture.startAngle) * 180) / Math.PI;
        const found = resolveElementById(doc, gesture.elementId);
        if (!found) return;

        const next = rotateTransform(
          { ...found.element.transform, rotation: gesture.startRotation },
          degrees,
          { snap: modifiers.current.shift },
        );
        setDraft(new Map([[gesture.elementId, next]]));
      }
    },
    [doc, gesture, gridEnabled, offsetOf, scale, selection.primaryId, setDraft, spatial, toWorld],
  );

  /**
   * One layout pass per frame, not one per event (doc 04 §31.2).
   *
   * Chromium can deliver several pointermove events between two frames, and
   * doing the snap search and the draft rebuild for each of them is work the user
   * can never see — the browser paints once either way. Keeping only the latest
   * position and acting on it in a rAF callback is what pulls the drag under the
   * 16ms budget on a busy slide.
   */
  const pendingMove = useRef<{ clientX: number; clientY: number } | null>(null);
  const moveFrame = useRef<number | null>(null);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const hit = pointerHit.current;
      if (hit && Math.hypot(event.clientX - hit.clientX, event.clientY - hit.clientY) > 4) hit.moved = true;
      // The React event is pooled-adjacent and must not be read in a later
      // frame; only the two numbers that matter are kept.
      pendingMove.current = { clientX: event.clientX, clientY: event.clientY };

      if (moveFrame.current !== null) return;
      moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = null;
        const latest = pendingMove.current;
        pendingMove.current = null;
        if (latest) handleMove(latest);
      });
    },
    [handleMove],
  );

  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  // --------------------------------------------------------------- pointer up

  const onPointerUp = useCallback(() => {
    // Flush a queued move first: ending the gesture on a frame-old position
    // would drop the last few pixels of every drag.
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    const queued = pendingMove.current;
    pendingMove.current = null;
    if (queued) handleMove(queued);

    if (gesture.kind === "marquee") {
      const rect = normalize(gesture.origin, queued ? toWorld(queued) : gesture.current);
      // A click with no movement is not a marquee.
      if (rect.width > 2 || rect.height > 2) {
        setSelection((current) =>
          marqueeSelect(current, index, rect, {
            contained: modifiers.current.alt,
            additive: modifiers.current.shift,
          }),
        );
      }
      setGesture({ kind: "none" });
      return;
    }

    // handleMove can have queued a React update in this very event. Read its
    // synchronous result, rather than the draft captured by the last render.
    const latestDraft = draftRef.current;
    // A click is not a drag. A pointer that wobbled a pixel or two between
    // down and up used to commit a "Move" — so selecting an object, or the two
    // clicks of a double-click, dirtied the deck and filled the undo history
    // with moves nobody made. Past the same threshold that decides whether a
    // double-click is a request to edit, it is a drag.
    const clickOnly = gesture.kind === "move" && pointerHit.current !== undefined && !pointerHit.current.moved;
    if (latestDraft.size > 0 && !clickOnly) {
      const operations = [];
      for (const [id, transform] of latestDraft) {
        // Rounded once, here, not on every pointermove — rounding each step
        // accumulates error across a drag.
        const committed = commitTransform(transform);
        operations.push(...(gesture.kind === "resize"
          ? resizeOperations(doc, id, committed)
          : setProperty(doc, id, "transform", committed)));
      }

      const label =
        gesture.kind === "resize"
          ? "Resize"
          : gesture.kind === "rotate"
            ? "Rotate"
            : latestDraft.size > 1
              ? `Move ${latestDraft.size} objects`
              : "Move";

      apply(operations, {
        label,
        // One gesture, one undo entry (doc 04 §29.2).
        coalesceKey: `${gesture.kind}:${[...latestDraft.keys()].sort().join(",")}`,
      });
    }

    sampler.current.stop();
    const frames = sampler.current.stats();
    if (frames && frames.count > 8) onFrameStats?.(frames);

    spatial.clearExclusions();
    setDraft(new Map());
    setGuides([]);
    setSpacingGuides([]);
    setGesture({ kind: "none" });
  }, [apply, doc, gesture, handleMove, index, onFrameStats, setDraft, setSelection, spatial, toWorld]);

  const cancelGesture = useCallback(() => {
    // A cancelled pointer never commits its queued final frame. The document
    // and earlier history entries are untouched; only this preview is discarded.
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = null;
    pendingMove.current = null;
    sampler.current.stop();
    spatial.clearExclusions();
    setDraft(new Map());
    setGuides([]);
    setSpacingGuides([]);
    setGesture({ kind: "none" });
  }, [setDraft, spatial]);

  if (!slide || !slideScene) return null;

  const bounds = selectionBounds(
    index,
    selection.selectedIds,
    new Map(
      selection.selectedIds.map((id) => [id, transformOf(id)?.rotation ?? 0]),
    ),
  );

  const liveBounds = draftBounds(draft, offsetOf) ?? bounds?.rect;

  /**
   * The text element being edited in place, with everything the editable needs
   * to sit exactly on top of it.
   *
   * Read from the scene rather than the document because the scene has the
   * resolved typography and the laid-out box — inside a container those are not
   * the element's own values, and an editable positioned from the document would
   * sit in the wrong place.
   */
  const editing = (() => {
    const id = selection.editingTextId;
    if (!id) return undefined;

    const node = flattenScene(slideScene).find((candidate) => candidate.id === id);
    const found = resolveElementById(doc, id);
    const target = textTargetOf(found?.element);
    if (!node || !found || !target) return undefined;

    const payload = node.renderPayload;
    const rect = {
      x: node.bounds.x * scale,
      y: node.bounds.y * scale,
      width: node.bounds.width * scale,
      height: node.bounds.height * scale,
    };
    // The element's own box and composed matrix, so a rotated box, or one in
    // a rotated group, is edited where it is drawn (MA-12).
    const local = { width: node.localBounds.width, height: node.localBounds.height, matrix: node.worldTransform };
    if (payload.kind === "text") {
      return {
        id,
        property: target.property,
        content: target.value,
        typography: payload.typography,
        align: payload.align,
        verticalAlign: payload.verticalAlign,
        padding: payload.padding,
        rect,
        local,
      };
    }
    if (payload.kind === "shape" && payload.labelTypography) {
      // The renderer centres a label vertically inside 16px of padding.
      return {
        id,
        property: target.property,
        content: target.value,
        typography: payload.labelTypography,
        align: "center",
        verticalAlign: "middle",
        padding: { top: 16, right: 16, bottom: 16, left: 16 },
        rect,
        local,
      };
    }
    return undefined;
  })();
  const singleRotation =
    selection.selectedIds.length === 1
      ? (transformOf(selection.selectedIds[0]!)?.rotation ?? 0)
      : (bounds?.rotation ?? 0);

  return (
    <div
      ref={containerRef}
      // Scopes the motion preview's element lookup. Without it the sampled
      // styles would also land on the slide-strip thumbnails, which render the
      // same element ids.
      data-editor-canvas=""
      data-region="canvas"
      // The canvas is a focus target so its shortcuts have somewhere to live:
      // Tab walks the objects and hands focus on after the last, arrows nudge,
      // Escape backs out. `application` tells a screen reader these keys are
      // the canvas's, not the page's.
      tabIndex={0}
      role="application"
      aria-roledescription="slide canvas"
      aria-label="Slide canvas. Tab moves between objects, arrow keys nudge the selection, Escape clears it."
      onPointerDown={(event) => {
        // Clicking an object gives the canvas focus, as clicking any control
        // does, so Delete and the arrows then act on what was clicked.
        (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        onPointerDown(event);
      }}
      onDoubleClick={onDoubleClick}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={cancelGesture}
      onDragStart={(event) => event.preventDefault()}
      style={{
        width,
        height: doc.viewport.height * scale,
        position: "relative",
        overflow: "hidden",
        background: "var(--dk-backdrop)",
        touchAction: "none",
        // A drag across text otherwise starts a native text selection, which
        // paints the dragged element in the browser's highlight colour and
        // survives the gesture.
        userSelect: "none",
        WebkitUserSelect: "none",
        cursor: gesture.kind === "marquee" ? "crosshair" : "default",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        <SlideView
          scene={resizePreview ?? applyDraft(slideScene, draft, editing?.id)}
          mode="editor"
          showGuides={showGuides}
          resolveAssetUrl={resolveAssetUrl}
        />
      </div>

      {/* Chrome layer. Everything below is editor-only and is never mounted in
          export mode, which is enforced by SlideView rather than by CSS. */}
      <div
        data-deckastra-chrome=""
        style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1000 }}
      >
        {guides.map((guide, i) => (
          <div
            key={`${guide.axis}${guide.position}${i}`}
            style={{
              position: "absolute",
              background: "var(--dk-blue)",
              ...(guide.axis === "x"
                ? { left: guide.position * scale, top: 0, width: 1, height: "100%" }
                : { top: guide.position * scale, left: 0, height: 1, width: "100%" }),
            }}
          />
        ))}

        {spacingGuides.map(guide => (
          <SpacingIndicators key={guide.axis} guide={guide} scale={scale} />
        ))}

        {gesture.kind === "marquee"
          ? (() => {
              const rect = normalize(gesture.origin, gesture.current);
              return (
                <div
                  style={{
                    position: "absolute",
                    left: rect.x * scale,
                    top: rect.y * scale,
                    width: rect.width * scale,
                    height: rect.height * scale,
                    border: "1px solid var(--dk-blue)",
                    // The action blue, faintly: a marquee is a selection being made.
                    background: "color-mix(in srgb, var(--dk-blue) 14%, transparent)",
                  }}
                />
              );
            })()
          : null}

        {liveBounds && !editing ? (
          <SelectionOverlay
            rect={liveBounds}
            rotation={singleRotation}
            scale={scale}
            canRotate={bounds?.canRotate ?? false}
            onHandleDown={onHandleDown}
            onRotateDown={onRotateDown}
          />
        ) : null}
      </div>

      {editing ? (
        <TextEditor
          key={editing.id}
          value={editing.content}
          typography={editing.typography}
          rect={editing.rect}
          local={editing.local}
          scale={scale}
          align={editing.align}
          verticalAlign={editing.verticalAlign}
          padding={editing.padding}
          registerDraft={editor.registerDraft}
          onCommit={(next) => {
            // The latest document, not this render's: a commit can arrive from
            // the save barrier or an unmount, after later edits have landed.
            const current = editorRef.current.document;
            if (resolveElementById(current, editing.id)) {
              editorRef.current.apply(setProperty(current, editing.id, editing.property, next), {
                label: editing.property === "text" ? "Edit shape label" : "Edit text",
              });
            }
            setSelection((state) => ({ ...state, editingTextId: undefined }));
          }}
          onCancel={() => setSelection((current) => ({ ...current, editingTextId: undefined }))}
        />
      ) : null}
    </div>
  );
}

function SpacingIndicators({ guide, scale }: { guide: SpacingGuide; scale: number }) {
  const middle = guide.between[1]!;
  const horizontal = guide.axis === "x";
  const cross = (horizontal ? middle.y + middle.height / 2 : middle.x + middle.width / 2) * scale;
  return (
    <svg data-spacing-guide={guide.axis} aria-hidden="true" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
      {[0, 1].map(index => {
        const a = guide.between[index]!;
        const b = guide.between[index + 1]!;
        const start = (horizontal ? a.x + a.width : a.y + a.height) * scale;
        const end = (horizontal ? b.x : b.y) * scale;
        const point = (along: number, across: number) => horizontal ? `${along},${across}` : `${across},${along}`;
        return (
          <g key={index} stroke="var(--dk-blue)" strokeWidth={1} fill="none">
            <polyline points={`${point(start, cross)} ${point(end, cross)}`} />
            <polyline points={`${point(start + 4, cross - 3)} ${point(start, cross)} ${point(start + 4, cross + 3)}`} />
            <polyline points={`${point(end - 4, cross - 3)} ${point(end, cross)} ${point(end - 4, cross + 3)}`} />
            <text
              x={horizontal ? (start + end) / 2 : cross + 6}
              y={horizontal ? cross - 6 : (start + end) / 2}
              textAnchor={horizontal ? "middle" : "start"}
              fill="var(--dk-blue)" stroke="none" fontSize={12}
            >{guide.gap}</text>
          </g>
        );
      })}
    </svg>
  );
}

function SelectionOverlay({
  rect,
  rotation,
  scale,
  canRotate,
  onHandleDown,
  onRotateDown,
}: {
  rect: Rect;
  rotation: number;
  scale: number;
  canRotate: boolean;
  onHandleDown: (event: React.PointerEvent, handle: HandleId) => void;
  onRotateDown: (event: React.PointerEvent) => void;
}) {
  const style: CSSProperties = {
    position: "absolute",
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
    outline: "1px solid var(--dk-blue)",
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: "center",
    pointerEvents: "none",
  };

  return (
    <div style={style}>
      {HANDLES.map((handle) => (
        <div
          key={handle}
          data-resize-handle={handle}
          onPointerDown={(event) => onHandleDown(event, handle)}
          style={{
            position: "absolute",
            width: 9,
            height: 9,
            marginLeft: -5,
            marginTop: -5,
            background: "var(--dk-on-backdrop)",
            border: "1px solid var(--dk-blue)",
            borderRadius: 2,
            pointerEvents: "auto",
            cursor: handleCursor(handle),
            ...handlePosition(handle),
          }}
        />
      ))}

      {canRotate ? (
        <div
          onPointerDown={onRotateDown}
          title="Rotate"
          style={{
            position: "absolute",
            left: "50%",
            top: -28,
            width: 11,
            height: 11,
            marginLeft: -6,
            background: "var(--dk-blue)",
            borderRadius: "50%",
            pointerEvents: "auto",
            cursor: "grab",
          }}
        />
      ) : null}
    </div>
  );
}

function handlePosition(handle: HandleId): CSSProperties {
  const map: Record<HandleId, CSSProperties> = {
    nw: { left: 0, top: 0 },
    n: { left: "50%", top: 0 },
    ne: { left: "100%", top: 0 },
    e: { left: "100%", top: "50%" },
    se: { left: "100%", top: "100%" },
    s: { left: "50%", top: "100%" },
    sw: { left: 0, top: "100%" },
    w: { left: 0, top: "50%" },
  };
  return map[handle];
}

function handleCursor(handle: HandleId): string {
  const map: Record<HandleId, string> = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
  };
  return map[handle];
}

/** Overlay the in-flight gesture onto the scene, so the drag is visible without
 *  committing a transaction per pointermove. */
export function applyDraft(
  scene: ReturnType<typeof buildDocumentScene>["slides"][number],
  draft: ReadonlyMap<string, Transform>,
  /** Hidden while its text is being edited in place — otherwise the rendered
   *  glyphs sit under the editable's and everything looks doubled. */
  editingId?: string,
): ReturnType<typeof buildDocumentScene>["slides"][number] {
  if (draft.size === 0 && !editingId) return scene;

  const sameMatrix = (a: Matrix, b: Matrix) =>
    a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;

  const patch = (
    nodes: typeof scene.nodes,
    parentWorld: Matrix,
    parentChanged: boolean,
  ): typeof scene.nodes =>
    nodes.map((node) => {
      const override = draft.get(node.id);
      const localBounds = override
        ? { ...node.localBounds, width: override.width, height: override.height }
        : node.localBounds;
      const local = override ? localMatrix(override) : node.localTransform;
      const composed = override || parentChanged ? multiply(parentWorld, local) : node.worldTransform;
      const geometryChanged = Boolean(override || parentChanged || !sameMatrix(composed, node.worldTransform));
      const children = node.children ? patch(node.children, composed, geometryChanged) : undefined;
      const editingHere = node.id === editingId;
      // A shape keeps its fill and outline while its label is edited; only the
      // label is hidden, or the words would draw twice.
      const labelOnly = editingHere && node.renderPayload.kind === "shape";
      const hidden = editingHere && !labelOnly;

      if (!geometryChanged && !editingHere && (!children || children === node.children)) return node;
      return {
        ...node,
        localBounds,
        worldTransform: composed,
        bounds: geometryChanged
          ? transformedBounds(composed, localBounds.width, localBounds.height)
          : node.bounds,
        ...(hidden ? { flags: { ...node.flags, hidden: true } } : {}),
        ...(labelOnly && node.renderPayload.kind === "shape"
          ? { renderPayload: { ...node.renderPayload, label: undefined } }
          : {}),
        ...(children ? { children } : {}),
      };
    });

  return { ...scene, nodes: patch(scene.nodes, IDENTITY, false) };
}

function draftBounds(
  draft: ReadonlyMap<string, Transform>,
  offsetOf: (id: string) => { x: number; y: number },
): Rect | undefined {
  if (draft.size === 0) return undefined;
  // Draft transforms are local to each element's parent; the overlay is drawn
  // in world space.
  const values = [...draft].map(([id, t]) => {
    const origin = offsetOf(id);
    return { ...t, x: origin.x + t.x, y: origin.y + t.y };
  });

  const minX = Math.min(...values.map((t) => t.x));
  const minY = Math.min(...values.map((t) => t.y));
  const maxX = Math.max(...values.map((t) => t.x + t.width));
  const maxY = Math.max(...values.map((t) => t.y + t.height));

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function normalize(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function expand(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width);
  const dy = Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height);
  return dx * dx + dy * dy;
}
