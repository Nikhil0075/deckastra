import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hosted sign-in's half of the session: the token the client sends is the
 * one the SDK last handed over, a refused token is renewed by force, and a
 * signed-out request is refused before anything is sent.
 */

const sdk = vi.hoisted(() => ({
  user: null as null | { uid: string; email: string; displayName: string | null; emailVerified: boolean; getIdToken: (force?: boolean) => Promise<string> },
  listener: null as null | ((user: unknown) => void | Promise<void>),
}));

vi.mock("firebase/app", () => ({ initializeApp: () => ({}) }));
vi.mock("firebase/auth", () => ({
  getAuth: () => ({
    authStateReady: async () => {},
    get currentUser() {
      return sdk.user;
    },
  }),
  onIdTokenChanged: (_auth: unknown, listener: (user: unknown) => void) => {
    sdk.listener = listener;
  },
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  sendSignInLinkToEmail: vi.fn(),
  signInWithEmailLink: vi.fn(),
  isSignInWithEmailLink: () => false,
  signOut: vi.fn(),
}));

import { createCloudAuth, signInProblem } from "../lib/auth";

const config = { name: "deckastra", projectId: "deckastra", authDomain: "deckastra.firebaseapp.com", apiKey: "public", apiUrl: "https://api.test" };
const account = {
  user: { id: "usr_1", email: "a@example.com", name: null },
  workspaces: [{ id: "wsp_1", name: "Yours", role: "owner", origin: "local", projects: [{ id: "prj_1", name: "P", description: null }] }],
};

beforeEach(() => {
  sdk.user = null;
  sdk.listener = null;
});

describe("the hosted session", () => {
  it("refuses a signed-out request as a 401 without sending it", async () => {
    const auth = createCloudAuth(config);
    const fetch = vi.fn();
    await expect(auth.bootstrap({ baseUrl: "https://api.test", fetch })).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the account with the token, and forces a renewal when asked to refresh", async () => {
    const getIdToken = vi.fn(async (force?: boolean) => (force ? "renewed" : "first"));
    sdk.user = { uid: "u1", email: "a@example.com", displayName: null, emailVerified: true, getIdToken };
    const auth = createCloudAuth(config);
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => account }) as Response);
    await expect(auth.bootstrap({ baseUrl: "https://api.test", fetch })).resolves.toEqual({
      token: "first",
      userId: "usr_1",
      workspaceId: "wsp_1",
      projectId: "prj_1",
    });
    expect(fetch).toHaveBeenCalledWith("https://api.test/v1/account", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer first" }) }));
    await auth.bootstrap({ baseUrl: "https://api.test", fetch, refresh: true });
    expect(getIdToken).toHaveBeenLastCalledWith(true);
  });

  it("answers with the token the SDK last handed over, and forgets everything on sign-out", async () => {
    let current = "t1";
    sdk.user = { uid: "u1", email: "a@example.com", displayName: null, emailVerified: true, getIdToken: async () => current };
    const auth = createCloudAuth(config);
    auth.sessionStore.write({ token: "t1", userId: "usr_1", workspaceId: "wsp_1", projectId: "prj_1" });
    current = "t2";
    await sdk.listener!(sdk.user);
    expect(auth.sessionStore.read()?.token).toBe("t2");
    expect(auth.state()).toMatchObject({ status: "signed-in", user: { email: "a@example.com" } });

    await sdk.listener!(null);
    expect(auth.sessionStore.read()).toBeUndefined();
    expect(auth.state()).toEqual({ status: "signed-out" });
  });

  it("never carries one person's workspace over to another", async () => {
    sdk.user = { uid: "u1", email: "a@example.com", displayName: null, emailVerified: true, getIdToken: async () => "t" };
    const auth = createCloudAuth(config);
    await sdk.listener!(sdk.user);
    auth.sessionStore.write({ token: "t", userId: "usr_1", workspaceId: "wsp_1", projectId: "prj_1" });
    await sdk.listener!({ ...sdk.user, uid: "u2", email: "b@example.com" });
    expect(auth.sessionStore.read()).toBeUndefined();
  });
});

describe("sign-in failures, in words", () => {
  it("names nothing from the SDK", () => {
    expect(signInProblem({ code: "auth/expired-action-code" })).toMatch(/expired or was already used/);
    expect(signInProblem({ code: "auth/popup-closed-by-user" })).toBeNull();
    expect(signInProblem(new Error("Firebase: Error (auth/internal-error)."))).toBe("Signing in did not work. Try again.");
  });
});
