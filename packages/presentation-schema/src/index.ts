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

export * from "./version";
export * from "./ids";
export * from "./primitives";
export * from "./limits";
export * from "./semantic-roles";
export * from "./text";
export * from "./layout";
export * from "./theme";
export * from "./animation";
export * from "./assets";
export * from "./data";
export * from "./elements";
export * from "./components";
export * from "./document";
export * from "./patch";
export * from "./serialize";
export * from "./validate";
