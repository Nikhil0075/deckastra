import {
  canonicalize,
  joinPath,
  newId,
  serializeDocument,
  validateDocument,
  walkElements,
  type IdPrefix,
  type PatchOperation,
  type PresentationDocument,
  type PresentationElement,
  type Slide,
  type ValidationIssue,
  type ValidationReport,
} from "@deckastra/presentation-schema";
import { importPortableSlide, isPortableSlideEnvelope } from "./portable-slide";

/** The Code tab is another view of the document, never another mutation path. */
export type CodeEditScope = { kind: "deck" } | { kind: "slide"; slideId: string };

export const CODE_EDIT_MAX_BYTES = 8 * 1024 * 1024;
export const CODE_EDIT_MAX_DEPTH = 64;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const LOCKED_DECK_FIELDS = ["id", "schemaVersion", "createdAt", "updatedAt", "assets"] as const;
const PLACEHOLDER_ID = /^(?:el|sld|anm|clp|blk)_new[\w-]*$/;

export class CodeEditError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly issues: ValidationIssue[];

  constructor(
    message: string,
    options: {
      code?: string;
      path?: string;
      line?: number;
      column?: number;
      issues?: ValidationIssue[];
    } = {},
  ) {
    super(message);
    this.name = "CodeEditError";
    this.code = options.code ?? "E_CODE_EDIT";
    this.path = options.path;
    this.line = options.line;
    this.column = options.column;
    this.issues = options.issues ?? [];
  }
}

export interface CodeEditSummary {
  operations: number;
  added: number;
  changed: number;
  removed: number;
  moved: number;
  changedSlideIds: string[];
  themeChanged: boolean;
  metadataChanged: boolean;
}

export interface PreparedCodeEdit {
  candidate: PresentationDocument;
  operations: PatchOperation[];
  report: ValidationReport;
  summary: CodeEditSummary;
  mintedIds: ReadonlyMap<string, string>;
  messages: string[];
}

export interface PrepareCodeEditOptions {
  /** Test seam; production uses the schema package's monotonic ULID factory. */
  mintId?: (prefix: IdPrefix) => string;
}

export function codeTextForScope(document: PresentationDocument, scope: CodeEditScope): string {
  if (scope.kind === "deck") return serializeDocument(document);
  const slide = document.slides.find((item) => item.id === scope.slideId);
  if (!slide) return "";
  return `${JSON.stringify(canonicalize(slide), null, 2)}\n`;
}

/**
 * Parse, secure, merge, validate and diff one Code-tab draft. The returned
 * operations are handed to editor.apply by the surface; this module never
 * mutates editor state itself.
 */
export function prepareCodeEdit(
  base: PresentationDocument,
  scope: CodeEditScope,
  text: string,
  options: PrepareCodeEditOptions = {},
): PreparedCodeEdit {
  const parsed = parseCodeJson(text);
  requireRecord(parsed, scope.kind === "deck" ? "The deck must be a JSON object." : "The slide must be a JSON object.");

  let preparedBase = base;
  let preparedValue = parsed;
  let importedIds: ReadonlyMap<string, string> = new Map();
  let messages: string[] = [];
  if (scope.kind === "slide" && isPortableSlideEnvelope(parsed)) {
    try {
      const imported = importPortableSlide(base, scope.slideId, parsed);
      preparedBase = imported.document;
      preparedValue = imported.slide as unknown as Record<string, unknown>;
      importedIds = imported.mintedIds;
      messages = imported.messages;
    } catch (error) {
      throw new CodeEditError(error instanceof Error ? error.message : "That portable slide could not be imported.", {
        code: "E_PORTABLE_SLIDE",
      });
    }
  } else if (scope.kind === "deck") checkLockedDeckFields(base, parsed);
  else checkLockedSlideId(base, scope.slideId, parsed);

  const materialized = materializeEditableIds(preparedValue, scope, options.mintId ?? newId);
  const candidate = cleanupReferencesForRemovedElements(
    base,
    candidateDocument(preparedBase, scope, materialized.value),
  );
  const report = validateDocument(candidate);
  if (!report.valid) {
    const first = report.errors[0];
    throw new CodeEditError(
      first ? `${first.code} ${first.path}: ${first.message}` : "The document is not valid.",
      { code: first?.code ?? "E003", path: first?.path, issues: report.errors },
    );
  }

  const operations = diffDocument(base, candidate);
  return {
    candidate,
    operations,
    report,
    summary: summarizeCodeEdit(operations, base, candidate),
    mintedIds: new Map([...importedIds, ...materialized.mintedIds]),
    messages,
  };
}

export function parseCodeJson(text: string): unknown {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > CODE_EDIT_MAX_BYTES) {
    throw new CodeEditError(`Code edits are limited to 8 MB; this draft is ${formatBytes(byteLength)}.`, {
      code: "E009",
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    const offset = jsonErrorOffset(message) ?? Math.max(0, text.trimEnd().length - 1);
    const location = lineAndColumn(text, offset);
    throw new CodeEditError(message, { code: "E_JSON", ...location });
  }

  inspectUntrustedJson(value);
  return value;
}

function inspectUntrustedJson(value: unknown, path = "", depth = 0): void {
  if (depth > CODE_EDIT_MAX_DEPTH) {
    throw new CodeEditError(`JSON nesting is limited to ${CODE_EDIT_MAX_DEPTH} levels.`, {
      code: "E009",
      path: path || "/",
    });
  }
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectUntrustedJson(item, `${path}/${index}`, depth + 1));
    return;
  }

  for (const key of Object.keys(value)) {
    const childPath = `${path}/${escapeSegment(key)}`;
    if (FORBIDDEN_KEYS.has(key)) {
      throw new CodeEditError(`The key "${key}" is not allowed in pasted JSON.`, {
        code: "E_UNSAFE_KEY",
        path: childPath,
      });
    }
    inspectUntrustedJson((value as Record<string, unknown>)[key], childPath, depth + 1);
  }
}

function candidateDocument(
  base: PresentationDocument,
  scope: CodeEditScope,
  parsed: Record<string, unknown>,
): PresentationDocument {
  if (scope.kind === "deck") return parsed as unknown as PresentationDocument;
  const candidate = structuredClone(base);
  const index = candidate.slides.findIndex((slide) => slide.id === scope.slideId);
  if (index < 0) {
    throw new CodeEditError("The slide being edited no longer exists.", { code: "E301", path: `/slides/id:${scope.slideId}` });
  }
  candidate.slides[index] = parsed as unknown as Slide;
  return candidate;
}

function checkLockedDeckFields(base: PresentationDocument, parsed: Record<string, unknown>): void {
  for (const field of LOCKED_DECK_FIELDS) {
    if (!deepEqual(base[field], parsed[field])) {
      throw new CodeEditError(`"${field}" is read-only in Deck code.`, {
        code: "E_LOCKED_FIELD",
        path: `/${field}`,
      });
    }
  }
}

function checkLockedSlideId(base: PresentationDocument, slideId: string, parsed: Record<string, unknown>): void {
  const slide = base.slides.find((item) => item.id === slideId);
  if (!slide) {
    throw new CodeEditError("The slide being edited no longer exists.", { code: "E301", path: `/slides/id:${slideId}` });
  }
  if (parsed.id !== slide.id) {
    throw new CodeEditError('"id" is read-only in Slide code.', {
      code: "E_LOCKED_FIELD",
      path: "/id",
    });
  }
}

function materializeEditableIds(
  parsed: Record<string, unknown>,
  scope: CodeEditScope,
  mint: (prefix: IdPrefix) => string,
): { value: Record<string, unknown>; mintedIds: ReadonlyMap<string, string> } {
  const value = structuredClone(parsed);
  const minted = new Map<string, string>();
  const prefixes = new Map<string, IdPrefix>();

  const fresh = (placeholder: string | undefined, prefix: IdPrefix): string => {
    if (!placeholder) return mint(prefix);
    const earlierPrefix = prefixes.get(placeholder);
    if (earlierPrefix && earlierPrefix !== prefix) {
      throw new CodeEditError(`Placeholder id "${placeholder}" is used for more than one kind of object.`, {
        code: "E001",
      });
    }
    prefixes.set(placeholder, prefix);
    const existing = minted.get(placeholder);
    if (existing) return existing;
    const id = mint(prefix);
    minted.set(placeholder, id);
    return id;
  };

  const ensureIdentity = (record: Record<string, unknown>, prefix: IdPrefix, allowMissing: boolean) => {
    const current = record.id;
    if (current === undefined && allowMissing) record.id = fresh(undefined, prefix);
    else if (typeof current === "string" && PLACEHOLDER_ID.test(current)) record.id = fresh(current, prefix);
  };

  const visitElement = (input: unknown) => {
    if (!isRecord(input)) return;
    ensureIdentity(input, "el", true);
    visitRichTextDocuments(input);
    if (Array.isArray(input.children)) input.children.forEach(visitElement);
  };

  const visitRichTextDocuments = (input: unknown): void => {
    if (Array.isArray(input)) {
      input.forEach(visitRichTextDocuments);
      return;
    }
    if (!isRecord(input)) return;
    if (input.version === 1 && Array.isArray(input.blocks)) {
      for (const block of input.blocks) {
        if (isRecord(block)) ensureIdentity(block, "blk", true);
      }
    }
    for (const child of Object.values(input)) visitRichTextDocuments(child);
  };

  const visitSlide = (input: unknown, allowMissingId: boolean) => {
    if (!isRecord(input)) return;
    ensureIdentity(input, "sld", allowMissingId);
    if (Array.isArray(input.elements)) input.elements.forEach(visitElement);
    if (Array.isArray(input.animations)) {
      for (const track of input.animations) {
        if (!isRecord(track)) continue;
        ensureIdentity(track, "anm", true);
        if (Array.isArray(track.clips)) {
          for (const clip of track.clips) if (isRecord(clip)) ensureIdentity(clip, "clp", true);
        }
      }
    }
  };

  if (scope.kind === "deck") {
    if (Array.isArray(value.slides)) value.slides.forEach((slide) => visitSlide(slide, true));
  } else {
    visitSlide(value, false);
  }

  // References may appear before the object that declares a placeholder. A
  // second pass rewrites every exact placeholder value after all ids are known.
  const rewrite = (input: unknown): unknown => {
    if (typeof input === "string") return minted.get(input) ?? input;
    if (Array.isArray(input)) return input.map(rewrite);
    if (!isRecord(input)) return input;
    for (const key of Object.keys(input)) input[key] = rewrite(input[key]);
    return input;
  };
  rewrite(value);
  return { value, mintedIds: minted };
}

/**
 * Deleting an element from JSON has the same referential cleanup as deleting it
 * on the canvas. Invalid references typed from scratch are still left in place
 * for validateDocument to reject; only references to ids that existed in the
 * base and were deliberately removed are cleaned up.
 */
function cleanupReferencesForRemovedElements(
  base: PresentationDocument,
  candidate: PresentationDocument,
): PresentationDocument {
  const beforeIds = new Set<string>();
  const afterIds = new Set<string>();
  for (const slide of base.slides) {
    for (const { element } of walkElements(slide.elements)) beforeIds.add(element.id);
  }
  for (const slide of candidate.slides) {
    for (const { element } of walkElements(slide.elements)) afterIds.add(element.id);
  }
  const removed = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
  if (removed.size === 0) return candidate;

  for (const slide of candidate.slides) {
    if (slide.animations) {
      slide.animations = slide.animations.filter((track) => !removed.has(track.targetId));
    }
    if (slide.interactions) {
      slide.interactions = slide.interactions.filter((interaction) => {
        const trigger = interaction.trigger as { targetId?: string };
        const action = interaction.action as { targetId?: string };
        return !(
          (trigger.targetId && removed.has(trigger.targetId)) ||
          (action.targetId && removed.has(action.targetId))
        );
      });
    }
    if (slide.transition?.sharedElements) {
      slide.transition.sharedElements = slide.transition.sharedElements.filter(
        (mapping) => !removed.has(mapping.sourceElementId) && !removed.has(mapping.destinationElementId),
      );
    }
  }
  return candidate;
}

export function diffDocument(before: PresentationDocument, after: PresentationDocument): PatchOperation[] {
  const operations: PatchOperation[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("slides");

  for (const key of keys) diffProperty(operations, before, after, key, `/${escapeSegment(key)}`);

  const beforeById = new Map(before.slides.map((slide) => [slide.id, slide]));
  const afterById = new Map(after.slides.map((slide) => [slide.id, slide]));

  for (const slide of before.slides) {
    if (!afterById.has(slide.id)) operations.push({ op: "remove", path: `/slides/id:${slide.id}` });
  }
  for (const slide of after.slides) {
    const previous = beforeById.get(slide.id);
    if (!previous) operations.push({ op: "add", path: "/slides/-", value: slide });
    else diffSlide(operations, previous, slide, `/slides/id:${slide.id}`);
  }
  reorderIdentified(
    operations,
    "/slides",
    before.slides.map((slide) => slide.id),
    after.slides.map((slide) => slide.id),
  );
  return operations;
}

function diffSlide(operations: PatchOperation[], before: Slide, after: Slide, path: string): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("id");
  keys.delete("elements");
  for (const key of keys) {
    diffProperty(
      operations,
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      key,
      `${path}/${escapeSegment(key)}`,
    );
  }
  diffElements(operations, before.elements, after.elements, `${path}/elements`);
}

function diffElements(
  operations: PatchOperation[],
  before: PresentationElement[],
  after: PresentationElement[],
  path: string,
): void {
  const beforeById = new Map(before.map((element) => [element.id, element]));
  const afterById = new Map(after.map((element) => [element.id, element]));

  for (const element of before) {
    if (!afterById.has(element.id)) operations.push({ op: "remove", path: `${path}/id:${element.id}` });
  }
  for (const element of after) {
    const previous = beforeById.get(element.id);
    if (!previous) {
      operations.push({ op: "add", path: `${path}/-`, value: element });
      continue;
    }
    if (deepEqual(previous, element)) continue;

    if (isGroupLike(previous) && isGroupLike(element)) {
      const keys = new Set([...Object.keys(previous), ...Object.keys(element)]);
      keys.delete("id");
      keys.delete("children");
      for (const key of keys) {
        diffProperty(operations, previous, element, key, `${path}/id:${element.id}/${escapeSegment(key)}`);
      }
      diffElements(operations, previous.children, element.children, `${path}/id:${element.id}/children`);
    } else {
      operations.push({ op: "replace", path: `${path}/id:${element.id}`, value: element });
    }
  }

  reorderIdentified(
    operations,
    path,
    before.map((element) => element.id),
    after.map((element) => element.id),
  );
}

function reorderIdentified(
  operations: PatchOperation[],
  path: string,
  beforeIds: readonly string[],
  afterIds: readonly string[],
): void {
  const wanted = new Set(afterIds);
  const current = beforeIds.filter((id) => wanted.has(id));
  for (const id of afterIds) if (!current.includes(id)) current.push(id);

  afterIds.forEach((id, targetIndex) => {
    const currentIndex = current.indexOf(id);
    if (currentIndex === targetIndex || currentIndex < 0) return;
    operations.push({ op: "move", from: `${path}/id:${id}`, path: `${path}/${targetIndex}` });
    current.splice(currentIndex, 1);
    current.splice(targetIndex, 0, id);
  });
}

function diffProperty(
  operations: PatchOperation[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string,
  path: string,
): void {
  const had = Object.hasOwn(before, key);
  const has = Object.hasOwn(after, key);
  if (had && !has) operations.push({ op: "remove", path });
  else if (!had && has) operations.push({ op: "add", path, value: after[key] });
  else if (had && has && !deepEqual(before[key], after[key])) {
    operations.push({ op: "replace", path, value: after[key] });
  }
}

export function summarizeCodeEdit(
  operations: readonly PatchOperation[],
  before: PresentationDocument,
  after: PresentationDocument,
): CodeEditSummary {
  const changedSlides = new Set<string>();
  for (const operation of operations) {
    for (const path of [operation.path, "from" in operation ? operation.from : undefined]) {
      const match = path?.match(/^\/slides\/id:([^/]+)/);
      if (match?.[1]) changedSlides.add(match[1]);
    }
  }
  return {
    operations: operations.length,
    added: operations.filter((operation) => operation.op === "add").length,
    changed: operations.filter((operation) => operation.op === "replace").length,
    removed: operations.filter((operation) => operation.op === "remove").length,
    moved: operations.filter((operation) => operation.op === "move").length,
    changedSlideIds: [...changedSlides],
    themeChanged: !deepEqual(before.theme, after.theme),
    metadataChanged: !deepEqual(before.metadata, after.metadata),
  };
}

function isGroupLike(value: PresentationElement): value is PresentationElement & { children: PresentationElement[] } {
  return value.type === "group" && Array.isArray((value as { children?: unknown }).children);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  return keys.length === Object.keys(bRecord).length && keys.every((key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

function requireRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new CodeEditError(message, { code: "E003", path: "/" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeSegment(value: string): string {
  return joinPath([value]).slice(1);
}

function jsonErrorOffset(message: string): number | undefined {
  const match = message.match(/position\s+(\d+)/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
