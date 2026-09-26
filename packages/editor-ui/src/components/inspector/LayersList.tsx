import { walkElements } from "@deckastra/presentation-schema";

import type { EditorApi } from "../../lib/useEditor";
import { Icon } from "../../ui";
import { cx } from "../../ui/cx";
import { labelFor } from "./labels";

/**
 * The current slide's elements, top of the z-order last (document order). A
 * click selects; Shift adds to the selection, matching the canvas.
 */
export function LayersList({ editor }: { editor: EditorApi }) {
  const { document: doc, slideIndex, selection, setSelection } = editor;
  const slide = doc.slides[slideIndex];
  if (!slide || slide.elements.length === 0) return <p className="dk-muted">This slide is empty.</p>;

  return (
    <ul className="dk-layers">
      {[...walkElements(slide.elements)].map(({ element, depth }) => {
        const isSelected = selection.selectedIds.includes(element.id);
        return (
          <li key={element.id}>
            <button
              type="button"
              className={cx(
                "dk-layers__row",
                isSelected && "dk-layers__row--selected",
                element.visible === false && "dk-layers__row--hidden",
              )}
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-pressed={isSelected}
              onClick={(event) =>
                setSelection((current) => ({
                  ...current,
                  selectedIds: event.shiftKey ? [...new Set([...current.selectedIds, element.id])] : [element.id],
                  primaryId: element.id,
                }))
              }
            >
              <span className="dk-layers__type">{element.type}</span>
              <span className="dk-layers__name">{labelFor(element)}</span>
              {element.locked ? (
                <>
                  <Icon name="lock" size={12} />
                  <span className="dk-visually-hidden">Locked</span>
                </>
              ) : null}
              {element.visible === false ? (
                <>
                  <Icon name="eyeOff" size={12} />
                  <span className="dk-visually-hidden">Hidden</span>
                </>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
