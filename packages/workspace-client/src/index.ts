/**
 * One implementation of the workspace authority contract.
 *
 * The types live in `@deckastra/workspace-contracts` and are not re-exported here
 * on purpose: two import paths for one type is how a codebase ends up with two
 * slightly different `Session`s. Import shapes from the contracts, behaviour from
 * here.
 *
 * The React provider is a separate entry point (`@deckastra/workspace-client/react`)
 * so a non-React consumer — the MCP adapter, a script — does not pull in React to
 * make an HTTP call.
 */
export { createHttpClient, type FetchLike, type HttpClientOptions } from "./http";
export { WorkspaceRequestError, messageFromDetail } from "./errors";
export { browserSessionStore, memorySessionStore, type SessionStore } from "./session-store";
