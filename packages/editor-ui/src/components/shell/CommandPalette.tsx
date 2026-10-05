import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { HostCommand } from "@deckastra/workspace-contracts";

import { findCommands, type PaletteItem } from "../../lib/commands";
import { Icon } from "../../ui";
import { cx } from "../../ui/cx";
import { floatingPortal } from "../../ui/overlays";

/**
 * Ctrl+K (roadmap 08 §1.5): every command by name, and the assistant for
 * anything that is not one.
 *
 * A modal combobox: the field keeps focus and the arrows move the active row
 * (`aria-activedescendant`), which is the pattern screen readers announce
 * correctly for a filtered list. Choosing a command hands its name to the
 * shell's one dispatcher, the same function the desktop menu calls, so the
 * palette cannot drift from the menu. "Ask the assistant" opens the assistant
 * with the words already in its prompt and stops there: what a request costs and
 * what it sends are shown at the assistant's Run button (rule 6), so the palette
 * never sends anything itself.
 */
export function CommandPalette({
  open,
  onClose,
  onCommand,
  onAsk,
  canExit,
  canOpenSettings = false,
  place = "deck",
}: {
  open: boolean;
  onClose: () => void;
  onCommand: (command: HostCommand) => void;
  onAsk: (text: string) => void;
  canExit: boolean;
  canOpenSettings?: boolean;
  /**
   * The home has no deck to act on: it offers what applies there, and words
   * typed become a deck to draft rather than a request to the assistant.
   */
  place?: "deck" | "home";
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const items = useMemo(() => findCommands(query, { canExit, canOpenSettings, place }), [query, canExit, canOpenSettings, place]);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    input.current?.focus();
    return () => {
      // Back where the person was, unless what they chose moved focus on
      // purpose (the assistant's prompt).
      const moved = document.activeElement && document.activeElement !== document.body;
      if (!moved) returnTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "ask") onAsk(item.text);
    else onCommand(item.entry.command);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Nothing typed here is an editor shortcut.
    event.stopPropagation();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + items.length) % items.length);
    } else if (event.key === "Home" && !query) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && !query) {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // Modal: there is nowhere else in it to go.
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      // The key that opened it puts it away.
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return floatingPortal(
    <div className="dk-root dk-palette__scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dk-palette" role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette">
        <div className="dk-palette__field">
          <Icon name="search" size={16} />
          <input
            ref={input}
            className="dk-palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={items[active] ? `${id}-item-${active}` : undefined}
            aria-autocomplete="list"
            aria-label={place === "home" ? "Type a command, or describe a deck" : "Type a command, or ask the assistant"}
            placeholder={place === "home" ? "Type a command, or describe a deck…" : "Type a command, or ask the assistant…"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="command-palette-input"
          />
        </div>
        <ul className="dk-palette__list" role="listbox" id={`${id}-list`} aria-label="Commands">
          {items.map((item, index) => {
            const group = item.kind === "ask" ? (place === "home" ? "New deck" : "Assistant") : item.entry.group;
            const heading = group !== lastGroup ? group : null;
            lastGroup = group;
            return (
              <li key={item.kind === "ask" ? "ask" : item.entry.command} role="presentation">
                {heading ? (
                  <div className="dk-palette__group" aria-hidden="true">
                    {heading}
                  </div>
                ) : null}
                <div
                  id={`${id}-item-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={cx("dk-palette__item", index === active && "dk-palette__item--active")}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                  data-testid={item.kind === "ask" ? "command-ask" : `command-${item.entry.command}`}
                >
                  {item.kind === "ask" ? (
                    <>
                      <Icon name="ai" size={14} />
                      <span className="dk-palette__label">
                        {place === "home" ? "Describe a deck" : "Ask the assistant"}: <q>{item.text}</q>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="dk-palette__label">{item.entry.label}</span>
                      {item.entry.shortcut ? <kbd className="dk-palette__key">{item.entry.shortcut}</kbd> : null}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
  );
}
