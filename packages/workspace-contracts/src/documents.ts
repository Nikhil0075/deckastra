import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

/** A deck as the authority hands it over, with the version it was read at. */
export interface DocumentRead {
  document: PresentationDocument;
  version_id: string;
  can_edit: boolean;
}

/**
 * Which version is current, without the document.
 *
 * What an open editor polls to learn that someone else — an agent, another
 * window — changed the deck under it. A full read replays the version chain,
 * which is the wrong thing to do on a timer when nothing has usually changed.
 */
export interface DocumentHead {
  presentation_id: string;
  version_id: string;
}

/**
 * A deck in a project, without its content.
 *
 * What a picker — or an agent asked "which decks do I have" — needs: enough to
 * name and address a deck, and nothing that would make listing a project cost
 * a replay of every deck in it.
 */
export interface PresentationSummary {
  id: string;
  title: string;
  version_id: string | null;
  updated_at: string | null;
}

export interface CreatePresentationRequest {
  title: string;
  project_id?: string | null;
}

export interface CreatePresentationResult {
  presentation_id: string;
  version_id: string;
}

export interface TransactionRequest {
  operations: PatchOperation[];
  intent: string;
  /**
   * Optimistic concurrency (doc 02 §31). A mismatch is a 409 and never a
   * last-write-wins overwrite, so this is required rather than optional — a
   * caller that could omit it would eventually omit it.
   */
  expected_version_id: string;
  /**
   * Which surface authored the patch. `packages/presentation-schema/src/patch.ts`
   * reserves a member for a non-web client; the desktop shell is not "web-editor"
   * and provenance that says it is, lies.
   */
  client_id: string;
}

export interface TransactionResult {
  transaction_id: string;
  version_id: string;
}

export interface VersionSummary {
  version_id: string;
  created_at: string;
  intent: string | null;
  source: string;
}
