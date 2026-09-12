/**
 * The membership ladder (doc 05 §12).
 *
 * A share's role is a real member role rather than an `is_public` boolean, so a
 * shared viewer and a workspace viewer are the same thing to every downstream
 * check. Kept in one place for the same reason the rule codes are.
 */
export type Role = "viewer" | "editor" | "admin" | "owner";
