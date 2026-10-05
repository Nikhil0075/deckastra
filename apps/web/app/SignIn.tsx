"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useChromeTheme } from "@deckastra/editor-ui";
import { Button, TextField } from "@deckastra/editor-ui/ui";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import { signInProblem, type AuthState, type CloudAuth } from "../lib/auth";
import { forgetDeletion, rememberedDeletion } from "../lib/deletion";

/**
 * The hosted web app's front door. Every route needs an account, so a
 * signed-out visitor sees this and nothing else; a checkout using the
 * development sign-in never sees it at all (`auth` is null there).
 *
 * Four states, each said: checking, signed out, completing an emailed link,
 * and an account deletion that is still being carried out.
 */
export function SignInGate({
  enabled,
  auth: getAuth,
  children,
}: {
  enabled: boolean;
  /** Called in the browser only: the SDK cannot start on the server. */
  auth: () => CloudAuth | null;
  children: ReactNode;
}) {
  // "Checking" on the server and on the first browser render alike, so the
  // page hydrates; the real state arrives from the SDK a moment later.
  const [auth, setAuth] = useState<CloudAuth | null>(null);
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [deletion, setDeletion] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const created = getAuth();
    setAuth(created);
    setDeletion(rememberedDeletion());
    return created?.subscribe((next) => {
      setState(next);
      // Deleting an account signs out; the receipt is what to show then.
      if (next.status === "signed-out") setDeletion(rememberedDeletion());
    });
  }, [enabled, getAuth]);

  if (!enabled) return <>{children}</>;
  if (deletion && state.status !== "signed-in") {
    return <DeletionStatus receipt={deletion} onDone={() => setDeletion(null)} />;
  }
  if (state.status === "loading") {
    return (
      <Frame>
        <p className="dk-muted" role="status">
          Checking your sign-in…
        </p>
      </Frame>
    );
  }
  if (state.status === "signed-out" && auth) return <SignIn auth={auth} />;
  if (state.status !== "signed-in") return null;
  return <>{children}</>;
}

function Frame({ children }: { children: ReactNode }) {
  // The editor's light or dark choice applies here too; mounting it is what
  // sets the page's theme before any editor chrome exists.
  useChromeTheme();
  return (
    <main className="dk-signin">
      <div className="dk-signin__card">
        <h1 className="dk-signin__brand">Deckastra</h1>
        {children}
      </div>
    </main>
  );
}

function SignIn({ auth }: { auth: CloudAuth }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"google" | "email" | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // Opened from a sign-in email: finish it, asking for the address only when
  // this browser did not send the link (opened on another device).
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    const href = window.location.href;
    if (!auth.isEmailLink(href)) return;
    setLink(href);
    const remembered = auth.rememberedEmail();
    if (remembered) void finish(remembered, href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  const attempt = async (kind: "google" | "email" | "link", work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(signInProblem(caught));
      return false;
    } finally {
      setBusy(null);
    }
  };

  async function finish(address: string, href: string) {
    const done = await attempt("link", () => auth.completeEmailLink(address.trim(), href));
    // The link is single use; leave it in the address bar and a reload fails.
    if (done) window.history.replaceState(null, "", window.location.pathname);
  }

  if (link) {
    return (
      <Frame>
        <h2 className="dk-signin__title">Finish signing in</h2>
        <form
          className="dk-signin__form"
          onSubmit={(event) => {
            event.preventDefault();
            void finish(email, link);
          }}
        >
          <TextField
            label="The email address the link was sent to"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            data-testid="sign-in-link-email"
          />
          <Button type="submit" variant="primary" disabled={!email.trim() || busy !== null} data-testid="sign-in-link-finish">
            {busy === "link" ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        {error ? (
          <p className="dk-settings__error" role="alert">
            {error}
          </p>
        ) : null}
      </Frame>
    );
  }

  return (
    <Frame>
      <h2 className="dk-signin__title">Sign in to Deckastra</h2>
      <p className="dk-muted">Your decks are kept in your account, so you can open them anywhere.</p>
      <Button
        variant="primary"
        disabled={busy !== null}
        onClick={() => void attempt("google", () => auth.signInWithGoogle())}
        data-testid="sign-in-google"
      >
        {busy === "google" ? "Signing in…" : "Continue with Google"}
      </Button>
      <p className="dk-signin__or">or</p>
      {sent ? (
        <p role="status" data-testid="sign-in-link-sent">
          We sent a sign-in link to {sent}. Open it on this device to finish.
        </p>
      ) : (
        <form
          className="dk-signin__form"
          onSubmit={(event) => {
            event.preventDefault();
            const address = email.trim();
            void attempt("email", () => auth.sendEmailLink(address)).then((ok) => ok && setSent(address));
          }}
        >
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            data-testid="sign-in-email"
          />
          <Button type="submit" variant="secondary" disabled={!email.trim() || busy !== null} data-testid="sign-in-email-send">
            {busy === "email" ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      )}
      {error ? (
        <p className="dk-settings__error" role="alert">
          {error}
        </p>
      ) : null}
    </Frame>
  );
}

/**
 * After an account deletion: the session is gone, so the receipt is read
 * without one. Polled until the service says it finished.
 */
function DeletionStatus({ receipt, onDone }: { receipt: string; onDone: () => void }) {
  const client = useWorkspaceClient();
  const [status, setStatus] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    if (!client.session.deletionStatus) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const answer = await client.session.deletionStatus!(receipt);
        if (!live) return;
        setStatus(answer.status);
        setUnreadable(false);
        if (answer.status === "completed") return;
      } catch {
        if (!live) return;
        setUnreadable(true);
      }
      timer = setTimeout(() => void ask(), 30_000);
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, receipt]);

  const finished = status === "completed";
  return (
    <Frame>
      <h2 className="dk-signin__title">{finished ? "Your account is deleted" : "Your account is being deleted"}</h2>
      <p data-testid="deletion-status" data-status={status ?? "unknown"}>
        {finished
          ? "Your cloud account, its decks and its files have been removed. Backups that still hold them expire within seven days."
          : "You are signed out and your account can no longer be used. Its decks and files are removed shortly; this page updates when that is done."}
      </p>
      {unreadable ? <p className="dk-muted">The status could not be read just now. It will be asked again.</p> : null}
      <p className="dk-muted">Files you saved to your own computer are not affected.</p>
      <Button
        variant="secondary"
        onClick={() => {
          forgetDeletion();
          onDone();
        }}
        data-testid="deletion-done"
      >
        {finished ? "Done" : "Back to sign in"}
      </Button>
    </Frame>
  );
}
