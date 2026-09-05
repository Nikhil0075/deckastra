/**
 * @deckastra/transactions
 *
 * The only code in the product that mutates a `.mydeck` document.
 *
 * Everything else — the editor, the agents, an import, a data refresh — produces
 * a patch and hands it here. That single path is what makes every change
 * invertible, auditable and attributable without any of those being bolted on
 * afterwards.
 */

export * from "./path";
export * from "./apply";
export * from "./transaction";
export * from "./history";
