/**
 * The version history drawer's rules (editor Phase 5, Figma frame "version
 * history"): how a version row reads, and what "Compare with current" marks.
 * Pure, so tested directly — nothing renders `EditorShell` in jsdom.
 */

import { canonicalize, type PresentationDocument } from "@deckastra/presentation-schema";
import type { VersionSummary } from "@deckastra/workspace-contracts";

import { relativeTime } from "./deck-list";

export interface VersionRow {
  id: string;
  /** "v13". Counted from the oldest version listed. */
  number: string;
  /** What happened: the producing change's intent, else the version's label. */
  title: string;
  /** "18 min ago · Layout Agent". */
  detail: string;
  /** Agent-authored versions are marked yellow: "a human should look". */
  byAgent: boolean;
  current: boolean;
}

/** The API's default page. When it comes back full, older versions exist. */
export const VERSION_PAGE = 50;

/** "layout" → "Layout Agent"; "mcp:codex" → "codex (external agent)". */
export function agentName(agentId: string): string {
  if (agentId.startsWith("mcp:")) return `${agentId.slice(4) || "unknown"} (external agent)`;
  const words = agentId.replace(/[_-]+/g, " ").trim();
  if (!words) return "Agent";
  const titled = words.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return /agent$/i.test(titled) ? titled : `${titled} Agent`;
}

function isAgent(version: VersionSummary): boolean {
  return (version.change_source ?? version.source) === "agent" || Boolean(version.agent_id);
}

/**
 * Rows for the drawer, newest first as the API returns them.
 *
 * Numbering counts from the oldest *listed* version, so a list truncated at the
 * page size numbers what it shows rather than inventing the missing count —
 * `truncated` tells the caller to say so.
 */
export function versionRows(
  versions: readonly VersionSummary[],
  currentVersionId: string,
  now: number,
): { rows: VersionRow[]; truncated: boolean } {
  const total = versions.length;
  const rows = versions.map((version, index) => {
    const byAgent = isAgent(version);
    const who = byAgent ? (version.agent_id ? agentName(version.agent_id) : "Agent") : "You";
    const title =
      version.intent?.trim() ||
      version.label?.trim() ||
      (version.parent_version_id ? "Edited" : "Created");
    return {
      id: version.id,
      number: `v${total - index}`,
      title,
      detail: `${relativeTime(version.created_at, now)} · ${who}`,
      byAgent,
      current: version.id === currentVersionId,
    };
  });
  return { rows, truncated: total >= VERSION_PAGE };
}

export type SlideChange = "added" | "changed" | "removed" | "same";

export interface SlideComparison {
  slideId: string;
  /** 1-based position in the version being viewed, or null when removed there. */
  position: number | null;
  change: SlideChange;
}

/**
 * Per-slide marks for "Compare with current": what the chosen version has that
 * the current deck does not, and the other way round.
 *
 * Compared by slide **id**, because a slide's position is not its identity — a
 * reorder moves slides without changing any. Content is compared as canonical
 * bytes, so key order never reads as a change. Order is the viewed version's,
 * with slides only the current deck has appended as `removed` (restoring this
 * version would remove them).
 */
export function compareSlides(viewed: PresentationDocument, current: PresentationDocument): SlideComparison[] {
  const now = new Map(current.slides.map((slide) => [slide.id, slide]));
  const result: SlideComparison[] = viewed.slides.map((slide, index) => {
    const other = now.get(slide.id);
    const change: SlideChange = !other ? "added" : canonical(slide) === canonical(other) ? "same" : "changed";
    return { slideId: slide.id, position: index + 1, change };
  });
  const kept = new Set(viewed.slides.map((slide) => slide.id));
  for (const slide of current.slides) {
    if (!kept.has(slide.id)) result.push({ slideId: slide.id, position: null, change: "removed" });
  }
  return result;
}

/** Canonical bytes: key order never reads as a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Whether the slides both versions share stand in a different order. */
export function slideOrderDiffers(viewed: PresentationDocument, current: PresentationDocument): boolean {
  const shared = new Set(current.slides.map((slide) => slide.id));
  const a = viewed.slides.map((slide) => slide.id).filter((id) => shared.has(id));
  const inViewed = new Set(a);
  const b = current.slides.map((slide) => slide.id).filter((id) => inViewed.has(id));
  return a.some((id, index) => b[index] !== id);
}

/**
 * Whether anything outside the slides differs (theme, metadata, assets…). A
 * restore brings those back too, and a compare that listed only slides would
 * hide a theme change behind "same content". `updatedAt` is ignored: it moves
 * with every save and says nothing a person would want marked.
 */
export function deckWideDiffers(viewed: PresentationDocument, current: PresentationDocument): boolean {
  const strip = ({ slides: _slides, updatedAt: _updatedAt, ...rest }: PresentationDocument) => rest;
  return canonical(strip(viewed)) !== canonical(strip(current));
}

/** "2 slides changed · 1 slide added", or a sentence saying nothing differs. */
export function comparisonSummary(viewed: PresentationDocument, current: PresentationDocument): string {
  const comparison = compareSlides(viewed, current);
  const count = (change: SlideChange) => comparison.filter((entry) => entry.change === change).length;
  const parts: string[] = [];
  for (const change of ["changed", "added", "removed"] as const) {
    const n = count(change);
    if (n > 0) parts.push(`${n} ${n === 1 ? "slide" : "slides"} ${change}`);
  }
  if (slideOrderDiffers(viewed, current)) parts.push("slide order differs");
  if (deckWideDiffers(viewed, current)) parts.push("deck settings differ");
  return parts.length ? parts.join(" · ") : "Same content as the current deck.";
}
