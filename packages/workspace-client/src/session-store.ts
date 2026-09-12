import type { Session } from "@deckastra/workspace-contracts";

/**
 * Where a session is remembered between loads.
 *
 * An interface rather than `localStorage` directly because the desktop shell has
 * no reason to persist one — its session is seeded at launch and dies with the
 * process — and because a blocked or full store must not be able to break
 * sign-in. Every implementation here is allowed to forget; a forgotten session
 * costs one request.
 */
export interface SessionStore {
  read(): Session | undefined;
  write(session: Session): void;
  clear(): void;
}

const DEFAULT_KEY = "deckastra.session";

/** Backed by `localStorage`, tolerant of every way that can fail. */
export function browserSessionStore(key: string = DEFAULT_KEY): SessionStore {
  const available = (): Storage | undefined => {
    try {
      return typeof window === "undefined" ? undefined : window.localStorage;
    } catch {
      // Some browsers throw on the accessor itself when site data is blocked.
      return undefined;
    }
  };

  return {
    read() {
      try {
        const raw = available()?.getItem(key);
        return raw ? (JSON.parse(raw) as Session) : undefined;
      } catch {
        return undefined;
      }
    },
    write(session) {
      try {
        available()?.setItem(key, JSON.stringify(session));
      } catch {
        /* A full or blocked store is not a reason to fail the request. */
      }
    },
    clear() {
      try {
        available()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Holds the session for the life of the process. The desktop default. */
export function memorySessionStore(): SessionStore {
  let held: Session | undefined;
  return {
    read: () => held,
    write: (session) => {
      held = session;
    },
    clear: () => {
      held = undefined;
    },
  };
}
