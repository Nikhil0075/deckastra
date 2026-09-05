/**
 * @deckastra/presentation-schema
 *
 * The canonical `.mydeck` document model. This package is the source of truth for
 * the whole product: the renderer, the editor, the transaction layer, the export
 * adapters and the Python agent service all type-check against it.
 *
 * Two rules keep it that way (doc 02 §39):
 *
 *   1. If a fact about the presentation is not in the document, it does not exist.
 *      A feature that needs the renderer to remember something between sessions is
 *      a schema gap, not a renderer feature.
 *   2. If a fact is in the document but no one can agree on it, it does not belong
 *      there. Camera position, selection and hover state fail that test, which is
 *      why they live in editor state.
 *
 * This package must not depend on React, or on any renderer or animation runtime.
 */

export * from "./version.js";
export * from "./ids.js";
export * from "./primitives.js";
export * from "./limits.js";
export * from "./semantic-roles.js";
export * from "./text.js";
export * from "./layout.js";
export * from "./theme.js";
export * from "./animation.js";
export * from "./assets.js";
export * from "./data.js";
export * from "./elements.js";
export * from "./components.js";
export * from "./document.js";
export * from "./patch.js";
export * from "./serialize.js";
export * from "./validate.js";
