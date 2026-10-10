import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { buildDocumentScene } from "@deckastra/renderer";

import type { useAssetUrls } from "../../lib/asset-urls";
import {
  deleteSlideAction,
  duplicateSlideAction,
  moveSlideAction,
  slotForPointer,
  targetIndexForSlot,
  type SlideAction,
} from "../../lib/slide-actions";
import type { EditorApi } from "../../lib/useEditor";
import { Icon, IconButton, Menu, ScrollArea } from "../../ui";
import { cx } from "../../ui/cx";
import { FinalFrameSlide } from "../FinalFrameSlide";

/**
 * What the strip spends beside a thumbnail: the step number and drag handle on
 * the left, padding on the right. A 176px strip draws 120px thumbnails, and a
 * wider one draws wider ones, which is the point of letting it be dragged wider.
 */
const STRIP_CHROME = 56;
const DEFAULT_STRIP_WIDTH = 176;

/** The drag payload type, so a drop of something else (a file, text) is ignored. */
const DRAG_TYPE = "application/x-deckastra-slide";

export interface SlideStripProps {
  editor: EditorApi;
  scene: ReturnType<typeof buildDocumentScene>;
  resolveAssetUrl: ReturnType<typeof useAssetUrls>;
  onAdd: () => void;
  /** Something to tell the user after an action (a morph a move separated). */
  onNotice: (message: string) => void;
  /**
   * Open how the deck moves into slide `index` (MA-24). The transition belongs
   * to a slide, so it is reached from the slide — not only by knowing that
   * Motion mode has a panel for it.
   */
  onTransition?: (index: number) => void;
  /** The strip's width in px (`lib/layout-sizes.ts`); thumbnails follow it. */
  width?: number;
}

/**
 * The slide list on the left (Figma: SLIDES n, +, numbered thumbnails; the
 * "speaker notes editing" frame adds drag handles, a drop line and a
 * Duplicate/Move menu).
 *
 * Every action is one patch from `lib/slide-actions`, applied through
 * `editor.apply` — so reorder, duplicate and delete each undo as one step, and
 * a delete takes whatever pointed into the slide with it.
 *
 * Reordering works three ways, because a drag is not available to everyone:
 * drag the handle, Alt+↑/↓ on a focused thumbnail, or Move up/down in the menu.
 */
export function SlideStrip({ editor, scene, resolveAssetUrl, onAdd, onNotice, onTransition, width = DEFAULT_STRIP_WIDTH }: SlideStripProps) {
  const thumbWidth = Math.max(64, width - STRIP_CHROME);
  const { document: doc } = editor;
  const issues = doc.extensions?.["deckastra.unresolvedIssues"] as Record<string, unknown[] | undefined> | undefined;
  const active = useRef<HTMLButtonElement | null>(null);
  const thumbs = useRef<Array<HTMLButtonElement | null>>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const count = scene.slides.length;

  // Keep the current slide in view when it changes from elsewhere (keyboard,
  // an accessibility finding jumping to a slide, a move).
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest" });
  }, [editor.slideIndex]);

  const run = (action: SlideAction | null, focus = false) => {
    if (!action) return;
    editor.apply(action.operations, { label: action.label });
    editor.setSlideIndex(action.index);
    if (action.notice) onNotice(action.notice);
    // Keyboard reorder keeps focus on the slide that moved, so Alt+↓ pressed
    // three times moves one slide three places rather than three slides once.
    if (focus) requestAnimationFrame(() => thumbs.current[action.index]?.focus());
  };

  const move = (from: number, to: number, focus = false) => run(moveSlideAction(doc, from, to), focus);

  const onThumbKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      move(index, index + (event.key === "ArrowUp" ? -1 : 1), true);
    } else if (!event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      // Plain arrows walk the strip, and are claimed so the canvas does not
      // also nudge whatever is selected.
      event.preventDefault();
      const next = Math.max(0, Math.min(count - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      editor.setSlideIndex(next);
      requestAnimationFrame(() => thumbs.current[next]?.focus());
    }
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (dragFrom === null || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    setDropSlot(slotForPointer(index, event.clientY - rect.top, rect.height));
  };

  const endDrag = () => {
    setDragFrom(null);
    setDropSlot(null);
  };

  const onDrop = (event: DragEvent) => {
    if (dragFrom === null || dropSlot === null) return endDrag();
    event.preventDefault();
    const to = targetIndexForSlot(dragFrom, dropSlot);
    const from = dragFrom;
    endDrag();
    if (to !== from) move(from, to);
  };

  return (
    <nav className="dk-strip" aria-label="Slides" data-region="slides">
      <div className="dk-strip__header">
        <span className="dk-strip__title">
          Slides <span className="dk-strip__count">{count}</span>
        </span>
        <IconButton icon="plus" label="Add slide" size="sm" variant="secondary" onClick={onAdd} data-testid="add-slide" />
      </div>
      <ScrollArea className="dk-strip__list">
        <ol className="dk-strip__items" onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSlot(null);
        }}>
          {scene.slides.map((slideScene, i) => {
            const current = i === editor.slideIndex;
            const flagged = (issues?.[slideScene.slideId]?.length ?? 0) > 0;
            const dragging = dragFrom === i;
            return (
              <li
                key={slideScene.slideId}
                className={cx(
                  "dk-strip__item",
                  dragging && "dk-strip__item--dragging",
                  dropSlot === i && dragFrom !== null && "dk-strip__item--drop-before",
                  dropSlot === i + 1 && i === count - 1 && dragFrom !== null && "dk-strip__item--drop-after",
                )}
                onDragOver={(event) => onDragOver(event, i)}
                onDrop={onDrop}
                data-slide-index={i}
              >
                <span className="dk-strip__gutter">
                  <span className="dk-strip__number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span
                    className="dk-strip__handle"
                    draggable
                    title="Drag to reorder"
                    aria-hidden="true"
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, slideScene.slideId);
                      event.dataTransfer.effectAllowed = "move";
                      const li = event.currentTarget.closest("li");
                      if (li) event.dataTransfer.setDragImage(li, 12, 12);
                      setDragFrom(i);
                    }}
                    onDragEnd={endDrag}
                  >
                    <Icon name="drag" size={12} />
                  </span>
                </span>
                <span className="dk-strip__card">
                  <button
                    ref={(element) => {
                      thumbs.current[i] = element;
                      if (current) active.current = element;
                    }}
                    type="button"
                    className={cx("dk-strip__thumb", current && "dk-strip__thumb--current")}
                    aria-current={current ? "true" : undefined}
                    aria-label={`Slide ${i + 1} of ${count}${slideScene.keyMessage ? `: ${slideScene.keyMessage}` : ""}${flagged ? " (has review issues)" : ""}`}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    title={slideScene.keyMessage}
                    onClick={() => editor.setSlideIndex(i)}
                    onKeyDown={(event) => onThumbKey(event, i)}
                    data-testid="slide-thumb"
                  >
                    <FinalFrameSlide scene={slideScene} width={thumbWidth} resolveAssetUrl={resolveAssetUrl} />
                    {flagged ? <span className="dk-strip__flag" aria-hidden="true" /> : null}
                  </button>
                  <span className="dk-strip__menu">
                    <Menu
                      label={`Slide ${i + 1} actions`}
                      align="start"
                      trigger={(props) => (
                        <IconButton
                          icon="more"
                          label={`Slide ${i + 1} actions`}
                          size="sm"
                          variant="secondary"
                          data-testid="slide-menu"
                          {...props}
                        />
                      )}
                      items={[
                        { id: "duplicate", label: "Duplicate", icon: "duplicate", onSelect: () => run(duplicateSlideAction(doc, i)) },
                        { id: "up", label: "Move up", disabled: i === 0, onSelect: () => move(i, i - 1) },
                        { id: "down", label: "Move down", disabled: i === count - 1, onSelect: () => move(i, i + 1) },
                        ...(onTransition
                          ? [{ id: "transition", label: `Transition in: ${transitionName(doc.slides[i]?.transition?.type)}…`, onSelect: () => onTransition(i) }]
                          : []),
                        {
                          id: "delete",
                          label: "Delete",
                          icon: "trash",
                          danger: true,
                          // The only slide cannot go: a deck with none is a state
                          // the editor can only apologise for.
                          disabled: count <= 1,
                          onSelect: () => run(deleteSlideAction(doc, i, editor.slideIndex)),
                        },
                      ]}
                    />
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </nav>
  );
}

/** How a slide's transition reads in its menu. No transition is a cut. */
function transitionName(type: string | undefined): string {
  if (!type || type === "none" || type === "cut") return "Cut";
  return type[0]!.toUpperCase() + type.slice(1);
}
