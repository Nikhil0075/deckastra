/**
 * @deckastra/editor
 *
 * The editor's interaction model: selection, hit testing, transforms, snapping,
 * clipboard and keyboard. Pure logic — no React, no DOM ownership — so every
 * behaviour here is testable without a browser and reusable by the desktop shell.
 *
 * Two rules this package exists to enforce:
 *
 * 1. **Editor state never touches the document** (doc 02 §4.1). Selection, hover,
 *    isolation and the marquee live here and are never serialized.
 * 2. **Every change is a patch.** Nothing mutates a document; operations are
 *    composed with `@deckastra/presentation-core` and applied through
 *    `@deckastra/transactions`, so a toolbar edit and an agent edit are the same
 *    thing.
 */

export * from "./selection";
export * from "./text-editing";
export * from "./transform";
export * from "./snapping";
export * from "./spatial-index";
export * from "./clipboard";
export * from "./keyboard";
