import type { PresentationDocument } from "@deckastra/presentation-schema";

import type { AgentEditResult, AppliedChange, EditScopePayload, PendingProposal } from "./agent";
import type {
  CreatePresentationRequest,
  CreatePresentationResult,
  DocumentHead,
  DocumentRead,
  PresentationSummary,
  TransactionRequest,
  TransactionResult,
  VersionSummary,
} from "./documents";
import type { ExportJob, ExportRequest } from "./exports";
import type { GenerateRequest, GenerateResult } from "./generation";
import type { Repository, RepositoryList, SlideSources } from "./repositories";
import type { AccountContext, AccountProject, HealthReport, Session } from "./session";
import type { CreateShareRequest, Share, SharedDocument } from "./shares";
import type { SaveThemeRequest, SavedTheme, ThemeList, ThemeProposal } from "./themes";

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
  };

  readonly generation: {
    run(body: GenerateRequest, options?: RequestOptions): Promise<GenerateResult>;
  };

  readonly agent: {
    edit(
      presentationId: string,
      body: { instruction: string; scope: EditScopePayload },
      options?: RequestOptions,
    ): Promise<AgentEditResult>;
    proposals(presentationId: string, options?: RequestOptions): Promise<PendingProposal[]>;
    approve(
      presentationId: string,
      proposalId: string,
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
