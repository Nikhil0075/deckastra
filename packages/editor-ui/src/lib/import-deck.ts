import type { DeckImport, WorkspaceClient } from "@deckastra/workspace-contracts";
import { DECK_IMPORT_MAX_BYTES } from "@deckastra/workspace-contracts";

/**
 * Opening a `.mydeck` file where there is no main process to do it: the web
 * app (FRONTEND_BACKEND_HANDOFF.md, "Files and export"). Upload, then wait for
 * the service to check and store the deck, then open what it made.
 *
 * Always as a copy (`copy: true` in the client): a file someone sent you must
 * not become the same deck as theirs by being opened.
 */

export const IMPORT_POLL_MS = 1500;
/** A package is checked in seconds; past this something is stuck, and saying so beats a spinner. */
export const IMPORT_GIVE_UP_MS = 5 * 60_000;

export type ImportOutcome =
  | { kind: "opened"; presentationId: string; existing: boolean; warnings: string[] }
  | { kind: "failed"; message: string };

export function isDeckFile(file: File): boolean {
  return /\.mydeck$/i.test(file.name);
}

export async function importDeckFile(
  client: WorkspaceClient,
  projectId: string,
  file: File,
  options: { signal?: AbortSignal; wait?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ImportOutcome> {
  const imports = client.imports;
  if (!imports) return { kind: "failed", message: "Deckastra files cannot be opened here." };
  if (!isDeckFile(file)) return { kind: "failed", message: `${file.name} is not a Deckastra file (.mydeck).` };
  if (file.size > DECK_IMPORT_MAX_BYTES) {
    return { kind: "failed", message: "This file is larger than 128 MB, the most Deckastra can open here." };
  }
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const request = options.signal ? { signal: options.signal } : {};

  let job: DeckImport;
  try {
    job = await imports.upload(projectId, file, request);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // The service holds at most three unfinished uploads per person, and one
    // that never finished (a closed tab, a dropped connection) is cleared only
    // after a day. Saying so beats "finish your pending imports", which no one
    // can act on: there is nothing on screen to finish.
    if ((error as { status?: number } | null)?.status === 429) {
      return {
        kind: "failed",
        message: "Earlier uploads that did not finish are still being held. They are cleared within a day; try again then.",
      };
    }
    return { kind: "failed", message: error instanceof Error && error.message ? error.message : "The file could not be uploaded." };
  }

  const started = now();
  while (job.status === "uploading" || job.status === "queued" || job.status === "running") {
    if (now() - started > IMPORT_GIVE_UP_MS) {
      return { kind: "failed", message: "Opening this file is taking far longer than it should. Try again later." };
    }
    await wait(IMPORT_POLL_MS);
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      job = await imports.status(job.id, request);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // One unanswered poll is not a failed import; the next one may answer.
    }
  }

  if ((job.status === "completed" || job.status === "existing") && job.presentation_id) {
    return { kind: "opened", presentationId: job.presentation_id, existing: job.status === "existing", warnings: job.warnings };
  }
  return { kind: "failed", message: job.error || "This file could not be opened." };
}
