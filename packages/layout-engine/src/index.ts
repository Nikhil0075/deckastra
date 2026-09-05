/**
 * @deckastra/layout-engine
 *
 * The deterministic half of layout (doc 03 §2.3): geometry, container
 * resolution, constraint solving, text measurement and collision detection.
 *
 * Nothing here calls a model. It provides the tools the Layout Agent proposes
 * *against* — which is what lets an agent choose a layout without choosing a
 * coordinate.
 *
 * Determinism is a hard requirement, not a nicety: the editor, the headless
 * preview and every export adapter run this same code, and they must agree.
 */

export * from "./measure";
export * from "./container";
export * from "./constraints";
export * from "./validate";
