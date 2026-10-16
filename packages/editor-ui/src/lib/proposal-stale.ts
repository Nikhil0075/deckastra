/**
 * Whether a pending change meets an edit made after it was written
 * (2026-10-17, release E2E step 5). The service refuses to approve such a
 * change (`proposals.changed_since`, code `E_PROPOSAL_STALE`); this is the same
 * rule run in the editor, so the card says so before anyone presses Approve
 * rather than after.
 *
 * A change written against an earlier version is otherwise fine: Approve
 * rebases it onto the deck as it is, and the pictures show that. It is stale
 * only where it would put the agent's older value over a newer one.
 */

import { useEffect, useState } from "react";
import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { readPath } from "@deckastra/transactions";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    return left.length === other.length && left.every((item, index) => same(item, other[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  if (keys.length !== Object.keys(b).filter((key) => b[key] !== undefined).length) return false;
  return keys.every((key) => same(a[key], b[key]));
}

/** Paths the change would write whose values moved between its base and now. Mirrors the service. */
export function changedSince(base: unknown, head: unknown, operations: readonly PatchOperation[]): string[] {
  const found: string[] = [];
  for (const operation of operations) {
    for (const path of [operation.path, "from" in operation ? operation.from : undefined]) {
      if (typeof path !== "string" || path.endsWith("/-") || found.includes(path)) continue;
      if (!same(readPath(base, path), readPath(head, path))) found.push(path);
    }
  }
  return found;
}

/** What a person calls the place a path points at: "the deck title", "slide 2". */
export function placeWords(paths: readonly string[], document: PresentationDocument): string {
  const places: string[] = [];
  for (const path of paths) {
    const slide = /\/slides\/id:([^/]+)/.exec(path)?.[1];
    const index = slide ? document.slides.findIndex((one) => one.id === slide) : -1;
    const words = path === "/metadata/title"
      ? "the deck title"
      : index >= 0
        ? `slide ${index + 1}`
        : slide
          ? "a slide that has since been removed"
          : path.startsWith("/theme")
            ? "the theme"
            : "the deck settings";
    if (!places.includes(words)) places.push(words);
  }
  return places.length <= 2 ? places.join(" and ") : `${places.slice(0, 2).join(", ")} and ${places.length - 2} more`;
}

/**
 * The paths a pending change would overwrite, read once per change and head.
 * Null until known, and when the change was written against the head (nothing
 * can have moved under it) or the base cannot be read.
 */
export function useStaleEdits(
  client: Pick<WorkspaceClient, "documents">,
  presentationId: string,
  detail: { base_version_id?: string | null; operations: PatchOperation[] } | null,
  document: PresentationDocument,
  headVersionId: string,
): string[] | null {
  const [stale, setStale] = useState<string[] | null>(null);
  const base = detail?.base_version_id ?? null;
  useEffect(() => {
    setStale(null);
    if (!detail || !base || base === headVersionId) return;
    const controller = new AbortController();
    client.documents
      .readAt(presentationId, base, { signal: controller.signal })
      .then((read) => setStale(changedSince(read.document, document, detail.operations)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, presentationId, detail, base, document, headVersionId]);
  return stale && stale.length ? stale : null;
}
