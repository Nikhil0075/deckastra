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
  /**
   * Slides in the current version. Maintained on every commit, so a deck list
   * can show it without replaying the deck. Null only for a deck written before
   * the count existed and not yet listed once.
   */
  slide_count?: number | null;
  /** Proposals waiting for someone to approve or reject them. */
  pending_proposals?: number;
  /** Present only in the trash listing: when the deck was deleted. */
  deleted_at?: string;
}

export interface DeletePresentationResult {
  presentation_id: string;
  deleted_at: string;
}

export interface RestorePresentationResult {
  presentation_id: string;
  restored: boolean;
}

export interface DuplicatePresentationResult {
  presentation_id: string;
  version_id: string;
  title: string;
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
  /**
   * Declare that this change resolves the deck's sync divergence (D5.3).
   *
   * On the transaction rather than a route of its own, and that is the point: an
   * acknowledgement arriving *after* the merge is a second operation, and
   * anything committed in the gap between them was retired by mistake. As one
   * request the gap does not exist — and because the commit is refused when the
   * head has moved, nothing queued at the moment of retirement can postdate the
   * merge.
   */
  resolves?: ResolvesConflict;
}

/**
 * What was merged, so a resolution is more than a change made afterwards.
 *
 * Time alone proves nothing: an ordinary edit written a minute after the server
 * refused something satisfies "later than the refusal", and so does an agent's
 * low-risk change. These three make the change an **explicit declaration against
 * validated versions** — the conflict, the remote version it is declared against,
 * and the local version it was reviewed against. Supplying them is not evidence
 * that a person fetched, viewed or understood the divergence.
 */
export interface ResolvesConflict {
  /** Which conflict — so resolving a stale one cannot retire whatever is blocked now. */
  change_key: string;
  /** The server's version this change is declared against; validated, not proof of review. */
  remote_version_id: string;
  /** The local version that was reviewed, which must be the one committed against. */
  local_version_id: string;
}

export interface TransactionResult {
  transaction_id: string;
  version_id: string;
  /** How many queued changes a resolution retired, when this was one. */
  retired?: number | null;
}

/**
 * One point in a deck's history, as `GET /presentations/{id}/versions` returns
 * it, newest first.
 *
 * This type used to declare `version_id`, `intent` and `source` while the route
 * returned `id`, `label`, `created_by` and no intent at all, so nothing typed
 * against it could have worked; the first reader (the version history drawer,
 * editor Phase 5) is the reason it now matches.
 */
export interface VersionSummary {
  id: string;
  parent_version_id: string | null;
  /** Who created the version row ("user", "agent", …), set when it was written. */
  source: string;
  label: string | null;
  created_by: string;
  created_at: string;
  is_snapshot: boolean;
  /** The change that produced this version. All null for a deck's first version. */
  transaction_id?: string | null;
  intent?: string | null;
  agent_id?: string | null;
  change_source?: string | null;
}

/** What restoring a version returns: the new version the restore created. */
export interface RestoreVersionResult {
  transaction_id: string;
  version_id: string;
  document: PresentationDocument;
  risk_tier: string;
}

/**
 * Where one deck was moved to, and whether it moved (D5.1).
 *
 * The only path a deck takes between workspaces. `moved: false` with a `refusal`
 * is the no-op case — it was already there — rather than an error, because
 * asking for a move that has already happened is not a mistake.
 *
 * What is absent is the point: there is no bulk move, no "sync my decks" and no
 * move an agent can perform. A deck leaving the machine it was authored on is a
 * decision a person makes one deck at a time.
 */
export interface MovePresentationResult {
  presentation_id: string;
  project_id: string;
  workspace_id: string;
  from_workspace_id?: string;
  moved: boolean;
  refusal?: string;
  /** Unchanged by a move. Said out loud, because a move must not look like a new deck. */
  version_id?: string | null;
}

/**
 * A file the workspace now holds, as its uploader needs it.
 *
 * `storage_key` is here and deliberately **not** on the asset *list*: a list has
 * no reason to hand out paths into a bucket, while the person who just uploaded
 * one is about to cite it from a document, where doc 02 stores the opaque key by
 * design.
 */
export interface UploadedAsset {
  id: string;
  kind: string;
  filename: string | null;
  content_type: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  storage_key: string;
}
