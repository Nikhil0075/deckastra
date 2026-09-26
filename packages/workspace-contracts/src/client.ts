import type { PresentationDocument } from "@deckastra/presentation-schema";

import type { AgentEditResult, AppliedChange, EditScopePayload, PendingProposal, ProposalDetail } from "./agent";
import type {
  CreatePresentationRequest,
  CreatePresentationResult,
  DocumentHead,
  DocumentRead,
  MovePresentationResult,
  DeletePresentationResult,
  RestorePresentationResult,
  DuplicatePresentationResult,
  PreviewRequest,
  PreviewResult,
  PresentationSummary,
  TransactionRequest,
  TransactionResult,
  VersionSummary,
  RestoreVersionResult,
} from "./documents";
import type { ExportJob, ExportRequest } from "./exports";
import type {
  MotionCapabilities,
  MotionRequest,
  MotionResult,
  TransitionRequest,
  TransitionResult,
} from "./motion";
import type { GenerateRequest, GenerateResult, ReviewedGeneration, StoryDecision } from "./generation";
import type { Repository, RepositoryList, SlideSources } from "./repositories";
import type { AccountContext, AccountProject, HealthReport, Session } from "./session";
import type { UploadedAsset } from "./documents";
import type { CreateShareRequest, Share, SharedDocument } from "./shares";
import type { ImportedTheme, SaveThemeRequest, SavedTheme, ThemeList, ThemeProposal } from "./themes";

/**
 * Per-call transport options.
 *
 * `keepalive` is on the interface rather than inside the transport because
 * exactly one caller needs it and needs it conditionally: the autosave drain,
 * which uses it on unload for small batches because a browser cancels ordinary
 * in-flight fetches from a page it is tearing down. A transport that always set
 * it would hit the browser's small keepalive body cap on a large patch.
 */
export interface RequestOptions {
  signal?: AbortSignal;
  keepalive?: boolean;
  /**
   * Refuse a cached answer.
   *
   * Transport-neutral on purpose: conflict review needs the head as it is *now*,
   * and phrasing that as an HTTP cache mode would make the desktop transport
   * implement a header it does not have.
   */
  fresh?: boolean;
}

/**
 * The workspace authority, as every surface sees it.
 *
 * One interface, two implementations: HTTP against the cloud API, and the same
 * HTTP against a loopback sidecar on the desktop. Components never learn which,
 * which is the point — a component that read `process.env.NEXT_PUBLIC_API_URL`
 * could not be mounted anywhere else, and ten of them did.
 *
 * Everything here is authority-side work. Anything the *host* must do — a native
 * save dialog, a second window, opening a folder — belongs on `HostBridge`, and
 * the two are deliberately not merged: HTTP cannot express the second, and giving
 * document content a path to it would be a security regression rather than a
 * convenience.
 *
 * Auth is not a parameter. The client is constructed with a token provider, so a
 * bearer token is a property of the transport and not something twelve components
 * thread through props toward a place they cannot see.
 */
export interface WorkspaceClient {
  /** Which surface authored a patch. Recorded on every transaction. */
  readonly clientId: string;

  /** Unauthenticated. Answers whether generation has a real key configured. */
  health(options?: RequestOptions): Promise<HealthReport>;

  readonly session: {
    /** The current session, bootstrapping one if there is none. */
    ensure(options?: RequestOptions): Promise<Session>;
    /** Forget the cached session. The next `ensure` bootstraps again. */
    clear(): void;
    account(options?: RequestOptions): Promise<AccountContext>;
    createWorkspace(
      name: string,
      options?: RequestOptions,
    ): Promise<{ workspace_id: string; project_id: string }>;
    createProject(
      workspaceId: string,
      name: string,
      description?: string,
      options?: RequestOptions,
    ): Promise<AccountProject>;
    /** Remember which project new decks go to. Local to this surface. */
    selectProject(workspaceId: string, projectId: string): void;
  };

  readonly documents: {
    create(
      body: CreatePresentationRequest,
      options?: RequestOptions,
    ): Promise<CreatePresentationResult>;
    read(presentationId: string, options?: RequestOptions): Promise<DocumentRead>;
    /** One slide as a PNG — as stored, or as a pending proposal would leave it. */
    preview(
      presentationId: string,
      body: PreviewRequest,
      options?: RequestOptions,
    ): Promise<PreviewResult>;
    /** The decks in one project, most recently changed first. No content. */
    list(projectId: string, options?: RequestOptions): Promise<PresentationSummary[]>;
    /** The current version id and nothing else. Cheap enough to poll. */
    head(presentationId: string, options?: RequestOptions): Promise<DocumentHead>;
    /**
     * Read a deck as it stood at one version.
     *
     * Conflict review uses this to recover the base the local edits were authored
     * on, so it must not be served from a cache: a stale base silently turns a
     * three-way merge into a two-way one.
     */
    readAt(
      presentationId: string,
      versionId: string,
      options?: RequestOptions,
    ): Promise<DocumentRead>;
    commit(
      presentationId: string,
      body: TransactionRequest,
      options?: RequestOptions,
    ): Promise<TransactionResult>;
    versions(presentationId: string, options?: RequestOptions): Promise<VersionSummary[]>;
    /**
     * Put the deck back to an earlier version, as a new change (editor Phase 5).
     * `expectedVersionId` is the head the person was looking at; a deck that
     * moved since is a 409, never a restore over work they did not see.
     */
    restoreVersion(
      presentationId: string,
      versionId: string,
      expectedVersionId: string,
      options?: RequestOptions,
    ): Promise<RestoreVersionResult>;
    /**
     * Move one deck to another project — the only way a deck changes workspace.
     *
     * Here rather than on a "sync" surface because that is the whole design:
     * signing in adds a workspace and conscripts nothing, so a deck reaches a
     * shared workspace exactly when someone names it and names where it goes.
     */
    move(
      presentationId: string,
      projectId: string,
      options?: RequestOptions,
    ): Promise<MovePresentationResult>;
    /**
     * Move a deck to its project's trash. Soft and undoable: every read treats
     * it as missing (share links included) until `restore` brings it back.
     */
    delete(presentationId: string, options?: RequestOptions): Promise<DeletePresentationResult>;
    /** Bring a deleted deck back exactly as it was. A no-op if it is not deleted. */
    restore(presentationId: string, options?: RequestOptions): Promise<RestorePresentationResult>;
    /** A new deck in the same project, with fresh ids throughout. */
    duplicate(presentationId: string, options?: RequestOptions): Promise<DuplicatePresentationResult>;
    /** The decks in one project's trash, most recently deleted first. */
    trash(projectId: string, options?: RequestOptions): Promise<PresentationSummary[]>;
  };

  readonly generation: {
    run(body: GenerateRequest, options?: RequestOptions): Promise<GenerateResult>;
    /**
     * Generate, stopping at the outline for the person to approve or revise.
     * Only where `capabilities.checkpoints` says a run can pause.
     */
    review(body: GenerateRequest, options?: RequestOptions): Promise<ReviewedGeneration>;
    /** The outline a paused run is waiting on, read from its checkpoint. */
    checkpoint(runId: string, options?: RequestOptions): Promise<ReviewedGeneration>;
    /** Approve, revise or discard a paused outline. */
    decide(runId: string, decision: StoryDecision, options?: RequestOptions): Promise<ReviewedGeneration>;
  };

  /**
   * Motion, planned in roles and composed into tracks server-side.
   *
   * Deliberately its own section rather than a document write: what a caller
   * sends is intent, and the durations come back computed. A caller that could
   * send milliseconds would be a caller that could over-run the entrance budget.
   */
  readonly motion: {
    capabilities(options?: RequestOptions): Promise<MotionCapabilities>;
    propose(
      presentationId: string,
      body: MotionRequest,
      options?: RequestOptions,
    ): Promise<MotionResult>;
    /** Set how the deck moves into one slide, planned in roles. */
    proposeTransition(
      presentationId: string,
      body: TransitionRequest,
      request?: RequestOptions,
    ): Promise<TransitionResult>;
  };

  readonly agent: {
    edit(
      presentationId: string,
      body: { instruction: string; scope: EditScopePayload },
      options?: RequestOptions,
    ): Promise<AgentEditResult>;
    proposals(presentationId: string, options?: RequestOptions): Promise<PendingProposal[]>;
    /** One pending proposal with its operations. */
    proposal(presentationId: string, proposalId: string, options?: RequestOptions): Promise<ProposalDetail>;
    /**
     * Approve a pending proposal.
     *
     * `expectedVersionId` is the version the approver was *shown*. Without it the
     * authority refuses a deck that has moved since the proposal was made, because
     * applying then means applying a change to something nobody reviewed. A
     * surface that has the current deck on screen passes what it displayed.
     */
    approve(
      presentationId: string,
      proposalId: string,
      expectedVersionId?: string,
      options?: RequestOptions,
    ): Promise<AppliedChange>;
    reject(
      presentationId: string,
      proposalId: string,
      reason?: string,
      options?: RequestOptions,
    ): Promise<unknown>;
    /**
     * Undo one agent change server-side.
     *
     * Not the editor's local undo: an agent change was applied by the server and
     * its inverse computed there against the pre-state, which the browser never
     * had. Reverting through the same path is what makes "undo only that
     * transaction" true rather than approximately true.
     */
    revert(
      presentationId: string,
      transactionId: string,
      options?: RequestOptions,
    ): Promise<AppliedChange>;
  };

  readonly exports: {
    start(
      presentationId: string,
      body: ExportRequest,
      options?: RequestOptions,
    ): Promise<ExportJob>;
    status(exportId: string, options?: RequestOptions): Promise<ExportJob>;
    cancel(exportId: string, options?: RequestOptions): Promise<ExportJob>;
    retry(exportId: string, options?: RequestOptions): Promise<ExportJob>;
    /**
     * The finished file.
     *
     * Bytes rather than a URL: the endpoint needs an Authorization header and a
     * bare anchor cannot carry one. The desktop implementation hands these to
     * `HostBridge.saveFile` instead of a blob URL, because a packaged app's
     * renderer cannot start a download.
     */
    download(exportId: string, options?: RequestOptions): Promise<Blob>;
  };

  readonly shares: {
    list(presentationId: string, options?: RequestOptions): Promise<Share[]>;
    create(
      presentationId: string,
      body: CreateShareRequest,
      options?: RequestOptions,
    ): Promise<Share>;
    revoke(shareId: string, options?: RequestOptions): Promise<void>;
    /** Unauthenticated. The token in the URL is the entire credential. */
    redeem(token: string, options?: RequestOptions): Promise<SharedDocument>;
  };

  /**
   * Turning an asset into something an `<img>` can load.
   *
   * This is on the client and not in the renderer because **the two shells
   * cannot authenticate an image the same way**, which is the reason nothing in
   * the product resolved one until now.
   *
   * The desktop's base URL is a path on the renderer's own origin
   * (`/__api`), and the main process injects the bearer as the request passes
   * through — so an `<img src>` pointing at the blob route simply works, and the
   * page still never learns the token or the port. The web app's base URL is
   * another origin and its credential is an `Authorization` header, which an
   * `<img>` cannot send: there the bytes have to be fetched and handed over as an
   * object URL.
   *
   * `directUrl` answers only for the first case, synchronously, because the
   * renderer's `resolveAssetUrl` is synchronous. `fetchBlob` is the other half,
   * and `useAssetUrls` in `editor-ui` is what turns the pair into one resolver a
   * component can call.
   */
  readonly assets: {
    /**
     * A URL the browser can load on its own, or `undefined` when it cannot.
     *
     * Undefined is not a failure — it means "this deployment needs the bytes
     * fetched with a credential", which is the web app's ordinary case.
     */
    directUrl(storageKey: string): string | undefined;
    /** The bytes, with whatever credential this client holds. */
    fetchBlob(storageKey: string, options?: RequestOptions): Promise<Blob>;
    /**
     * Put a file in the workspace and answer what a document needs to cite it.
     *
     * Three requests behind one call — ask where to put it, PUT the bytes,
     * register the row — because the middle one carries a subtlety a caller
     * should not have to know: a **relative** upload URL is this API's own blob
     * route and needs our bearer, while an **absolute** one is a presigned
     * object-store URL whose signature *is* the credential, and attaching a
     * second one to it is how a presigned PUT gets rejected.
     *
     * Registering is what charges the quota, so a workspace at its limit is
     * refused here rather than after the bytes are already stored.
     */
    upload(
      file: File,
      body: { workspaceId: string; width?: number; height?: number },
      options?: RequestOptions,
    ): Promise<UploadedAsset>;
  };

  readonly themes: {
    /** Presentation-scoped, so a deck in a second workspace sees that workspace's themes. */
    list(presentationId: string, options?: RequestOptions): Promise<ThemeList>;
    proposal(
      presentationId: string,
      themeId: string,
      options?: RequestOptions,
    ): Promise<ThemeProposal>;
    save(
      presentationId: string,
      body: SaveThemeRequest,
      options?: RequestOptions,
    ): Promise<SavedTheme>;
    /** Read a PowerPoint theme (.thmx) or template (.pptx). Changes nothing. */
    importOffice(presentationId: string, file: Blob, options?: RequestOptions): Promise<ImportedTheme>;
  };

  readonly repositories: {
    list(workspaceId?: string, options?: RequestOptions): Promise<RepositoryList>;
    connectLocal(
      path: string,
      label?: string,
      workspaceId?: string,
      options?: RequestOptions,
    ): Promise<Repository>;
    index(
      id: string,
      workspaceId?: string,
      options?: RequestOptions,
    ): Promise<Repository & { index: unknown }>;
    disconnect(
      id: string,
      workspaceId?: string,
      options?: RequestOptions,
    ): Promise<{ status: string }>;
    slideSources(
      presentationId: string,
      slideId: string,
      options?: RequestOptions,
    ): Promise<SlideSources>;
  };
}

/** A document the caller already holds, for surfaces that render without reading. */
export interface LoadedDocument {
  document: PresentationDocument;
  versionId: string;
}
