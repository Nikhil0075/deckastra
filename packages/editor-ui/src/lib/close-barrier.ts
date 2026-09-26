/**
 * Closing waits for the work on screen (final package review, item 01).
 *
 * A note typed a moment before the window closed lived only in its field: it
 * reaches the document after a pause, and the save queue after that, and
 * `beforeunload` looked at the queue alone. So the last thing someone wrote
 * before quitting was the thing a quit lost — measured in the desktop app, on
 * both the window's close and the application's quit.
 *
 * Every open editor registers here. `prepareToClose` asks each one to take its
 * drafts into the document, write the recovery journal, and try to save,
 * bounded in time, and answers:
 *
 * - `clean`: everything reached the service.
 * - `journalled`: something did not, and it is in the recovery journal, which
 *   the next open of this deck replays. Closing is safe either way; what it is
 *   not is silent, which is why the answer is recorded by the shell.
 *
 * After it has answered, `closeApproved()` tells `beforeunload` the close was
 * already prepared, so the desktop's close is not cancelled by the prompt a
 * browser would show — Electron cancels a close whose `beforeunload` objects,
 * with no dialog, which would leave a window that will not close.
 */

export type CloseReadiness = "clean" | "journalled" | "blocked";

/**
 * Asked to make the work safe within `timeoutMs`, and to say honestly what it
 * managed. A participant must not answer `journalled` unless the journal
 * actually holds the work — "we tried" is not a copy.
 */
type Participant = (timeoutMs: number) => Promise<CloseReadiness>;

const participants = new Set<Participant>();
let approved = false;

/** Register an open editor. Returns the function that unregisters it. */
export function registerCloseParticipant(participant: Participant): () => void {
  participants.add(participant);
  return () => {
    participants.delete(participant);
  };
}

/**
 * Prepare every open editor to close, and say what the worst case is.
 *
 * Never rejects, and a participant that throws or runs out of time is
 * **blocked**, not journalled (recheck of item 01, 2026-09-20). It used to
 * count as journalled, so a window whose storage was full *and* whose save had
 * failed reported "safe to close" while holding the only copy of someone's
 * work. A promise that did not answer is not evidence that anything was written.
 *
 * `approved` is set only when closing is safe: it is what stops `beforeunload`
 * objecting to a close the shell has already prepared, and a blocked close is
 * one the shell must not go through with.
 */
export async function prepareToClose(timeoutMs = 8000): Promise<CloseReadiness> {
  const worst = await settleWork(timeoutMs);
  approved = worst !== "blocked";
  return worst;
}

/**
 * Make the work on screen safe **without** approving a close (desktop item 14).
 *
 * A backup has the same problem closing has: a note typed a moment ago is in a
 * field, not in the document, not in the save queue and not in the recovery
 * journal — so a backup taken now would carry every saved deck and not the
 * sentence someone is looking at. The participants already do exactly the right
 * work, and the only thing that must not happen is `approved` being set: the
 * window is not closing, and a later close must still ask.
 */
export async function settleWork(timeoutMs = 8000): Promise<CloseReadiness> {
  const answers = await Promise.all(
    [...participants].map((participant) =>
      Promise.race([
        // The participant's own bound is shorter, so this is a backstop for one
        // that does not answer at all.
        participant(Math.max(200, timeoutMs - 250)).catch((): CloseReadiness => "blocked"),
        new Promise<CloseReadiness>((resolve) => setTimeout(() => resolve("blocked"), timeoutMs)),
      ]),
    ),
  );
  return answers.includes("blocked") ? "blocked" : answers.includes("journalled") ? "journalled" : "clean";
}

/** Whether a close has been prepared, so `beforeunload` need not object to it. */
export function closeApproved(): boolean {
  return approved;
}

export function resetCloseBarrierForTests(): void {
  participants.clear();
  approved = false;
}
