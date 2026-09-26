/**
 * @deckastra/renderer
 *
 * A deterministic interpreter of the .mydeck model, not the owner of any
 * presentation state (doc 04 §40). Because it is a pure function of the document,
 * the same code can run in the editor, in a worker, and headlessly on behalf of
 * an agent — without a second implementation.
 *
 * The React surface is a separate entry point (`@deckastra/renderer/react`) so
 * that scene building stays usable in Node, where the headless render service and
 * the tests need it.
 */

export * from "./matrix";
export * from "./theme";
export * from "./shapes";
export * from "./text-metrics";
export * from "./dom-measurer";
export * from "./format";
export * from "./scale";
export * from "./fonts";
export * from "./font-library";
export * from "./icons";
export * from "./highlight";
export * from "./equation";
export * from "./charts";
export * from "./diagram";
export * from "./scene";
export * from "./perf";
export * from "./semantic";
export * from "./accessibility";
export * from "./layout-check";
export * from "./digest";
