"use client";

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  isSignInWithEmailLink,
  onIdTokenChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";
import { WorkspaceRequestError, type BootstrapContext, type SessionStore } from "@deckastra/workspace-client";
import type { AccountContext, Session } from "@deckastra/workspace-contracts";

import type { CloudConfig } from "./cloud";

/**
 * Signing in to hosted Deckastra from the browser (FRONTEND_BACKEND_HANDOFF.md,
 * "Web and account state"): Identity Platform through the Firebase SDK, with
 * Google and an email link, and its ID token on every API request.
 *
 * Three rules shape it:
 *
 * - **The token is read, never kept.** Identity Platform's ID tokens last an
 *   hour and the SDK renews them; the session store answers with whatever
 *   token the SDK last handed over, so a request never carries one the SDK has
 *   already replaced. A refused token makes the client ask again with
 *   `refresh`, which forces a renewal (once).
 * - **Nothing is persisted here.** The SDK keeps its own sign-in; this module
 *   keeps only the workspace ids read from `/v1/account`, in memory, so a
 *   different person signing in on the same browser can never inherit them.
 * - **A signed-out request is refused locally**, as a 401, before anything is
 *   sent: there is nothing to send it with.
 */

const EMAIL_KEY = "deckastra.email-for-sign-in";

export interface SignedInUser {
  email: string | null;
  name: string | null;
  verified: boolean;
}

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: SignedInUser };

export interface CloudAuth {
  readonly sessionStore: SessionStore;
  bootstrap(context: BootstrapContext): Promise<Session>;
  state(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  signInWithGoogle(): Promise<void>;
  sendEmailLink(email: string): Promise<void>;
  /** Whether this page was opened from a sign-in email. */
  isEmailLink(href: string): boolean;
  /** The address the link was sent to, when this browser sent it. */
  rememberedEmail(): string | null;
  completeEmailLink(email: string, href: string): Promise<void>;
  signOut(): Promise<void>;
}

export function createCloudAuth(config: CloudConfig, options: { app?: FirebaseApp } = {}): CloudAuth {
  const app = options.app ?? initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId }, config.name);
  const auth: Auth = getAuth(app);

  let state: AuthState = { status: "loading" };
  let token: string | null = null;
  let held: Session | undefined;
  let uid: string | null = null;
  const listeners = new Set<(state: AuthState) => void>();

  const describe = (user: User): SignedInUser => ({
    email: user.email,
    name: user.displayName,
    verified: user.emailVerified,
  });

  const set = (next: AuthState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  onIdTokenChanged(auth, async (user) => {
    if (!user) {
      token = null;
      held = undefined;
      uid = null;
      set({ status: "signed-out" });
      return;
    }
    // A different person on this browser starts from no workspace at all.
    if (uid !== user.uid) held = undefined;
    uid = user.uid;
    try {
      token = await user.getIdToken();
    } catch {
      token = null;
    }
    set({ status: "signed-in", user: describe(user) });
  });

  const sessionStore: SessionStore = {
    read: () => (held && token ? { ...held, token } : undefined),
    write: (session) => {
      held = session;
      token = session.token;
      // Whose it is, so the SDK's first token callback (which may arrive after
      // this) does not mistake it for another person's and discard it.
      uid = auth.currentUser?.uid ?? uid;
    },
    clear: () => {
      held = undefined;
    },
  };

  async function bootstrap(context: BootstrapContext): Promise<Session> {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) throw new WorkspaceRequestError(401, undefined, "Sign in to continue.");
    const fresh = await user.getIdToken(context.refresh === true);
    const init: RequestInit = { headers: { Authorization: `Bearer ${fresh}`, accept: "application/json" } };
    if (context.signal) init.signal = context.signal;
    const response = await context.fetch(`${context.baseUrl}/v1/account`, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
      throw new WorkspaceRequestError(
        response.status,
        body.detail,
        response.status === 401 || response.status === 403
          ? "Deckastra could not confirm your sign-in. Sign out and sign in again."
          : `Your account could not be read (${response.status}).`,
      );
    }
    const account = (await response.json()) as AccountContext;
    // The first workspace the person owns or edits, as the desktop picks it.
    const workspace = account.workspaces.find((candidate) => candidate.projects.length > 0) ?? account.workspaces[0];
    if (!workspace) throw new WorkspaceRequestError(500, undefined, "Your account has no workspace yet.");
    return {
      token: fresh,
      userId: account.user.id,
      workspaceId: workspace.id,
      projectId: workspace.projects[0]?.id ?? null,
    };
  }

  return {
    sessionStore,
    bootstrap,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    async signInWithGoogle() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        await signInWithPopup(auth, provider);
      } catch (error) {
        // A blocked pop-up is something the browser did, not a failure: go
        // there instead and come back signed in.
        if (authCode(error) === "auth/popup-blocked") {
          await signInWithRedirect(auth, provider);
          return;
        }
        throw error;
      }
    },
    async sendEmailLink(email) {
      await sendSignInLinkToEmail(auth, email, { url: `${window.location.origin}/`, handleCodeInApp: true });
      try {
        window.localStorage.setItem(EMAIL_KEY, email);
      } catch {
        /* Without it the person is asked for their address again; nothing worse. */
      }
    },
    isEmailLink: (href) => isSignInWithEmailLink(auth, href),
    rememberedEmail() {
      try {
        return window.localStorage.getItem(EMAIL_KEY);
      } catch {
        return null;
      }
    },
    async completeEmailLink(email, href) {
      await signInWithEmailLink(auth, email, href);
      try {
        window.localStorage.removeItem(EMAIL_KEY);
      } catch {
        /* ignore */
      }
    },
    async signOut() {
      held = undefined;
      token = null;
      await firebaseSignOut(auth);
    },
  };
}

export function authCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

/**
 * A sign-in failure in words a person can act on. Firebase's own messages name
 * its error codes ("Firebase: Error (auth/invalid-action-code)").
 */
export function signInProblem(error: unknown): string | null {
  switch (authCode(error)) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return null;
    case "auth/invalid-email":
    case "auth/missing-email":
      return "That email address does not look right.";
    case "auth/invalid-action-code":
    case "auth/expired-action-code":
      return "That sign-in link has expired or was already used. Ask for a new one.";
    case "auth/unauthorized-domain":
    case "auth/operation-not-allowed":
      return "Signing in is not set up for this address yet.";
    case "auth/network-request-failed":
      return "Could not reach the sign-in service. Check your connection and try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes, then try again.";
    default:
      return "Signing in did not work. Try again.";
  }
}
