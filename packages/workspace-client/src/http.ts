import type {
  TransitionRequest,
  TransitionResult,
  AccountContext,
  AccountProject,
  AgentEditResult,
  AppliedChange,
  CreatePresentationRequest,
  CreatePresentationResult,
  CreateShareRequest,
  DocumentHead,
  DocumentRead,
  MovePresentationResult,
  EditScopePayload,
  ExportJob,
  ExportRequest,
  GenerateRequest,
  GenerateResult,
  HealthReport,
  MotionCapabilities,
  MotionRequest,
  MotionResult,
  PendingProposal,
  PresentationSummary,
  PreviewRequest,
  PreviewResult,
  Repository,
  RepositoryList,
  RequestOptions,
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
  WorkspaceClient,
  UploadedAsset,
} from "@deckastra/workspace-contracts";

import { WorkspaceRequestError, messageFromDetail } from "./errors";
import { browserSessionStore, type SessionStore } from "./session-store";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
  bootstrapSession?: (context: { baseUrl: string; fetch: FetchLike; signal?: AbortSignal }) => Promise<Session>;
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

  async function ensureSession(request?: RequestOptions): Promise<Session> {
    const cached = store.read();
    if (cached) return cached;

    // One request even if several components ask at once, so a fresh load does
    // not create three users.
    inflight ??= bootstrap({ baseUrl, fetch: doFetch, ...(request?.signal ? { signal: request.signal } : {}) })
      .then((session) => {
        store.write(session);
        return session;
      })
      .finally(() => {
        inflight = undefined;
      });

    return inflight;
  }

  interface SendInit extends RequestOptions {
    method?: string;
    body?: unknown;
    auth?: boolean;
    cache?: RequestCache;
    /** Message when the server gives no usable `detail`. */
    fallback?: string;
  }

  async function send(path: string, init: SendInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
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
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
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

    health: (request) => json<HealthReport>("/health", { auth: false, ...request }),

    session: {
      ensure: ensureSession,
      clear: () => store.clear(),
      account: (request) => json<AccountContext>("/v1/account", { ...request }),
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
        json<VersionSummary[]>(`/v1/presentations/${q(presentationId)}/versions`, { ...request }),
      move: (presentationId, projectId, request) =>
        json<MovePresentationResult>(`/v1/presentations/${q(presentationId)}/move`, {
          body: { project_id: projectId },
          ...request,
        }),
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
    },

    generation: {
      run: (body: GenerateRequest, request) => json<GenerateResult>("/v1/generate", { body, ...request }),
    },

    agent: {
      edit: (presentationId, body: { instruction: string; scope: EditScopePayload }, request) =>
        json<AgentEditResult>(`/v1/presentations/${q(presentationId)}/agent/edit`, {
          body,
          ...request,
        }),
      proposals: (presentationId, request) =>
        json<PendingProposal[]>(`/v1/presentations/${q(presentationId)}/proposals`, { ...request }),
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
            content_type: file.type || "application/octet-stream",
            size_bytes: file.size,
            kind: "image",
            ...(body.width ? { width: body.width } : {}),
            ...(body.height ? { height: body.height } : {}),
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
    },

    repositories: {
      list: (workspaceId, request) =>
        json<RepositoryList>(`/v1/repositories${workspaceQuery(workspaceId)}`, { ...request }),
      connectLocal: (path, label, workspaceId, request) =>
        json<Repository>(`/v1/repositories/local${workspaceQuery(workspaceId)}`, {
          body: { path, label: label || null },
          ...request,
        }),
      index: (id, workspaceId, request) =>
        json<Repository & { index: unknown }>(
          `/v1/repositories/${q(id)}/index${workspaceQuery(workspaceId)}`,
          { method: "POST", ...request },
        ),
      disconnect: (id, workspaceId, request) =>
        json<{ status: string }>(`/v1/repositories/${q(id)}${workspaceQuery(workspaceId)}`, {
          method: "DELETE",
          ...request,
        }),
      slideSources: (presentationId, slideId, request) =>
        json<SlideSources>(
          `/v1/presentations/${q(presentationId)}/slides/${q(slideId)}/sources`,
          { ...request },
        ),
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
async function devSessionBootstrap(context: {
  baseUrl: string;
  fetch: FetchLike;
  signal?: AbortSignal;
}): Promise<Session> {
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
