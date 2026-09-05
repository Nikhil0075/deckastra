"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PresentationDocument, Rect, Transform } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";
import { setProperty, resolveElementById } from "@deckastra/presentation-core";
import {
  HANDLES,
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
  snapRect,
  type HandleId,
  type SelectionState,
  type SnapLine,
} from "@deckastra/editor";

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

export function EditorCanvas({ editor, width, showGuides = true, gridEnabled = false }: EditorCanvasProps) {
  const { document: doc, slideIndex, selection, setSelection, apply, nodes } = editor;
  const slide = doc.slides[slideIndex];

  const containerRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture>({ kind: "none" });
  const [draft, setDraft] = useState<Map<string, Transform>>(new Map());
  const [guides, setGuides] = useState<SnapLine[]>([]);
  const modifiers = useRef({ shift: false, alt: false, mod: false });

  const scale = width / doc.viewport.width;

  const scene = useMemo(() => buildDocumentScene(doc), [doc]);
  const slideScene = scene.slides[slideIndex];

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
      const world = toWorld(event);

      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-element-id]");
      const hitId = target?.dataset.elementId;

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
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-element-id]");
      const hitId = target?.dataset.elementId;
      if (!hitId) return;

      setSelection((current) => {
        const resolved = resolveClickTarget(index, hitId, {
          isolationGroupId: current.isolationGroupId,
        });
        // Already at the leaf — nothing left to step into.
        if (!resolved || resolved === hitId) return current;

        return { ...enterGroup(current, resolved), selectedIds: [hitId], primaryId: hitId };
      });
    },
    [index, setSelection],
  );

  const onHandleDown = useCallback(
    (event: React.PointerEvent, handle: HandleId) => {
      event.stopPropagation();
      const id = selection.primaryId ?? selection.selectedIds[0];
      if (!id) return;

      const found = resolveElementById(doc, id);
      if (!found) return;

      spatial.exclude(id);
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

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
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
            .map((id) => ({ id, bounds: spatial.boundsOf(id)! }));

          const lines = collectSnapLines({
            slide: { x: 0, y: 0, width: doc.viewport.width, height: doc.viewport.height },
            safeArea: doc.viewport.safeArea,
            neighbours,
          });

          const snap = snapRect(bounds, lines, {
            zoom: scale,
            gridEnabled,
            gridUnit: doc.theme.grid.baseUnit,
          });

          if (snap.delta.x !== 0 || snap.delta.y !== 0) {
            for (const [id, transform] of next) next.set(id, moveTransform(transform, snap.delta));
          }
          setGuides(snap.guides);
        } else {
          setGuides([]);
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
    [doc, gesture, gridEnabled, offsetOf, scale, selection.primaryId, spatial, toWorld],
  );

  // --------------------------------------------------------------- pointer up

  const onPointerUp = useCallback(() => {
    if (gesture.kind === "marquee") {
      const rect = normalize(gesture.origin, gesture.current);
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

    if (draft.size > 0) {
      const operations = [];
      for (const [id, transform] of draft) {
        // Rounded once, here, not on every pointermove — rounding each step
        // accumulates error across a drag.
        const committed = commitTransform(transform);
        operations.push(...setProperty(doc, id, "transform", committed));
      }

      const label =
        gesture.kind === "resize"
          ? "Resize"
          : gesture.kind === "rotate"
            ? "Rotate"
            : draft.size > 1
              ? `Move ${draft.size} objects`
              : "Move";

      apply(operations, {
        label,
        // One gesture, one undo entry (doc 04 §29.2).
        coalesceKey: `${gesture.kind}:${[...draft.keys()].sort().join(",")}`,
      });
    }

    spatial.clearExclusions();
    setDraft(new Map());
    setGuides([]);
    setGesture({ kind: "none" });
  }, [apply, doc, draft, gesture, index, setSelection, spatial]);

  if (!slide || !slideScene) return null;

  const bounds = selectionBounds(
    index,
    selection.selectedIds,
    new Map(
      selection.selectedIds.map((id) => [id, transformOf(id)?.rotation ?? 0]),
    ),
  );

  const liveBounds = draftBounds(draft, offsetOf) ?? bounds?.rect;
  const singleRotation =
    selection.selectedIds.length === 1
      ? (transformOf(selection.selectedIds[0]!)?.rotation ?? 0)
      : (bounds?.rotation ?? 0);

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        width,
        height: doc.viewport.height * scale,
        position: "relative",
        overflow: "hidden",
        background: "#000",
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
          scene={applyDraft(slideScene, draft)}
          mode="editor"
          showGuides={showGuides}
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
              background: "var(--accent)",
              ...(guide.axis === "x"
                ? { left: guide.position * scale, top: 0, width: 1, height: "100%" }
                : { top: guide.position * scale, left: 0, height: 1, width: "100%" }),
            }}
          />
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
                    border: "1px solid var(--accent)",
                    background: "rgba(76,194,255,0.12)",
                  }}
                />
              );
            })()
          : null}

        {liveBounds ? (
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
    </div>
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
    outline: "1px solid var(--accent)",
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: "center",
    pointerEvents: "none",
  };

  return (
    <div style={style}>
      {HANDLES.map((handle) => (
        <div
          key={handle}
          onPointerDown={(event) => onHandleDown(event, handle)}
          style={{
            position: "absolute",
            width: 9,
            height: 9,
            marginLeft: -5,
            marginTop: -5,
            background: "#fff",
            border: "1px solid var(--accent)",
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
            background: "var(--accent)",
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
function applyDraft(
  scene: ReturnType<typeof buildDocumentScene>["slides"][number],
  draft: ReadonlyMap<string, Transform>,
): ReturnType<typeof buildDocumentScene>["slides"][number] {
  if (draft.size === 0) return scene;

  const patch = (nodes: typeof scene.nodes): typeof scene.nodes =>
    nodes.map((node) => {
      const override = draft.get(node.id);
      const children = node.children ? patch(node.children) : undefined;
      if (!override) return children ? { ...node, children } : node;

      const dx = override.x - node.localTransform.e;
      const dy = override.y - node.localTransform.f;

      return {
        ...node,
        localBounds: { ...node.localBounds, width: override.width, height: override.height },
        worldTransform: {
          ...node.worldTransform,
          e: node.worldTransform.e + dx,
          f: node.worldTransform.f + dy,
        },
        ...(children ? { children } : {}),
      };
    });

  return { ...scene, nodes: patch(scene.nodes) };
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
