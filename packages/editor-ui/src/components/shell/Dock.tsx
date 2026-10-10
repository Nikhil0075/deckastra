import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { DOCK_TABS, selectDockTab, type DockState, type DockTab } from "../../lib/dock";
import { rovingIndex } from "../../lib/ui-keys";
import { IconButton } from "../../ui";
import { cx } from "../../ui/cx";

/**
 * The collapsible region under the canvas (roadmap 08 §1.5): speaker notes and
 * the motion timeline as tabs.
 *
 * Collapsed, it is one row of tab names, so the slide gets the height back and
 * the notes are still one press away. Only the showing tab is mounted: a
 * collapse or a tab change unmounts the notes field, and that field commits its
 * draft to the slide it was written on as it unmounts (`SpeakerNotes`), so
 * putting the dock away never loses a sentence.
 *
 * One F6 region whichever tab shows. It used to be two (notes, timeline), and a
 * region that exists only when its tab is open would make the F6 walk change
 * shape as the dock does.
 */
export function Dock({
  state,
  onChange,
  height,
  resizer,
  panels,
}: {
  state: DockState;
  onChange: (next: DockState) => void;
  /** Height of the open body, in px. */
  height: number;
  /**
   * The splitter that resizes the open body, drawn on its top edge. The body
   * reads `--dk-dock-height` first, so a drag can be shown by setting that
   * variable without re-rendering the editor every frame.
   */
  resizer?: ReactNode;
  /** What each tab shows. A tab with nothing to show (no slide) is still offered and draws `null`. */
  panels: Record<DockTab, ReactNode>;
}) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = DOCK_TABS.findIndex((tab) => tab.value === state.tab);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = rovingIndex(index, DOCK_TABS.length, event.key, { orientation: "horizontal" });
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    // Arrowing between tabs of a closed dock moves focus and nothing else:
    // opening it under the person's arrow keys would move the slide they are
    // looking at.
    if (state.open) onChange(selectDockTab(state, DOCK_TABS[next]!.value));
  };

  return (
    <section
      className={cx("dk-dockbar", state.open && "dk-dockbar--open")}
      aria-label="Notes and timeline"
      data-region="dock"
      data-testid="dock"
      data-dock-open={state.open ? "true" : "false"}
      data-dock-tab={state.tab}
    >
      {state.open ? resizer : null}
      <div className="dk-dockbar__head">
        <div role="tablist" aria-label="Dock" className="dk-dockbar__tabs">
          {DOCK_TABS.map((tab, index) => {
            const showing = state.open && tab.value === state.tab;
            return (
              <button
                key={tab.value}
                ref={(element) => {
                  refs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${tab.value}`}
                aria-selected={showing}
                aria-controls={showing ? `${id}-panel` : undefined}
                tabIndex={index === Math.max(0, activeIndex) ? 0 : -1}
                className={cx("dk-tabs__tab", "dk-dockbar__tab", showing && "dk-tabs__tab--active")}
                data-testid={`dock-tab-${tab.value}`}
                onClick={() => onChange(selectDockTab(state, tab.value))}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <IconButton
          icon={state.open ? "chevronDown" : "chevronUp"}
          label={state.open ? "Hide the dock" : "Show the dock"}
          size="sm"
          aria-expanded={state.open}
          onClick={() => onChange({ ...state, open: !state.open })}
          data-testid="dock-toggle"
        />
      </div>
      {state.open ? (
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${state.tab}`}
          className="dk-dockbar__body dk-scroll"
          style={{ height: `var(--dk-dock-height, ${height}px)` }}
          data-dock-panel={state.tab}
        >
          {panels[state.tab]}
        </div>
      ) : null}
    </section>
  );
}
