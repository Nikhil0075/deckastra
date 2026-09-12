import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { Role } from "./roles";

/**
 * A share link is a bearer credential.
 *
 * `token` is present exactly once — on the response that created it — because the
 * authority stores only a hash. A later read cannot repopulate it, and the type
 * says so by making it optional rather than by a comment somewhere else.
 */
export interface Share {
  id: string;
  /**
   * Only "viewer" can be created: nothing in the product can redeem an editing
   * link, and storing a role the product cannot honour tells whoever made the link
   * that they granted something they did not. Older links are still read.
   */
  role: Role;
  label: string | null;
  created_at: string | null;
  expires_at: string | null;
  /** Revoked, not deleted — "who could see this, and when did that stop". */
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  status: "active" | "expired" | "revoked";
  token?: string;
}

export interface CreateShareRequest {
  role: "viewer";
  expires_in_days: number | null;
}

/**
 * What redeeming a share token returns: one document, and nothing about the
 * workspace around it. This is the only unauthenticated read in the product.
 */
export interface SharedDocument {
  presentation_id: string;
  title: string;
  document: PresentationDocument;
  version_id: string;
  /**
   * What the holder may do. Only "viewer" is honoured today: `/v1/shared/{token}`
   * returns a document and the shared page only presents it. The field stays so
   * token-scoped editing needs a write path rather than a migration.
   */
  role: Role;
}
