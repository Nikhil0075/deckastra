/**
 * Commit whatever text field has focus (audit follow-up, 2026-09-19).
 *
 * Fields that hold a draft — the speaker notes, an inspector number — commit on
 * blur. A click elsewhere blurs them; a keyboard shortcut, a menu command or a
 * programmatic press does not, so anything about to save the deck for someone
 * (leaving it, exporting it) blurs the field first and the draft is part of the
 * save rather than left behind in a field that is about to unmount or be
 * ignored. Buttons and other controls keep their focus.
 */
export function commitFocusedDraft(doc: Document = document): void {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (active.isContentEditable || active.tagName === "TEXTAREA" || active.tagName === "INPUT") active.blur();
}
