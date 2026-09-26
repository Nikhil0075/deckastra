/**
 * Only the newest request may answer (audit UI-02, 2026-09-19).
 *
 * The deck list asked for project A, the person switched to B, B answered, and
 * then A's late answer replaced B's cards while B stayed selected — so a card
 * could be opened, moved or deleted under the wrong project's name. Every load
 * now takes a ticket, and a ticket is current only until the next one is
 * issued. Which request finishes last stops mattering; which one was asked
 * last decides.
 */
export interface LatestRequests {
  /** Start a request. The returned check is true only while it is the newest. */
  begin(): () => boolean;
}

export function latestRequests(): LatestRequests {
  let issued = 0;
  return {
    begin() {
      const ticket = ++issued;
      return () => ticket === issued;
    },
  };
}
