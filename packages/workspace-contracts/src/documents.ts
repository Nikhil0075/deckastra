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
  /**
   * The change that produced this version, when one is recorded.
   *
   * An editor that adopts someone else's work needs it: the inverse was computed
   * server-side against the pre-state, so undoing that change means naming it,
   * not recomputing it here.
   */
  transaction_id?: string | null;
  /** "user" or "agent" — who the deck moved under. */
  source?: string | null;
  intent?: string | null;
  /** Which surface authored it: `web-editor`, `desktop-editor`, `mcp:codex`. */
  client_id?: string | null;
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

/**
 * Render one slide as an image.
 *
 * One slide per call on purpose. A whole deck is a browser launch and a dozen
 * megabytes, and the caller that needs this — an agent showing what a change
 * would look like — needs the slide it changed, not the deck around it.
 */
export interface PreviewRequest {
  slide_id: string;
  /** The version the caller believes it is on. A moved deck is a 409, not a picture of something else. */
  expected_version_id?: string;
  /**
   * Render as this pending proposal *would* leave the deck, rather than as it
   * stands. The proposal is not applied; the operations are replayed onto a copy.
   */
  proposal_id?: string | null;
}

export interface PreviewResult {
  slide_id: string;
  /** PNG bytes, base64. The transport is JSON, and this is one image. */
  image_base64: string;
  width: number;
  height: number;
  /** The version the render was taken from, so a caller can tell it is current. */
  version_id: string;
  /** Every slide the proposal touches, so a caller knows what else to look at. */
  changed_slide_ids: string[];
  /** True when any text fell back to the estimator rather than a measurement. */
  metrics_estimated: boolean;
  /** The version a previewed proposal was written against, when one was named. */
  proposal_base_version_id?: string | null;
  /**
   * True when that base is no longer the head: the change still applies, but this
   * is not the change as it was written, and approval will ask for a fresh look.
   */
  rebased?: boolean;
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
