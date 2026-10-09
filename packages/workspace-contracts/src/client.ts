import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { AssistantRequest, AssistantRun, AssistantEvent, AssistantCapabilities, AssistantAsset, AssetMetadataUpdate, DesignCheckResult, ImageQuoteRequest } from "./assistant";

import type { AppliedChange, PendingProposal, ProposalDetail } from "./agent";
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
  MotionPreviewRequest,
  MotionPreviewResult,
  PresentationSummary,
  TransactionRequest,
  TransactionResult,
  VersionSummary,
  RestoreVersionResult,
  SlideSources,
} from "./documents";
import type { ExportJob, ExportRequest } from "./exports";
import type {
  MotionCapabilities,
  MotionRequest,
  MotionResult,
  MotionStyleRequest,
  MotionStyleResult,
  TransitionRequest,
  TransitionResult,
} from "./motion";
import type { ComposedDeckResult, DeckComposeRequest, DeckFromTemplateRequest, InsertPatternRequest, InsertPatternResult, PresetCatalog } from "./presets";
import type { AccountContext, AccountProject, HealthReport, Session } from "./session";
import type { UploadedAsset } from "./documents";
import type { CreateShareRequest, Share, SharedDocument } from "./shares";
import type { ImportedTheme, SaveThemeRequest, SavedTheme, ThemeList, ThemeProposal } from "./themes";
import type { LanguagesStatus, PaidServiceQuote, SynthesizeRequest, SynthesizeResult, TranslateRequest, TranslateResult, Voice } from "./languages";

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
  readonly assistant?: {
    capabilities(options?: RequestOptions & { presentationId?: string; slideId?: string; locale?: string }): Promise<AssistantCapabilities>;
    quoteImage(presentationId: string, request: ImageQuoteRequest, options?: RequestOptions): Promise<PaidServiceQuote>;
    start(request: AssistantRequest, options?: RequestOptions): Promise<AssistantRun>;
    get(runId: string, options?: RequestOptions): Promise<AssistantRun>;
    list(presentationId: string, options?: RequestOptions): Promise<{ runs: AssistantRun[] }>;
    events(runId: string, after?: number, options?: RequestOptions): Promise<{ events: AssistantEvent[] }>;
    cancel(runId: string, options?: RequestOptions): Promise<AssistantRun>;
    resume(runId: string, options?: RequestOptions): Promise<AssistantRun>;
    designCheck(presentationId: string, slideId?: string, options?: RequestOptions): Promise<DesignCheckResult>;
    assetList(request: { workspace_id?: string; filter?: "all" | "unused" | "untagged"; cursor?: string; q?: string; limit?: number }, options?: RequestOptions): Promise<{ assets: AssistantAsset[]; next_cursor: string | null }>;
    assetView(assetId: string, maxPx?: number, options?: RequestOptions, crop?: { x: number; y: number; width: number; height: number }): Promise<{ asset_id: string; base64: string; mime_type: string; width: number; height: number }>;
    assetUpdate(assetId: string, request: AssetMetadataUpdate, options?: RequestOptions): Promise<AssistantAsset>;
    assetRevert(assetId: string, changeId: string, options?: RequestOptions): Promise<AssistantAsset>;
    assetDuplicates(workspaceId?: string, cursor?: string, options?: RequestOptions): Promise<{ groups: { asset_ids: string[]; kind: "exact" | "candidate"; distance: number | null }[]; partial: boolean; next_cursor: string | null }>;
  };
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
    /**
     * The account's AI credits. Optional: a service without an account (an
     * older one, or a stand-in) offers none, and the meter is then absent.
     */
    credits?(options?: RequestOptions): Promise<import("./session").CreditBalance>;
    /** Which hosted AI tasks are available, and why not. Optional, like credits. */
    capabilities?(options?: RequestOptions): Promise<import("./session").AccountCapabilities>;
    /**
     * Ask the service to erase this cloud account. Optional: a local install has
     * no cloud account to erase. Rejects with 409 when the person still owns a
     * shared workspace.
     */
    deleteAccount?(options?: RequestOptions): Promise<import("./session").AccountDeletion>;
    /** The status of a deletion request. Needs no session: the request ended it. */
    deletionStatus?(receipt: string, options?: RequestOptions): Promise<{ status: string }>;
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
    /**
     * The person's own editor settings, kept by the service so they follow the
     * person between devices (design review, 2026-09-27). Optional: a surface
     * with no service to keep them keeps them locally instead.
     */
    readPreference?(key: "library" | "translation" | "pronunciations" | "speech", options?: RequestOptions): Promise<unknown>;
    writePreference?(key: "library" | "translation" | "pronunciations" | "speech", value: unknown, options?: RequestOptions): Promise<void>;
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
    /** A time-labelled contact sheet sampled from the slide's motion timeline. */
    motionPreview(
      presentationId: string,
      body: MotionPreviewRequest,
      options?: RequestOptions,
    ): Promise<MotionPreviewResult>;
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
    /** Evidence embedded in one slide by an agent or import. */
    slideSources(
      presentationId: string,
      slideId: string,
      options?: RequestOptions,
    ): Promise<SlideSources>;
  };

  /** Deterministic starting points and composition. No model is called. */
  readonly presets: {
    list(options?: RequestOptions): Promise<PresetCatalog>;
    create(body: DeckFromTemplateRequest, options?: RequestOptions): Promise<ComposedDeckResult>;
    compose(body: DeckComposeRequest, options?: RequestOptions): Promise<ComposedDeckResult>;
    insertPattern(
      presentationId: string,
      body: InsertPatternRequest,
      options?: RequestOptions,
    ): Promise<InsertPatternResult>;
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
    /** Apply one reviewed motion style across the deck. */
    proposeStyle(
      presentationId: string,
      body: MotionStyleRequest,
      request?: RequestOptions,
    ): Promise<MotionStyleResult>;
  };

  readonly agent: {
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

  /**
   * Bringing a `.mydeck` file in. Optional: the desktop opens files through its
   * main process instead, and a stand-in may offer neither.
   */
  readonly imports?: {
    /** Begin, upload the bytes, and complete. Resolves once the service has the file queued. */
    upload(projectId: string, file: Blob, options?: RequestOptions): Promise<import("./exports").DeckImport>;
    status(importId: string, options?: RequestOptions): Promise<import("./exports").DeckImport>;
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
    /**
     * Where a shared deck's picture or recording loads from. Synchronous and
     * credential-free: the token in the path is what authorises it, and the
     * service answers only for files the shared document cites.
     */
    assetUrl?(token: string, assetId: string): string;
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
      body: {
        workspaceId: string;
        width?: number;
        height?: number;
        /** Defaults to an image. A font is `"font"` with its `font/*` type. */
        kind?: "image" | "font" | "audio" | "document";
        /**
         * Audio: what the browser decoded, used only when the service cannot
         * read the container itself, and 256 peaks for the timeline's waveform.
         */
        durationMs?: number;
        waveformPeaks?: number[];
        /** Overrides the file's own type, which a browser often leaves empty for fonts. */
        contentType?: string;
      },
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

  /**
   * Translation and narration (integration plan 01 §3.7, §3.8). Optional, so a
   * surface without these services says so rather than failing a call.
   */
  readonly languages?: {
    status(options?: RequestOptions): Promise<LanguagesStatus>;
    translate(presentationId: string, locale: string, body: TranslateRequest, options?: RequestOptions): Promise<TranslateResult>;
    quoteTranslation(presentationId: string, locale: string, body: Omit<TranslateRequest, "quote_token">, options?: RequestOptions): Promise<PaidServiceQuote>;
    voices(locale: string, options?: RequestOptions): Promise<Voice[]>;
    synthesize(presentationId: string, body: SynthesizeRequest, options?: RequestOptions): Promise<SynthesizeResult>;
    quoteSpeech(presentationId: string, body: Omit<SynthesizeRequest, "quote_token">, options?: RequestOptions): Promise<PaidServiceQuote>;
  };

}

/** A document the caller already holds, for surfaces that render without reading. */
export interface LoadedDocument {
  document: PresentationDocument;
  versionId: string;
}
