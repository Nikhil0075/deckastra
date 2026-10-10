import type {
  AssistantRun, AssistantCapabilities, AssistantEvent, AssistantAsset, DesignCheckResult,
  TransitionRequest,
  TransitionResult,
  AccountContext,
  CreditBalance,
  ComposedDeckResult,
  AccountCapabilities,
  AccountDeletion,
  DeckImport,
  AccountProject,
  AppliedChange,
  CreatePresentationRequest,
  CreatePresentationResult,
  CreateShareRequest,
  DocumentHead,
  DocumentRead,
  MovePresentationResult,
  DeletePresentationResult,
  RestorePresentationResult,
  DuplicatePresentationResult,
  ExportJob,
  ExportRequest,
  DeckComposeRequest,
  TemplatePreviewRequest,
  TemplatePreviewResult,
  DeckFromTemplateRequest,
  HealthReport,
  MotionCapabilities,
  MotionRequest,
  MotionResult,
  MotionStyleRequest,
  MotionStyleResult,
  PendingProposal,
  ProposalDetail,
  PresentationSummary,
  PresetCatalog,
  InsertPatternRequest,
  InsertPatternResult,
  PreviewRequest,
  PreviewResult,
  MotionPreviewRequest,
  MotionPreviewResult,
  RequestOptions,
  ImportedTheme,
  SaveThemeRequest,
  SavedTheme,
  Session,
  Share,
  SharedDocument,
  SlideSources,
  ThemeList,
  ThemeProposal,
  TransactionRequest,
  TransactionResult,
  VersionSummary,
  RestoreVersionResult,
  WorkspaceClient,
  UploadedAsset,
  LanguagesStatus,
  PaidServiceQuote,
  SynthesizeResult,
  TranslateResult,
  Voice,
} from "@deckastra/workspace-contracts";
import { DECK_IMPORT_MAX_BYTES } from "@deckastra/workspace-contracts";

import { WorkspaceRequestError, messageFromDetail } from "./errors";
import { browserSessionStore, type SessionStore } from "./session-store";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BootstrapContext {
  baseUrl: string;
  fetch: FetchLike;
  signal?: AbortSignal;
  /**
   * The service refused the session it was given. A sign-in whose tokens expire
   * (an hour, for Identity Platform) must fetch a fresh one rather than hand the
   * cached one back.
   */
  refresh?: boolean;
}

export interface HttpClientOptions {
  /** Origin of the authority. No trailing slash; one is stripped if present. */
  baseUrl: string;
  /**
   * Which surface authored a patch, recorded on every transaction.
   *
   * Not defaulted. Provenance that names the wrong client is worse than none, and
   * a default is how the desktop shell ends up calling itself "web-editor".
   */
  clientId: string;
  sessionStore?: SessionStore;
  /**
   * How a session is obtained when nothing is cached.
   *
   * The default asks `/v1/dev/session`, which is Phase 2's development sign-in and
   * is disabled in production. A real sign-in and the desktop's launch-secret
   * session both replace this and nothing else.
   */
  bootstrapSession?: (context: BootstrapContext) => Promise<Session>;
  fetch?: FetchLike;
}

/**
 * The workspace authority over HTTP.
 *
 * Every request in the product goes through `send` below, which is the whole
 * reason this exists: the base URL, the bearer header and the shape of a refusal
 * were previously decided in ten files, and the tenth would have been the one that
 * forgot. Behaviour is deliberately unchanged from those copies — the same error
 * unwrapping, the same `keepalive` rule, the same no-store read for a version.
 */
export function createHttpClient(options: HttpClientOptions): WorkspaceClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const store = options.sessionStore ?? browserSessionStore();
  const bootstrap = options.bootstrapSession ?? devSessionBootstrap;

  let inflight: Promise<Session> | undefined;
  // Template previews this client has already been answered, by template, theme
  // and slides, with the ETag that lets the service say "unchanged" (unit 2).
  const previews = new Map<string, { etag: string; result: TemplatePreviewResult }>();

  async function ensureSession(request?: RequestOptions, refresh = false): Promise<Session> {
    const cached = store.read();
    if (cached && !refresh) return cached;

    // One request even if several components ask at once, so a fresh load does
    // not create three users.
    //
    // And no one caller's signal goes into it. The bootstrap is shared, so a
    // signal passed in belonged to whichever component asked first, and that
    // component unmounting (React's development double mount does it on every
    // load) aborted the session for everyone waiting on it: the deck list read
    // "signal is aborted without reason" on a fresh load (2026-10-05). Each
    // caller stops waiting on its own abort; the request runs on for the rest.
    const shared = (inflight ??= bootstrap({ baseUrl, fetch: doFetch, ...(refresh ? { refresh: true } : {}) })
      .then((session) => {
        store.write(session);
        return session;
      })
      .finally(() => {
        inflight = undefined;
      }));

    const signal = request?.signal;
    if (!signal) return shared;
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return new Promise<Session>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  interface SendInit extends RequestOptions {
    method?: string;
    body?: unknown;
    /** A file sent as the request body itself, not as JSON. */
    raw?: Blob;
    auth?: boolean;
    cache?: RequestCache;
    /** Message when the server gives no usable `detail`. */
    fallback?: string;
    /** Extra request headers. Only a cache validator uses this today. */
    headers?: Record<string, string>;
    /** Hand a 304 back rather than treating it as a failure. */
    acceptNotModified?: boolean;
  }

  async function send(path: string, init: SendInit = {}, retried = false): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.raw !== undefined) headers["Content-Type"] = init.raw.type || "application/octet-stream";
    if (init.auth !== false) {
      // Read the cached session synchronously rather than awaiting it.
      //
      // An `await` here — even on an already-resolved value — defers the fetch by
      // a microtask, and the one caller that cannot afford that is the autosave
      // drain on `beforeunload`: the request has to be issued in the same task as
      // the event handler for `keepalive` to carry it past the teardown. A save
      // that is one microtask late is a save the user loses.
      const cached = store.read();
      headers.Authorization = `Bearer ${(cached ?? (await ensureSession(init))).token}`;
    }

    const request: RequestInit = {
      method: init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST"),
      headers,
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    if (init.raw !== undefined) request.body = init.raw;
    if (init.signal) request.signal = init.signal;
    if (init.fresh) request.cache = "no-store";
    else if (init.cache) request.cache = init.cache;
    if (init.keepalive) request.keepalive = true;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, request);
    } catch (error) {
      // An abort is the caller's own doing and every caller that can abort checks
      // for it by name. Rethrowing it as a request failure would turn "the user
      // navigated away" into "the export failed".
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new WorkspaceRequestError(
        0,
        undefined,
        error instanceof Error && error.message
          ? error.message
          : "Could not reach the workspace.",
      );
    }

    // A 401 on an authenticated request means the token was refused before
    // anything was done, so asking once more with a fresh one is safe even for a
    // write. Once: a second refusal is the answer (signed out, or deleted).
    if (response.status === 401 && init.auth !== false && !retried) {
      let renewed = false;
      try {
        await ensureSession(init, true);
        renewed = true;
      } catch {
        /* No fresh session to be had: report the original refusal. */
      }
      if (renewed) return send(path, init, true);
    }

    if (response.status === 304 && init.acceptNotModified) return response;

    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as { detail?: unknown });
      const detail = (body as { detail?: unknown }).detail;
      throw new WorkspaceRequestError(
        response.status,
        detail,
        messageFromDetail(detail, response.status, init.fallback),
      );
    }

    return response;
  }

  async function json<T>(path: string, init: SendInit = {}): Promise<T> {
    return (await send(path, init)).json() as Promise<T>;
  }

  /**
 * Where the API serves one stored object.
 *
 * Mirrors `object_storage.blob_url` on the Python side, which is a second
 * description of one path and therefore something that can drift. It is small
 * and it is covered by a test that drives the real route, which is the same
 * bargain the two patch appliers make.
 */
function blobPath(storageKey: string): string {
  // A template's bundled picture (UI audit unit 7b): served from the build, not
  // a workspace, and only ever seen by a template preview. Twin of the same
  // branch in Python's `object_storage.blob_url`.
  if (storageKey.startsWith("preset-media/")) return `/v1/presets/media/${encodeURIComponent(storageKey.slice("preset-media/".length))}`;
  // Segment by segment, keeping the separators. The route is `{key:path}` and a
  // storage key is `workspaces/<id>/assets/<id>` — `encodeURIComponent` on the
  // whole thing turns every slash into `%2F`, which is a different URL from the
  // one Python's `quote(key)` builds (it leaves `/` alone by default). Written
  // the wrong way here first, which is exactly the drift this pair invites.
  return `/v1/workspace/assets/blob/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

const q = encodeURIComponent;
  const workspaceQuery = (workspaceId?: string): string =>
    workspaceId ? `?workspace_id=${q(workspaceId)}` : "";

  return {
    clientId: options.clientId,
    assistant: {
      capabilities: (o) => json<AssistantCapabilities>(`/v1/assistant/capabilities${o?.presentationId ? `?presentation_id=${q(o.presentationId)}${o.slideId ? `&slide_id=${q(o.slideId)}` : ""}${o.locale ? `&locale=${q(o.locale)}` : ""}` : ""}`, { ...o }),
      quoteImage: (presentationId, body, o) => json<PaidServiceQuote>("/v1/media/quotes/image", {
        ...o, body: { presentation_id: presentationId, ...body }, fallback: "The image price could not be checked.",
      }),
      start: (body, o) => json<AssistantRun>("/v1/assistant/runs", { ...o, body }),
      get: (id, o) => json<AssistantRun>(`/v1/assistant/runs/${q(id)}`, { ...o }),
      list: (id, o) => json<{ runs: AssistantRun[] }>(`/v1/assistant/runs?presentation_id=${q(id)}`, { ...o }),
      events: (id, after = 0, o) => json<{ events: AssistantEvent[] }>(`/v1/assistant/runs/${q(id)}/events?after=${after}`, { ...o }),
      cancel: (id, o) => json<AssistantRun>(`/v1/assistant/runs/${q(id)}/cancel`, { ...o, body: {} }),
      resume: (id, o) => json<AssistantRun>(`/v1/assistant/runs/${q(id)}/resume`, { ...o, body: {} }),
      designCheck: (id, slide, o) => json<DesignCheckResult>(`/v1/presentations/${q(id)}/design-check${slide ? `?slide_id=${q(slide)}` : ""}`, { ...o }),
      assetList: (request, o) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(request)) if (value !== undefined) params.set(key, String(value));
        return json<{ assets: AssistantAsset[]; next_cursor: string | null }>(`/v1/assets?${params}`, { ...o });
      },
      assetView: (id, max = 512, o, crop) => {
        const params = new URLSearchParams({ max_px: String(max) });
        if (crop) for (const [key, value] of Object.entries(crop)) params.set(key, String(value));
        return json(`/v1/assets/${q(id)}/view?${params}`, { ...o });
      },
      assetUpdate: (id, body, o) => json<AssistantAsset>(`/v1/assets/${q(id)}`, { ...o, method: "PATCH", body }),
      assetRevert: (id, change, o) => json<AssistantAsset>(`/v1/assets/${q(id)}/changes/${q(change)}/revert`, { ...o, body: {} }),
      assetDuplicates: (workspace, cursor, o) => {
        const params = new URLSearchParams();
        if (workspace) params.set("workspace_id", workspace);
        if (cursor) params.set("cursor", cursor);
        return json(`/v1/assets/duplicates?${params}`, { ...o });
      },
    },

    health: (request) => json<HealthReport>("/health", { auth: false, ...request }),

    session: {
      ensure: ensureSession,
      clear: () => store.clear(),
      account: (request) => json<AccountContext>("/v1/account", { ...request }),
      credits: (request) => json<CreditBalance>("/v1/account/credits", { ...request }),
      capabilities: (request) => json<AccountCapabilities>("/v1/account/capabilities", { ...request }),
      deleteAccount: (request) =>
        json<AccountDeletion>("/v1/account", {
          method: "DELETE",
          body: { confirm: "DELETE" },
          fallback: "Your account could not be deleted just now.",
          ...request,
        }),
      deletionStatus: (receipt, request) =>
        json<{ status: string }>(`/v1/account/deletions/${q(receipt)}`, { auth: false, fresh: true, ...request }),
      createWorkspace: (name, request) =>
        json<{ workspace_id: string; project_id: string }>("/v1/workspaces", {
          body: { name },
          ...request,
        }),
      createProject: (workspaceId, name, description, request) =>
        json<AccountProject>(`/v1/workspaces/${q(workspaceId)}/projects`, {
          body: { name, description: description || null },
          ...request,
        }),
      selectProject: (workspaceId, projectId) => {
        const current = store.read();
        if (current) store.write({ ...current, workspaceId, projectId });
      },
      readPreference: async (key, request) => (await json<{ value: unknown }>(`/v1/me/preferences/${q(key)}`, { ...request })).value,
      writePreference: async (key, value, request) => {
        await json<unknown>(`/v1/me/preferences/${q(key)}`, { method: "PUT", body: { value }, ...request });
      },
    },

    documents: {
      create: (body: CreatePresentationRequest, request) =>
        json<CreatePresentationResult>("/v1/presentations", { body, ...request }),
      read: (presentationId, request) =>
        json<DocumentRead>(`/v1/presentations/${q(presentationId)}`, { ...request }),
      list: (projectId, request) =>
        json<{ presentations: PresentationSummary[] }>(
          `/v1/projects/${q(projectId)}/presentations`,
          { ...request },
        ).then((body) => body.presentations),
      preview: (presentationId, body: PreviewRequest, request) =>
        json<PreviewResult>(`/v1/presentations/${q(presentationId)}/preview`, {
          body,
          ...request,
        }),
      motionPreview: (presentationId, body: MotionPreviewRequest, request) =>
        json<MotionPreviewResult>(`/v1/presentations/${q(presentationId)}/motion-preview`, {
          body,
          ...request,
        }),
      head: (presentationId, request) =>
        json<DocumentHead>(`/v1/presentations/${q(presentationId)}/head`, {
          // Polled; a cached answer is a change the editor never hears about.
          cache: "no-store",
          ...request,
        }),
      readAt: (presentationId, versionId, request) =>
        json<DocumentRead>(`/v1/presentations/${q(presentationId)}?at_version=${q(versionId)}`, {
          // A cached base silently turns a three-way merge into a two-way one.
          cache: "no-store",
          ...request,
        }),
      commit: (presentationId, body: TransactionRequest, request) =>
        json<TransactionResult>(`/v1/presentations/${q(presentationId)}/transactions`, {
          body,
          ...request,
        }),
      versions: (presentationId, request) =>
        // Fresh: the drawer is opened to see what just happened.
        json<VersionSummary[]>(`/v1/presentations/${q(presentationId)}/versions`, { fresh: true, ...request }),
      restoreVersion: (presentationId, versionId, expectedVersionId, request) =>
        json<RestoreVersionResult>(
          `/v1/presentations/${q(presentationId)}/versions/${q(versionId)}/restore`,
          { body: { expected_version_id: expectedVersionId }, ...request },
        ),
      move: (presentationId, projectId, request) =>
        json<MovePresentationResult>(`/v1/presentations/${q(presentationId)}/move`, {
          body: { project_id: projectId },
          ...request,
        }),
      delete: (presentationId, request) =>
        json<DeletePresentationResult>(`/v1/presentations/${q(presentationId)}`, {
          method: "DELETE",
          ...request,
        }),
      restore: (presentationId, request) =>
        json<RestorePresentationResult>(`/v1/presentations/${q(presentationId)}/restore`, {
          method: "POST",
          ...request,
        }),
      duplicate: (presentationId, request) =>
        json<DuplicatePresentationResult>(`/v1/presentations/${q(presentationId)}/duplicate`, {
          method: "POST",
          ...request,
        }),
      trash: (projectId, request) =>
        json<{ presentations: PresentationSummary[] }>(
          `/v1/projects/${q(projectId)}/presentations?deleted=true`,
          { fresh: true, ...request },
        ).then((body) => body.presentations),
      slideSources: (presentationId, slideId, request) =>
        json<SlideSources>(
          `/v1/presentations/${q(presentationId)}/slides/${q(slideId)}/sources`,
          { ...request },
        ),
    },

    motion: {
      capabilities: (request) => json<MotionCapabilities>("/v1/motion/capabilities", { ...request }),
      propose: (presentationId, body: MotionRequest, request) =>
        json<MotionResult>(`/v1/presentations/${q(presentationId)}/motion`, { body, ...request }),
      proposeTransition: (presentationId, body: TransitionRequest, request) =>
        json<TransitionResult>(`/v1/presentations/${q(presentationId)}/transition`, {
          body,
          ...request,
        }),
      proposeStyle: (presentationId, body: MotionStyleRequest, request) =>
        json<MotionStyleResult>(`/v1/presentations/${q(presentationId)}/motion-style`, {
          body,
          fallback: "That motion style could not be applied.",
          ...request,
        }),
    },


    presets: {
      list: (request) => json<PresetCatalog>("/v1/presets", { fresh: true, ...request }),
      create: (body: DeckFromTemplateRequest, request) =>
        json<ComposedDeckResult>("/v1/decks/from-template", { body, ...request }),
      compose: (body: DeckComposeRequest, request) =>
        json<ComposedDeckResult>("/v1/decks/compose", { body, ...request }),
      previewTemplate: async (templateId: string, body: TemplatePreviewRequest = {}, request) => {
        // A preview without the person's words is cached by the service with an
        // ETag; a POST is never cached by the browser, so the validator is kept
        // here and an unchanged preview comes back as a 304 with no body.
        const cacheable = !body.content || Object.keys(body.content).length === 0;
        const key = `${templateId}|${body.theme_key ?? ""}|${body.slides ?? "cover"}`;
        const known = cacheable ? previews.get(key) : undefined;
        const response = await send(`/v1/presets/${q(templateId)}/preview`, {
          body,
          fallback: "That template could not be previewed.",
          headers: known ? { "If-None-Match": known.etag } : undefined,
          acceptNotModified: Boolean(known),
          ...request,
        });
        if (response.status === 304 && known) return known.result;
        const result = (await response.json()) as TemplatePreviewResult;
        const etag = cacheable ? response.headers.get("etag") : null;
        if (etag) {
          previews.set(key, { etag, result });
          // Bounded: a gallery is a few dozen covers, and each is a document.
          if (previews.size > 120) previews.delete(previews.keys().next().value as string);
        }
        return result;
      },
      insertPattern: (presentationId, body: InsertPatternRequest, request) =>
        json<InsertPatternResult>(`/v1/presentations/${q(presentationId)}/patterns/insert`, {
          body,
          fallback: "That slide pattern could not be inserted.",
          ...request,
        }),
    },

    agent: {
      proposals: (presentationId, request) =>
        json<PendingProposal[]>(`/v1/presentations/${q(presentationId)}/proposals`, { ...request }),
      proposal: (presentationId, proposalId, request) =>
        json<ProposalDetail>(`/v1/presentations/${q(presentationId)}/proposals/${q(proposalId)}`, {
          fresh: true,
          ...request,
        }),
      approve: (presentationId, proposalId, expectedVersionId, request) =>
        json<AppliedChange>(
          `/v1/presentations/${q(presentationId)}/proposals/${q(proposalId)}/approve`,
          {
            method: "POST",
            body: { expected_version_id: expectedVersionId ?? null },
            ...request,
          },
        ),
      reject: (presentationId, proposalId, reason, request) =>
        json<unknown>(
          `/v1/presentations/${q(presentationId)}/proposals/${q(proposalId)}/reject`,
          { body: { reason: reason ?? null }, ...request },
        ),
      revert: (presentationId, transactionId, request) =>
        json<AppliedChange>(
          `/v1/presentations/${q(presentationId)}/transactions/${q(transactionId)}/revert`,
          { method: "POST", ...request },
        ),
    },

    imports: {
      upload: async (projectId, file, request) => {
        // The service checks the size too; refusing here saves sending 200MB
        // to be told so.
        if (file.size > DECK_IMPORT_MAX_BYTES) {
          throw new WorkspaceRequestError(413, undefined, "Deckastra files up to 128 MB can be opened here.");
        }
        const begin = await json<{ id: string; upload_url: string; method: string; headers: Record<string, string> }>(
          `/v1/projects/${q(projectId)}/imports`,
          { body: { size_bytes: file.size, copy: true }, fallback: "That file could not be opened.", ...request },
        );
        // As for assets: an absolute URL is a signed storage URL whose signature
        // is the credential, and it must be sent exactly the headers it was
        // signed with. A relative one is this service's own route.
        const absolute = /^https?:\/\//i.test(begin.upload_url);
        const headers: Record<string, string> = { ...begin.headers };
        if (!absolute) {
          const cached = store.read();
          headers.Authorization = `Bearer ${(cached ?? (await ensureSession(request ?? {}))).token}`;
        }
        const put: RequestInit = { method: begin.method || "PUT", headers, body: file };
        if (request?.signal) put.signal = request.signal;
        const stored = await doFetch(absolute ? begin.upload_url : `${baseUrl}${begin.upload_url}`, put);
        if (!stored.ok) throw new WorkspaceRequestError(stored.status, undefined, "The file could not be uploaded.");
        return json<DeckImport>(`/v1/imports/${q(begin.id)}/complete`, {
          method: "POST",
          fallback: "That file could not be opened.",
          ...request,
        });
      },
      status: (importId, request) => json<DeckImport>(`/v1/imports/${q(importId)}`, { fresh: true, ...request }),
    },

    exports: {
      start: (presentationId, body: ExportRequest, request) =>
        json<ExportJob>(`/v1/presentations/${q(presentationId)}/exports`, {
          body,
          fallback: "The export failed.",
          ...request,
        }),
      status: (exportId, request) =>
        json<ExportJob>(`/v1/exports/${q(exportId)}`, {
          fallback: "Could not refresh export progress.",
          ...request,
        }),
      cancel: (exportId, request) =>
        json<ExportJob>(`/v1/exports/${q(exportId)}/cancel`, { method: "POST", ...request }),
      retry: (exportId, request) =>
        json<ExportJob>(`/v1/exports/${q(exportId)}/retry`, {
          method: "POST",
          fallback: "This export could not be retried.",
          ...request,
        }),
      download: async (exportId, request) =>
        (
          await send(`/v1/exports/${q(exportId)}/download`, {
            fallback: "The file is no longer available. Export it again.",
            ...request,
          })
        ).blob(),
    },

    languages: {
      status: (request) => json<LanguagesStatus>("/v1/languages/status", { cache: "no-store", ...request }),
      translate: (presentationId, locale, body, request) =>
        json<TranslateResult>(`/v1/presentations/${q(presentationId)}/locales/${q(locale)}/translate`, {
          body,
          fallback: "The translation could not be made.",
          ...request,
        }),
      quoteTranslation: (presentationId, locale, body, request) =>
        json<PaidServiceQuote>("/v1/media/quotes/translation", {
          body: { presentation_id: presentationId, locale, ...body },
          fallback: "The translation price could not be checked.",
          ...request,
        }),
      voices: (locale, request) =>
        json<{ voices: Voice[] }>(`/v1/speech/voices?locale=${q(locale)}`, { ...request }).then((answer) => answer.voices),
      synthesize: (presentationId, body, request) =>
        json<SynthesizeResult>(`/v1/presentations/${q(presentationId)}/narration/synthesize`, {
          body,
          fallback: "The narration could not be voiced.",
          ...request,
        }),
      quoteSpeech: (presentationId, body, request) =>
        json<PaidServiceQuote>("/v1/media/quotes/speech", {
          body: { presentation_id: presentationId, ...body },
          fallback: "The narration price could not be checked.",
          ...request,
        }),
    },

    assets: {
      directUrl: (storageKey) => {
        // Only where the browser can authenticate the request by itself, which
        // means same-origin: the desktop's base URL is a path on the renderer's
        // own origin and the main process injects the bearer as the request goes
        // through. A cross-origin base — the web app's — carries its credential
        // in a header, and an `<img>` sends none, so answering with a URL there
        // would produce a broken image rather than a picture.
        //
        // A relative base is same-origin by definition; an absolute one is only
        // same-origin if it matches where the page is running, which is worth
        // allowing because a deployment can serve both from one host.
        if (!baseUrl || baseUrl.startsWith("/")) {
          return `${baseUrl}${blobPath(storageKey)}`;
        }
        if (typeof window !== "undefined" && baseUrl.startsWith(window.location.origin)) {
          return `${baseUrl}${blobPath(storageKey)}`;
        }
        return undefined;
      },
      upload: async (file, body, request) => {
        const begin = await json<{
          method: string;
          upload_url: string;
          headers: Record<string, string>;
          upload_token: string;
        }>("/v1/workspace/assets/uploads", {
          body: {
            workspace_id: body.workspaceId,
            filename: file.name,
            content_type: body.contentType || file.type || "application/octet-stream",
            size_bytes: file.size,
            kind: body.kind ?? "image",
            ...(body.width ? { width: body.width } : {}),
            ...(body.height ? { height: body.height } : {}),
            ...(body.durationMs ? { duration_ms: Math.round(body.durationMs) } : {}),
            ...(body.waveformPeaks?.length === 256 ? { waveform_peaks: body.waveformPeaks } : {}),
          },
          fallback: "That file could not be uploaded.",
          ...request,
        });

        // The subtlety worth stating: a **relative** URL is this API's own blob
        // route and needs our bearer; an **absolute** one is a presigned
        // object-store URL whose signature *is* the credential, and attaching a
        // second one is how a presigned PUT gets rejected.
        const absolute = /^https?:\/\//i.test(begin.upload_url);
        const headers: Record<string, string> = { ...begin.headers };
        if (!absolute) {
          const cached = store.read();
          headers.Authorization = `Bearer ${(cached ?? (await ensureSession(request ?? {}))).token}`;
        }

        const put: RequestInit = { method: begin.method || "PUT", headers, body: file };
        if (request?.signal) put.signal = request.signal;

        const stored = await doFetch(
          absolute ? begin.upload_url : `${baseUrl}${begin.upload_url}`,
          put,
        );
        if (!stored.ok) {
          throw new WorkspaceRequestError(
            stored.status,
            undefined,
            "The file could not be stored.",
          );
        }

        // Registering is what charges the quota, so a workspace at its limit is
        // refused here — after the bytes are written and before anything cites
        // them, which is why the route deletes the object on that refusal.
        return json<UploadedAsset>("/v1/workspace/assets/uploads/complete", {
          body: { upload_token: begin.upload_token },
          fallback: "That upload could not be completed.",
          ...request,
        });
      },
      fetchBlob: async (storageKey, request) => {
        // Deliberately not through `json()`: these are bytes, and a few megabytes
        // of PNG put through a JSON parser is a wasted copy and a thrown error.
        const headers: Record<string, string> = {};
        const cached = store.read();
        headers.Authorization = `Bearer ${(cached ?? (await ensureSession(request ?? {}))).token}`;

        const init: RequestInit = { method: "GET", headers };
        if (request?.signal) init.signal = request.signal;

        const response = await doFetch(`${baseUrl}${blobPath(storageKey)}`, init);
        if (!response.ok) {
          throw new WorkspaceRequestError(
            response.status,
            undefined,
            "That image could not be loaded.",
          );
        }
        return response.blob();
      },
    },

    shares: {
      list: async (presentationId, request) =>
        (
          await json<{ shares: Share[] }>(`/v1/presentations/${q(presentationId)}/shares`, {
            fallback: "Could not load the links for this deck.",
            ...request,
          })
        ).shares,
      create: (presentationId, body: CreateShareRequest, request) =>
        json<Share>(`/v1/presentations/${q(presentationId)}/shares`, {
          body,
          fallback: "Could not create a link.",
          ...request,
        }),
      revoke: async (shareId, request) => {
        await send(`/v1/shares/${q(shareId)}`, {
          method: "DELETE",
          fallback: "Could not revoke that link.",
          ...request,
        });
      },
      // An <img> or <audio> can load this cross-origin with no header, which is
      // why the shared route takes no session: the token in the path is it.
      assetUrl: (token, assetId) => `${baseUrl}/v1/shared/${q(token)}/assets/${q(assetId)}`,
      redeem: (token, request) =>
        json<SharedDocument>(`/v1/shared/${q(token)}`, {
          // Expired, revoked and never-existed answer alike on purpose; the client
          // must not invent a distinction the server refused to make.
          auth: false,
          fallback: "This link is no longer available.",
          ...request,
        }),
    },

    themes: {
      list: (presentationId, request) =>
        json<ThemeList>(`/v1/presentations/${q(presentationId)}/themes`, { ...request }),
      proposal: (presentationId, themeId, request) =>
        json<ThemeProposal>(`/v1/presentations/${q(presentationId)}/themes/${q(themeId)}`, {
          ...request,
        }),
      save: (presentationId, body: SaveThemeRequest, request) =>
        json<SavedTheme>(`/v1/presentations/${q(presentationId)}/themes`, { body, ...request }),
      importOffice: (presentationId, file, request) =>
        json<ImportedTheme>(`/v1/presentations/${q(presentationId)}/themes/import`, { raw: file, ...request }),
    },

  };
}

/**
 * Phase 2's development sign-in.
 *
 * Kept as the default because it is what the web app does today, and kept
 * replaceable because it is the one thing a real sign-in and the desktop's
 * launch-secret session both need to change.
 */
async function devSessionBootstrap(context: BootstrapContext): Promise<Session> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "dev@localhost" }),
  };
  if (context.signal) init.signal = context.signal;

  const response = await context.fetch(`${context.baseUrl}/v1/dev/session`, init);

  if (!response.ok) {
    throw new WorkspaceRequestError(
      response.status,
      undefined,
      response.status === 404
        ? "Development sign-in is disabled on this server."
        : `Could not start a session (${response.status}).`,
    );
  }

  const body = (await response.json()) as {
    token: string;
    user_id: string;
    workspace_id: string;
    project_id?: string | null;
  };

  return {
    token: body.token,
    userId: body.user_id,
    workspaceId: body.workspace_id,
    projectId: body.project_id ?? null,
  };
}
