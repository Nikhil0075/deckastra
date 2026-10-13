import { LAYER_ROLES } from "@deckastra/presentation-schema";

import { LAYER_ROLE_LABELS } from "../../lib/cutouts";
import { layerRows, lockOperations, visibilityOperations } from "../../lib/layers";
import type { EditorApi } from "../../lib/useEditor";
import { Icon } from "../../ui";
import { cx } from "../../ui/cx";
import { labelFor } from "./labels";

/**
 * The current slide's objects, front to back (2026-10-13), ending at the
 * slide's own background. A click selects, even an object hidden behind
 * others on the canvas; Shift adds to the selection, matching the canvas.
 * Each row shows the object's depth when it has one, and can lock or hide it.
 */
export function LayersList({ editor }: { editor: EditorApi }) {
  const { document: doc, slideIndex, selection, setSelection } = editor;
  const slide = doc.slides[slideIndex];
  if (!slide || slide.elements.length === 0) return <p className="dk-muted">This slide is empty.</p>;

  return (
    <>
      <p className="dk-field__hint">Front at the top.</p>
      <ul className="dk-layers">
        {layerRows(slide.elements).map(({ element, depth }) => {
          const isSelected = selection.selectedIds.includes(element.id);
          const name = labelFor(element);
          const role = element.layerRole && (LAYER_ROLES as readonly string[]).includes(element.layerRole)
            ? LAYER_ROLE_LABELS[element.layerRole as keyof typeof LAYER_ROLE_LABELS]
            : element.layerRole;
          const locked = element.locked === true;
          const hidden = element.visible === false;
          return (
            <li
              key={element.id}
              className={cx("dk-layers__row", isSelected && "dk-layers__row--selected", hidden && "dk-layers__row--hidden")}
            >
              <button
                type="button"
                className="dk-layers__pick"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-pressed={isSelected}
                data-layer-id={element.id}
                onClick={(event) =>
                  setSelection((current) => ({
                    ...current,
                    selectedIds: event.shiftKey ? [...new Set([...current.selectedIds, element.id])] : [element.id],
                    primaryId: element.id,
                  }))
                }
              >
                <span className="dk-layers__type">{element.type}</span>
                <span className="dk-layers__name">{name}</span>
                {role ? <span className="dk-layers__role">{role}</span> : null}
              </button>
              <button
                type="button"
                className="dk-layers__toggle"
                aria-pressed={locked}
                aria-label={locked ? `Unlock ${name}` : `Lock ${name}`}
                title={locked ? "Locked: only selectable here. Unlock" : "Lock"}
                data-testid="layer-lock"
                onClick={() => editor.apply(lockOperations(doc, element.id, !locked), { label: locked ? "Unlock" : "Lock" })}
              >
                <Icon name={locked ? "lock" : "unlock"} size={12} />
              </button>
              <button
                type="button"
                className="dk-layers__toggle"
                aria-pressed={hidden}
                aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
                title={hidden ? "Hidden from the slide and exports. Show" : "Hide"}
                data-testid="layer-hide"
                onClick={() => editor.apply(visibilityOperations(doc, element.id, hidden), { label: hidden ? "Show" : "Hide" })}
              >
                <Icon name={hidden ? "eyeOff" : "eye"} size={12} />
              </button>
            </li>
          );
        })}
        <li className="dk-layers__row dk-layers__row--fixed" aria-label="Slide background, always at the back">
          <span className="dk-layers__pick dk-layers__pick--static" style={{ paddingLeft: 8 }}>
            <span className="dk-layers__type">slide</span>
            <span className="dk-layers__name">Slide background</span>
          </span>
        </li>
      </ul>
    </>
  );
}
