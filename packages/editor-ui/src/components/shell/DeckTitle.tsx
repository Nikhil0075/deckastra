import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { MAX_DECK_TITLE, cleanDeckTitle } from "../../lib/deck-title";

export interface DeckTitleInputProps {
  value: string;
  /** Called once, with the cleaned name, when the person keeps their edit. */
  onCommit: (title: string) => void;
  onCancel: () => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * The field a deck is renamed in, wherever its name is shown. Enter or leaving
 * the field keeps the name; Escape puts the old one back. An empty name is a
 * cancel, never a blank deck name.
 */
export function DeckTitleInput({ value, onCommit, onCancel, className, "data-testid": testId }: DeckTitleInputProps) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  // Blur follows Enter and Escape when the field unmounts; the first decision
  // stands and the blur that comes after it does nothing.
  const settled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (keep: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const title = cleanDeckTitle(draft);
    if (keep && title && title !== value) onCommit(title);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The editor's shortcuts must not see keys typed into a name.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <input
      ref={ref}
      className={["dk-input", "dk-deck-title-input", className].filter(Boolean).join(" ")}
      aria-label="Deck name"
      dir="auto"
      maxLength={MAX_DECK_TITLE}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      data-testid={testId}
    />
  );
}
