import type { Pronunciation } from "@deckastra/workspace-contracts";

/**
 * "Say this name as …" for voiced narration (integration plan 01 §7), written
 * one per line as `Deckastra = Deck astra`.
 *
 * Plain text rather than a table of fields for the same reason the
 * do-not-translate glossary is: a list of names is typed and pasted, and the
 * service turns each pair into an SSML `<sub>` only where a line uses it. A line
 * with no `=`, or an empty side, is skipped rather than refused — half-typed
 * input in a field is ordinary, and the voice is asked for nothing it cannot use.
 */
export const MAX_PRONUNCIATIONS = 100;

export function parsePronunciations(text: string): Pronunciation[] {
  const seen = new Set<string>();
  const out: Pronunciation[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const term = line.slice(0, at).trim().slice(0, 80);
    const say = line.slice(at + 1).trim().slice(0, 120);
    if (!term || !say || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push({ term, say });
    if (out.length === MAX_PRONUNCIATIONS) break;
  }
  return out;
}

export function formatPronunciations(list: readonly Pronunciation[]): string {
  return list.map((item) => `${item.term} = ${item.say}`).join("\n");
}

/** A stored preference, read defensively: it came back from a service. */
export function storedPronunciations(value: unknown): Pronunciation[] {
  const list = (value as { list?: unknown } | undefined)?.list;
  if (!Array.isArray(list)) return [];
  return parsePronunciations(
    list
      .filter((item): item is Pronunciation => typeof item?.term === "string" && typeof item?.say === "string")
      .map((item) => `${item.term} = ${item.say}`)
      .join("\n"),
  );
}
