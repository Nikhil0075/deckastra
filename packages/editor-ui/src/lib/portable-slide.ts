import {
  canonicalize,
  newId,
  plainText,
  walkElements,
  type AssetReference,
  type PresentationDocument,
  type PresentationElement,
  type Slide,
} from "@deckastra/presentation-schema";
import { withFreshIdsAndMap } from "@deckastra/presentation-core";

const FORMAT = "deckastra-slide" as const;
const CUSTOM_COLOR = /^token:colors\.custom\.(.+)$/;

export interface PortableAssetDependency {
  assetId: string;
  type: AssetReference["type"];
  name?: string;
  sha256?: string;
  fontFamily?: string;
}

export interface PortableSlideEnvelope {
  format: typeof FORMAT;
  schemaVersion: string;
  slide: Slide;
  dependencies: {
    colors: Record<string, unknown>;
    objectStyles: Record<string, unknown>;
    fonts: PortableAssetDependency[];
    assets: PortableAssetDependency[];
  };
}

export interface ImportedPortableSlide {
  document: PresentationDocument;
  slide: Slide;
  mintedIds: ReadonlyMap<string, string>;
  messages: string[];
}

/** A portable copy contains only safe dependency metadata, never storage keys. */
export function createPortableSlide(
  document: PresentationDocument,
  slideId: string,
): PortableSlideEnvelope {
  const slide = document.slides.find((item) => item.id === slideId);
  if (!slide) throw new Error("The slide being copied no longer exists.");

  const colorNames = new Set<string>();
  const styleNames = new Set<string>();
  const assetIds = new Set<string>();
  const fontFamilies = new Set<string>();
  collectReferences(slide, colorNames, styleNames, assetIds, fontFamilies);

  const objectStyles: Record<string, unknown> = {};
  for (const name of styleNames) {
    const value = document.theme.objectStyles?.[name];
    if (value === undefined) continue;
    objectStyles[name] = structuredClone(value);
    collectReferences(value, colorNames, styleNames, assetIds, fontFamilies);
  }

  const colors: Record<string, unknown> = {};
  for (const name of colorNames) {
    const value = document.theme.colors.custom?.[name];
    if (value !== undefined) colors[name] = structuredClone(value);
  }

  const assets = document.assets
    .filter((asset) => assetIds.has(asset.id) && asset.type !== "font")
    .map(portableAsset);
  const fonts = document.assets
    .filter((asset) => asset.type === "font" && (
      assetIds.has(asset.id) || (asset.fontFamily ? fontFamilies.has(asset.fontFamily) : false)
    ))
    .map(portableAsset);

  return canonicalize({
    format: FORMAT,
    schemaVersion: document.schemaVersion,
    slide: structuredClone(slide),
    dependencies: { colors, objectStyles, fonts, assets },
  }) as PortableSlideEnvelope;
}

export function portableSlideText(document: PresentationDocument, slideId: string): string {
  return `${JSON.stringify(createPortableSlide(document, slideId), null, 2)}\n`;
}

export function isPortableSlideEnvelope(value: unknown): value is PortableSlideEnvelope {
  if (!isRecord(value) || value.format !== FORMAT || typeof value.schemaVersion !== "string") return false;
  if (!isRecord(value.slide) || !isRecord(value.dependencies)) return false;
  const dependencies = value.dependencies;
  return isRecord(dependencies.colors)
    && isRecord(dependencies.objectStyles)
    && Array.isArray(dependencies.fonts)
    && Array.isArray(dependencies.assets);
}

/**
 * Import an envelope into the current slide slot. Theme dependencies are
 * merged, ids are fresh, and absent media is represented without inventing a
 * storageKey. The returned document is still validated by the Code pipeline.
 */
export function importPortableSlide(
  base: PresentationDocument,
  targetSlideId: string,
  envelope: PortableSlideEnvelope,
): ImportedPortableSlide {
  const document = structuredClone(base);
  if (!document.slides.some((slide) => slide.id === targetSlideId)) {
    throw new Error("The slide being edited no longer exists.");
  }
  const messages: string[] = [];
  const slideSource = structuredClone(envelope.slide);

  const colorMap = mergeNamedDependencies(
    document.theme.colors.custom ?? {},
    envelope.dependencies.colors,
    "color",
    messages,
  );
  if (Object.keys(envelope.dependencies.colors).length) {
    document.theme.colors.custom = document.theme.colors.custom ?? {};
    mergeValues(document.theme.colors.custom as Record<string, unknown>, envelope.dependencies.colors, colorMap);
  }

  const styleMap = mergeNamedDependencies(
    document.theme.objectStyles ?? {},
    envelope.dependencies.objectStyles,
    "style",
    messages,
  );
  if (Object.keys(envelope.dependencies.objectStyles).length) {
    document.theme.objectStyles = document.theme.objectStyles ?? {};
    const rewrittenStyles = structuredClone(envelope.dependencies.objectStyles);
    rewriteNamedReferences(rewrittenStyles, colorMap, new Map());
    mergeValues(document.theme.objectStyles as Record<string, unknown>, rewrittenStyles, styleMap);
  }
  rewriteNamedReferences(slideSource, colorMap, styleMap);

  const allDependencies = [...envelope.dependencies.assets, ...envelope.dependencies.fonts];
  const assetMap = new Map<string, string>();
  const missing = new Map<string, PortableAssetDependency>();
  for (const dependency of allDependencies) {
    if (!isPortableAsset(dependency)) continue;
    const match = document.assets.find((asset) =>
      asset.id === dependency.assetId
      || Boolean(dependency.sha256 && asset.checksum === dependency.sha256),
    );
    if (match) assetMap.set(dependency.assetId, match.id);
    else missing.set(dependency.assetId, dependency);
  }
  rewriteAssetReferences(slideSource, assetMap);
  replaceMissingMedia(slideSource.elements, missing, messages);
  replaceMissingAssetPayloads(slideSource, missing, messages);
  for (const dependency of missing.values()) {
    if (dependency.type === "font") {
      messages.push(`Font “${dependency.fontFamily ?? dependency.name ?? dependency.assetId}” is unavailable; the target deck will use its fallback.`);
    }
  }

  const { slide, idMap } = withFreshIdsAndMap(slideSource);
  const mintedIds = new Map(idMap);
  const mintedSlideId = slide.id;
  slide.id = targetSlideId;
  rewriteExactString(slide, mintedSlideId, targetSlideId);
  remintTextBlocks(slide, mintedIds);

  const elementIds = new Set<string>();
  for (const { element } of walkElements(slide.elements)) elementIds.add(element.id);
  const mappings = slide.transition?.sharedElements;
  if (mappings?.length) {
    const kept = mappings.filter((mapping) =>
      elementIds.has(mapping.sourceElementId) && elementIds.has(mapping.destinationElementId),
    );
    const removed = mappings.length - kept.length;
    if (removed) messages.push(`Dropped ${removed} morph mapping${removed === 1 ? "" : "s"} that pointed outside the copied slide.`);
    if (kept.length) slide.transition!.sharedElements = kept;
    else delete slide.transition!.sharedElements;
  }

  mintedIds.set(envelope.slide.id, targetSlideId);
  return { document, slide, mintedIds, messages };
}

function portableAsset(asset: AssetReference): PortableAssetDependency {
  return {
    assetId: asset.id,
    type: asset.type,
    ...(asset.fileName ? { name: asset.fileName } : {}),
    ...(asset.checksum ? { sha256: asset.checksum } : {}),
    ...(asset.fontFamily ? { fontFamily: asset.fontFamily } : {}),
  };
}

function collectReferences(
  value: unknown,
  colors: Set<string>,
  styles: Set<string>,
  assets: Set<string>,
  fontFamilies: Set<string>,
): void {
  if (typeof value === "string") {
    const color = value.match(CUSTOM_COLOR)?.[1];
    if (color) colors.add(color);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, colors, styles, assets, fontFamilies));
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.styleRef === "string") styles.add(value.styleRef);
  if (typeof value.assetId === "string") assets.add(value.assetId);
  if (typeof value.posterAssetId === "string") assets.add(value.posterAssetId);
  if (typeof value.fallbackAssetId === "string") assets.add(value.fallbackAssetId);
  if (typeof value.fontFamily === "string" && !value.fontFamily.startsWith("token:")) {
    fontFamilies.add(value.fontFamily);
  }
  Object.values(value).forEach((item) => collectReferences(item, colors, styles, assets, fontFamilies));
}

function mergeNamedDependencies(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  kind: string,
  messages: string[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(incoming)) {
    if (!(name in existing) || deepEqual(existing[name], value)) {
      names.set(name, name);
      continue;
    }
    let at = `${name} (imported)`;
    let suffix = 2;
    while (at in existing || Object.values(Object.fromEntries(names)).includes(at)) at = `${name} (imported ${suffix++})`;
    names.set(name, at);
    messages.push(`Renamed ${kind} “${name}” to “${at}” because the target deck has a different value.`);
  }
  return names;
}

function mergeValues(target: Record<string, unknown>, source: Record<string, unknown>, names: ReadonlyMap<string, string>): void {
  for (const [name, value] of Object.entries(source)) {
    const targetName = names.get(name) ?? name;
    if (!(targetName in target)) target[targetName] = structuredClone(value);
  }
}

function rewriteNamedReferences(value: unknown, colors: ReadonlyMap<string, string>, styles: ReadonlyMap<string, string>): void {
  visitMutable(value, (record, key, current) => {
    if (key === "styleRef" && typeof current === "string") return styles.get(current) ?? current;
    if (typeof current === "string") {
      const color = current.match(CUSTOM_COLOR)?.[1];
      if (color && colors.has(color)) return `token:colors.custom.${colors.get(color)}`;
    }
    return current;
  });
}

function rewriteAssetReferences(value: unknown, assets: ReadonlyMap<string, string>): void {
  visitMutable(value, (_record, key, current) => {
    if ((key === "assetId" || key === "posterAssetId" || key === "fallbackAssetId") && typeof current === "string") {
      return assets.get(current) ?? current;
    }
    return current;
  });
}

function replaceMissingMedia(
  elements: PresentationElement[],
  missing: ReadonlyMap<string, PortableAssetDependency>,
  messages: string[],
): void {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const assetId = typeof (element as Record<string, unknown>).assetId === "string"
      ? (element as Record<string, unknown>).assetId as string
      : undefined;
    if (assetId && missing.has(assetId)) {
      const dependency = missing.get(assetId)!;
      const label = dependency.name ?? dependency.assetId;
      elements[index] = {
        id: element.id,
        type: "shape",
        name: `Missing asset · ${label}`,
        transform: structuredClone(element.transform),
        shape: "rectangle",
        text: plainText(`Missing asset\n${label}`, newId("blk")),
        style: {
          fill: { type: "solid", color: "token:colors.surfaceAlt" },
          stroke: { paint: { type: "solid", color: "token:colors.border" }, width: 1 },
        },
        typography: { fontSize: 18, color: "token:colors.foregroundMuted" },
        verticalAlign: "middle",
      } as unknown as PresentationElement;
      messages.push(`Replaced missing asset “${label}” with a labeled placeholder.`);
      continue;
    }
    if (element.type === "group" && Array.isArray((element as { children?: unknown }).children)) {
      replaceMissingMedia((element as PresentationElement & { children: PresentationElement[] }).children, missing, messages);
    }
    removeMissingOptionalAssetReferences(element, missing);
  }
}

function removeMissingOptionalAssetReferences(value: unknown, missing: ReadonlyMap<string, unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => removeMissingOptionalAssetReferences(item, missing));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    const current = value[key];
    if ((key === "posterAssetId" || key === "fallbackAssetId") && typeof current === "string" && missing.has(current)) {
      delete value[key];
    } else {
      removeMissingOptionalAssetReferences(current, missing);
    }
  }
}

function replaceMissingAssetPayloads(
  value: unknown,
  missing: ReadonlyMap<string, PortableAssetDependency>,
  messages: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => replaceMissingAssetPayloads(item, missing, messages));
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "image" && typeof value.assetId === "string" && missing.has(value.assetId)) {
    const dependency = missing.get(value.assetId)!;
    const label = dependency.name ?? dependency.assetId;
    for (const key of Object.keys(value)) delete value[key];
    value.type = "solid";
    value.color = "token:colors.surfaceAlt";
    messages.push(`Replaced unavailable image fill “${label}” with the target theme surface.`);
    return;
  }
  Object.values(value).forEach((item) => replaceMissingAssetPayloads(item, missing, messages));
}

function remintTextBlocks(slide: Slide, minted: Map<string, string>): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (value.version === 1 && Array.isArray(value.blocks)) {
      for (const block of value.blocks) {
        if (!isRecord(block) || typeof block.id !== "string") continue;
        const before = block.id;
        const after = newId("blk");
        block.id = after;
        minted.set(before, after);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(slide);
}

function rewriteExactString(value: unknown, before: string, after: string): unknown {
  if (typeof value === "string") return value === before ? after : value;
  if (Array.isArray(value)) {
    value.forEach((item, index) => { value[index] = rewriteExactString(item, before, after); });
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) value[key] = rewriteExactString(value[key], before, after);
  }
  return value;
}

function visitMutable(
  value: unknown,
  replace: (record: Record<string, unknown>, key: string, value: unknown) => unknown,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitMutable(item, replace));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    value[key] = replace(value, key, value[key]);
    visitMutable(value[key], replace);
  }
}

function isPortableAsset(value: unknown): value is PortableAssetDependency {
  return isRecord(value)
    && typeof value.assetId === "string"
    && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
