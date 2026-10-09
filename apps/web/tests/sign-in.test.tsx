import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testWorkspaceClient, withWorkspaceClient } from "@deckastra/workspace-client/testing";

import type { AuthState, CloudAuth } from "../lib/auth";
import { rememberDeletion } from "../lib/deletion";
import { SignInGate } from "../app/SignIn";

/**
 * The hosted web app's front door. The SDK is stood in for: what this checks
 * is what the page does with each answer it gets, not Firebase.
 */

function fakeAuth(overrides: Partial<CloudAuth> = {}) {
  let listener: (state: AuthState) => void = () => {};
  let state: AuthState = { status: "loading" };
  const auth: CloudAuth = {
    sessionStore: { read: () => undefined, write: () => {}, clear: () => {} },
    bootstrap: vi.fn(),
    state: () => state,
    subscribe: (next) => {
      listener = next;
      next(state);
      return () => {};
    },
    signInWithGoogle: vi.fn(async () => {}),
    sendEmailLink: vi.fn(async () => {}),
    isEmailLink: () => false,
    rememberedEmail: () => null,
    completeEmailLink: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
  return {
    auth,
    emit: (next: AuthState) => {
      state = next;
      act(() => listener(next));
    },
  };
}

const signedIn: AuthState = { status: "signed-in", user: { email: "a@example.com", name: null, verified: true } };

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the sign-in gate", () => {
  it("is not there at all for a build using the development sign-in", () => {
    render(
      <SignInGate enabled={false} auth={() => null}>
        <p>The home</p>
      </SignInGate>,
    );
    expect(screen.getByText("The home")).toBeTruthy();
  });

  it("checks, then asks a signed-out visitor to sign in, then shows the app", async () => {
    const { auth, emit } = fakeAuth();
    render(
      <SignInGate enabled auth={() => auth}>
        <p>The home</p>
      </SignInGate>,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Checking your sign-in/);
    emit({ status: "signed-out" });
    fireEvent.click(screen.getByTestId("sign-in-google"));
    await waitFor(() => expect(auth.signInWithGoogle).toHaveBeenCalled());
    expect(screen.queryByText("The home")).toBeNull();
    emit(signedIn);
    expect(screen.getByText("The home")).toBeTruthy();
  });

  it("sends an email link and says where it went", async () => {
    const { auth, emit } = fakeAuth();
    render(
      <SignInGate enabled auth={() => auth}>
        <p>The home</p>
      </SignInGate>,
    );
    emit({ status: "signed-out" });
    fireEvent.change(screen.getByTestId("sign-in-email"), { target: { value: " a@example.com " } });
    fireEvent.click(screen.getByTestId("sign-in-email-send"));
    expect((await screen.findByTestId("sign-in-link-sent")).textContent).toMatch(/a@example\.com/);
    expect(auth.sendEmailLink).toHaveBeenCalledWith("a@example.com");
  });

  it("finishes an emailed link on the browser that asked for it, and clears it from the address bar", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    const { auth, emit } = fakeAuth({ isEmailLink: () => true, rememberedEmail: () => "a@example.com" });
    render(
      <SignInGate enabled auth={() => auth}>
        <p>The home</p>
      </SignInGate>,
    );
    emit({ status: "signed-out" });
    await waitFor(() => expect(auth.completeEmailLink).toHaveBeenCalledWith("a@example.com", window.location.href));
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it("asks for the address when the link was opened on another device", async () => {
    const { auth, emit } = fakeAuth({ isEmailLink: () => true });
    render(
      <SignInGate enabled auth={() => auth}>
        <p>The home</p>
      </SignInGate>,
    );
    emit({ status: "signed-out" });
    expect(auth.completeEmailLink).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("sign-in-link-email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByTestId("sign-in-link-finish"));
    await waitFor(() => expect(auth.completeEmailLink).toHaveBeenCalled());
  });

  it("puts a sign-in failure in words, and says nothing when the person closed the pop-up", async () => {
    const failing = vi.fn().mockRejectedValueOnce({ code: "auth/network-request-failed" }).mockRejectedValueOnce({ code: "auth/popup-closed-by-user" });
    const { auth, emit } = fakeAuth({ signInWithGoogle: failing });
    render(
      <SignInGate enabled auth={() => auth}>
        <p>The home</p>
      </SignInGate>,
    );
    emit({ status: "signed-out" });
    fireEvent.click(screen.getByTestId("sign-in-google"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not reach the sign-in service/);
    fireEvent.click(screen.getByTestId("sign-in-google"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows how a deletion is going after it signed the person out", async () => {
    rememberDeletion("del_1");
    const client = testWorkspaceClient({
      fetch: async (url: string) => {
        expect(url).toBe("http://api.test/v1/account/deletions/del_1");
        return { ok: true, status: 200, json: async () => ({ status: "completed" }) } as Response;
      },
    });
    const { auth, emit } = fakeAuth();
    render(
      <SignInGate enabled auth={() => auth}>
        <p>The home</p>
      </SignInGate>,
      { wrapper: withWorkspaceClient(client) },
    );
    emit({ status: "signed-out" });
    await waitFor(() => expect(screen.getByTestId("deletion-status").getAttribute("data-status")).toBe("completed"));
    fireEvent.click(screen.getByTestId("deletion-done"));
    expect(screen.getByTestId("sign-in-google")).toBeTruthy();
    expect(window.localStorage.getItem("deckastra.account-deletion")).toBeNull();
  });
});
