/**
 * The shapes the workspace authority speaks.
 *
 * Types only — no runtime, no transport, no React. The web app, the desktop shell
 * and the MCP adapter all agree here and nowhere else, so a change to a request
 * body is a compile error in every surface rather than a runtime surprise in one.
 *
 * Document payloads are `@deckastra/presentation-schema` types, never restated:
 * doc 02 is the source of truth and a second description of a slide is a second
 * definition to drift.
 */
export * from "./agent";
export * from "./client";
export * from "./documents";
export * from "./errors";
export * from "./exports";
export * from "./generation";
export * from "./host";
export * from "./repositories";
export * from "./roles";
export * from "./session";
export * from "./shares";
export * from "./themes";
export * from "./render-host";
