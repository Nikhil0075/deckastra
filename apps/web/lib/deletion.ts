/**
 * The receipt of an account deletion, kept so a reload after signing out still
 * shows how the deletion is going. It names no one: a receipt id is all it is,
 * and the status route answers only "queued" or "completed".
 */
const KEY = "deckastra.account-deletion";

export function rememberDeletion(receipt: string): void {
  try {
    window.localStorage.setItem(KEY, receipt);
  } catch {
    /* Without it the status is shown until the page is left; nothing worse. */
  }
}

export function rememberedDeletion(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetDeletion(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
