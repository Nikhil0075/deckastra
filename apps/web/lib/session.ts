"use client";

/**
 * Development session.
 *
 * Phase 2 issues a signed dev token from `/v1/dev/session`; real email/social
 * sign-in is Phase 9. This caches the token so every page does not bootstrap a
 * new one, and it is deliberately thin — replacing it should touch this file and
 * nothing else.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const STORAGE_KEY = "deckastra.session";

export interface Session {
  token: string;
  userId: string;
  workspaceId: string;
  projectId: string | null;
}

let inflight: Promise<Session> | undefined;

export async function getSession(): Promise<Session> {
  const cached = read();
  if (cached) return cached;

  // One request even if several components ask at once, so a fresh load does not
  // create three users.
  inflight ??= fetchSession().finally(() => {
    inflight = undefined;
  });

  return inflight;
}

async function fetchSession(): Promise<Session> {
  const response = await fetch(`${API}/v1/dev/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "dev@localhost" }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "Development sign-in is disabled on this server."
        : `Could not start a session (${response.status}).`,
    );
  }

  const body = await response.json();
  const session: Session = {
    token: body.token,
    userId: body.user_id,
    workspaceId: body.workspace_id,
    projectId: body.project_id ?? null,
  };

  write(session);
  return session;
}

function read(): Session | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : undefined;
  } catch {
    // A blocked or full localStorage is not a reason to fail; a fresh session
    // costs one request.
    return undefined;
  }
}

function write(session: Session): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
