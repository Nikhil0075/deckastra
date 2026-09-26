/**
 * @deckastra/presentation-core
 *
 * Model-level operations over a `.mydeck` document (doc 05 §10). Pure: nothing
 * here reads the network, touches the filesystem, or mutates its input.
 *
 * Every operation emits `PatchOperation[]` rather than a modified document, so
 * there is exactly one way a deck changes — through `@deckastra/transactions`.
 * See the note at the top of `operations.ts` for why that matters more than it
 * first appears.
 */

export * from "./find";
export * from "./operations";
export * from "./references";
export * from "./starter-elements";
export * from "./groups";
