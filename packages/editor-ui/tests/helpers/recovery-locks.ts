/** Deterministic exclusive/ifAvailable lock semantics for jsdom hook tests.
 * The real same-origin/duplicate-tab contract is also exercised in Playwright. */
export function recoveryLocks(): LockManager {
  const held = new Set<string>();
  return {
    async request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, granted?: LockGrantedCallback<T>): Promise<T> {
      // Native lock requests/query run asynchronously, after a just-released
      // callback settles. Preserve that ordering when React remounts a hook.
      await Promise.resolve();
      const callback = typeof options === "function" ? options : granted!;
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name, mode: "exclusive" } as Lock); }
      finally { held.delete(name); }
    },
    async query() { await Promise.resolve(); return { held: [...held].map(name => ({ name, mode: "exclusive" as const })), pending: [] }; },
  } as LockManager;
}
