import {
  PATTERN_DEFINITIONS,
  MOTION_STYLES,
  PURPOSE_GROUPS,
  SLIDE_PATTERNS,
  type DeckPreset,
  type MetricSlotValue,
  type SlotDefinition,
  type SlotValue,
} from "./schema";
import { isDesignLanguage } from "./languages";

export type PresetIssueCode =
  | "E_PRESET_ID_DUPLICATE"
  | "E_PRESET_PURPOSE"
  | "E_PRESET_LANGUAGE"
  | "E_PRESET_THEME"
  | "E_PRESET_MOTION"
  | "E_PRESET_SLIDES"
  | "E_SLIDE_KEY_DUPLICATE"
  | "E_SLIDE_PATTERN"
  | "E_SLOT_UNKNOWN"
  | "E_SLOT_REQUIRED"
  | "E_SLOT_TYPE"
  | "E_SLOT_COUNT"
  | "E_SLOT_EMPTY";

export interface PresetIssue {
  code: PresetIssueCode;
  path: string;
  message: string;
}

const hasText = (value: SlotValue | undefined): boolean => {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0;
};

function valueMatches(definition: SlotDefinition, value: unknown): boolean {
  if (definition.kind === "text") return typeof value === "string";
  if (!Array.isArray(value)) return false;
  if (definition.kind === "text-list") return value.every((item) => typeof item === "string");
  return value.every(
    (item): item is MetricSlotValue =>
      typeof item === "object" && item !== null &&
      typeof (item as MetricSlotValue).value === "string" &&
      typeof (item as MetricSlotValue).label === "string",
  );
}

/** Validate the data contract without importing a renderer or a model runtime. */
export function validateDeckPresets(
  presets: readonly DeckPreset[],
  options: { themeKeys: ReadonlySet<string> },
): PresetIssue[] {
  const issues: PresetIssue[] = [];
  const presetIds = new Set<string>();

  for (const [presetIndex, preset] of presets.entries()) {
    const base = `presets/${presetIndex}`;
    if (presetIds.has(preset.id)) {
      issues.push({ code: "E_PRESET_ID_DUPLICATE", path: `${base}/id`, message: `Duplicate preset id ${JSON.stringify(preset.id)}.` });
    }
    presetIds.add(preset.id);
    if (!(PURPOSE_GROUPS as readonly string[]).includes(preset.purpose)) {
      issues.push({ code: "E_PRESET_PURPOSE", path: `${base}/purpose`, message: `Unknown purpose ${JSON.stringify(preset.purpose)}.` });
    }
    if (!isDesignLanguage(preset.designLanguage)) {
      issues.push({ code: "E_PRESET_LANGUAGE", path: `${base}/designLanguage`, message: `Unknown design language ${JSON.stringify(preset.designLanguage)}.` });
    }
    if (!options.themeKeys.has(preset.themeKey)) {
      issues.push({ code: "E_PRESET_THEME", path: `${base}/themeKey`, message: `Unknown theme ${JSON.stringify(preset.themeKey)}.` });
    }
    if (!(preset.motionStyle in MOTION_STYLES)) {
      issues.push({ code: "E_PRESET_MOTION", path: `${base}/motionStyle`, message: `Unknown motion style ${JSON.stringify(preset.motionStyle)}.` });
    }
    if (preset.slides.length === 0) {
      issues.push({ code: "E_PRESET_SLIDES", path: `${base}/slides`, message: "A preset must contain at least one slide." });
    }

    const slideKeys = new Set<string>();
    for (const [slideIndex, slide] of preset.slides.entries()) {
      const slidePath = `${base}/slides/${slideIndex}`;
      if (slideKeys.has(slide.key)) {
        issues.push({ code: "E_SLIDE_KEY_DUPLICATE", path: `${slidePath}/key`, message: `Duplicate slide key ${JSON.stringify(slide.key)}.` });
      }
      slideKeys.add(slide.key);

      if (!(SLIDE_PATTERNS as readonly string[]).includes(slide.pattern)) {
        issues.push({ code: "E_SLIDE_PATTERN", path: `${slidePath}/pattern`, message: `Unknown pattern ${JSON.stringify(slide.pattern)}.` });
        continue;
      }
      const pattern = PATTERN_DEFINITIONS[slide.pattern];
      for (const slotName of Object.keys(slide.slots)) {
        if (!(slotName in pattern.slots)) {
          issues.push({ code: "E_SLOT_UNKNOWN", path: `${slidePath}/slots/${slotName}`, message: `Pattern ${slide.pattern} has no slot named ${JSON.stringify(slotName)}.` });
        }
      }
      for (const [slotName, definition] of Object.entries(pattern.slots)) {
        const value = slide.slots[slotName];
        const slotPath = `${slidePath}/slots/${slotName}`;
        if (definition.required && !hasText(value)) {
          issues.push({ code: "E_SLOT_REQUIRED", path: slotPath, message: `Required slot ${JSON.stringify(slotName)} is empty or missing.` });
          continue;
        }
        if (value === undefined) continue;
        if (!valueMatches(definition, value)) {
          issues.push({ code: "E_SLOT_TYPE", path: slotPath, message: `Slot ${JSON.stringify(slotName)} must contain ${definition.kind}.` });
          continue;
        }
        if (typeof value === "string" && value.trim().length === 0) {
          issues.push({ code: "E_SLOT_EMPTY", path: slotPath, message: `Slot ${JSON.stringify(slotName)} cannot be blank.` });
        }
        if (Array.isArray(value)) {
          if (definition.minItems !== undefined && value.length < definition.minItems) {
            issues.push({ code: "E_SLOT_COUNT", path: slotPath, message: `Slot ${JSON.stringify(slotName)} needs at least ${definition.minItems} items.` });
          }
          if (definition.maxItems !== undefined && value.length > definition.maxItems) {
            issues.push({ code: "E_SLOT_COUNT", path: slotPath, message: `Slot ${JSON.stringify(slotName)} accepts at most ${definition.maxItems} items.` });
          }
          const blankIndex = value.findIndex((item) =>
            typeof item === "string" ? item.trim().length === 0 :
              typeof item === "object" && item !== null &&
              (!(item as MetricSlotValue).value.trim() || !(item as MetricSlotValue).label.trim()),
          );
          if (blankIndex >= 0) {
            issues.push({ code: "E_SLOT_EMPTY", path: `${slotPath}/${blankIndex}`, message: `Slot ${JSON.stringify(slotName)} contains a blank item.` });
          }
        }
      }
      for (const group of pattern.requiresOneOf ?? []) {
        if (!group.some((slotName) => hasText(slide.slots[slotName]))) {
          issues.push({ code: "E_SLOT_REQUIRED", path: `${slidePath}/slots`, message: `Pattern ${slide.pattern} requires one of: ${group.join(", ")}.` });
        }
      }
    }
  }
  return issues;
}

const clone = (presets: readonly DeckPreset[]): DeckPreset[] => structuredClone([...presets]);

/** Negative controls prove every validator family can actually make the gate fail. */
export function runNegativeControls(
  presets: readonly DeckPreset[],
  themeKeys: ReadonlySet<string>,
): Array<{ name: string; expected: PresetIssueCode; actual: PresetIssueCode[] }> {
  const controls: Array<{ name: string; expected: PresetIssueCode; break: (copy: DeckPreset[]) => void }> = [
    { name: "duplicate preset id", expected: "E_PRESET_ID_DUPLICATE", break: (copy) => { copy[1]!.id = copy[0]!.id; } },
    { name: "unknown purpose", expected: "E_PRESET_PURPOSE", break: (copy) => { copy[0]!.purpose = "unknown" as DeckPreset["purpose"]; } },
    { name: "unknown theme", expected: "E_PRESET_THEME", break: (copy) => { copy[0]!.themeKey = "missing-theme"; } },
    { name: "unknown motion style", expected: "E_PRESET_MOTION", break: (copy) => { copy[0]!.motionStyle = "missing-motion" as DeckPreset["motionStyle"]; } },
    { name: "empty slide list", expected: "E_PRESET_SLIDES", break: (copy) => { copy[0]!.slides = []; } },
    { name: "duplicate slide key", expected: "E_SLIDE_KEY_DUPLICATE", break: (copy) => { copy[0]!.slides[1]!.key = copy[0]!.slides[0]!.key; } },
    { name: "unknown pattern", expected: "E_SLIDE_PATTERN", break: (copy) => { copy[0]!.slides[0]!.pattern = "unknown" as DeckPreset["slides"][number]["pattern"]; } },
    { name: "unknown slot", expected: "E_SLOT_UNKNOWN", break: (copy) => { copy[0]!.slides[0]!.slots.geometry = "forbidden"; } },
    { name: "missing required slot", expected: "E_SLOT_REQUIRED", break: (copy) => { delete copy[0]!.slides[0]!.slots.headline; } },
    { name: "wrong slot type", expected: "E_SLOT_TYPE", break: (copy) => { copy[0]!.slides[0]!.slots.headline = ["not", "text"]; } },
    { name: "too many items", expected: "E_SLOT_COUNT", break: (copy) => { copy[0]!.slides[2]!.slots.bullets = ["1", "2", "3", "4", "5", "6", "7"]; } },
    { name: "blank content", expected: "E_SLOT_EMPTY", break: (copy) => { copy[0]!.slides[0]!.slots.eyebrow = "   "; } },
  ];

  return controls.map((control) => {
    const copy = clone(presets);
    control.break(copy);
    return { name: control.name, expected: control.expected, actual: validateDeckPresets(copy, { themeKeys }).map((issue) => issue.code) };
  });
}

export interface ContactTheme {
  key: string;
  name: string;
  colors: Record<string, string | undefined>;
}

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function slotText(value: SlotValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function slideMarkup(pattern: keyof typeof PATTERN_DEFINITIONS): string {
  const definition = PATTERN_DEFINITIONS[pattern];
  const slots = definition.exampleSlots;
  const layout = definition.composerLayout;
  const eyebrow = slotText(slots.eyebrow);
  const headline = slotText(slots.headline);
  let body = "";
  if (layout === "bullets" || layout === "split") {
    body = `<ul>${((slots.bullets as string[] | undefined) ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  } else if (layout === "metrics") {
    body = `<div class="metrics">${((slots.metrics as MetricSlotValue[] | undefined) ?? []).map((item) => `<div><b>${escapeHtml(item.value)}</b><span>${escapeHtml(item.label)}</span></div>`).join("")}</div>`;
  } else if (layout === "quote") {
    body = `<blockquote>“${escapeHtml(slots.quote)}”</blockquote><p class="attribution">— ${escapeHtml(slots.attribution)}</p>`;
  } else if (layout === "code") {
    body = `<pre><code>${escapeHtml(slots.code)}</code></pre><p class="caption">${escapeHtml(slots.caption)}</p>`;
  } else {
    body = `<p class="body">${escapeHtml(slots.subtitle ?? slots.body ?? "")}</p>`;
  }
  const splitBody = layout === "split" ? `<p class="body">${escapeHtml(slots.body)}</p>${body}` : body;
  return `<div class="slide pattern-${layout} semantic-${pattern}"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(headline)}</h2><div class="content">${splitBody}</div></div>`;
}

/** A deterministic, dependency-free review page: every pattern in three themes. */
export function renderContactSheet(themes: readonly ContactTheme[]): string {
  const figures: string[] = [];
  for (const theme of themes) {
    const background = theme.colors.background ?? "#ffffff";
    const foreground = theme.colors.foreground ?? "#111827";
    const accent = theme.colors.accent ?? "#2563eb";
    const surface = theme.colors.surface ?? background;
    const border = theme.colors.border ?? foreground;
    for (const pattern of SLIDE_PATTERNS) {
      figures.push(`<figure data-theme="${escapeHtml(theme.key)}" data-pattern="${pattern}" style="--bg:${escapeHtml(background)};--fg:${escapeHtml(foreground)};--accent:${escapeHtml(accent)};--surface:${escapeHtml(surface)};--border:${escapeHtml(border)}"><figcaption>${escapeHtml(theme.name)} · ${escapeHtml(PATTERN_DEFINITIONS[pattern].name)}</figcaption>${slideMarkup(pattern)}</figure>`);
    }
  }
  return `<!doctype html>\n<meta charset="utf-8">\n<title>Deckastra preset contact sheet</title>\n<style>
*{box-sizing:border-box}body{margin:0;background:#0b0f14;color:#e5e7eb;font:14px Inter,system-ui,sans-serif}header{padding:28px 32px 12px}header h1{margin:0 0 8px;font-size:26px}header p{margin:0;color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:22px;padding:24px 32px 40px}figure{margin:0}figcaption{padding:0 0 7px;color:#9ca3af;font-size:12px;font-weight:700}.slide{container-type:inline-size;aspect-ratio:16/9;overflow:hidden;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);padding:6% 7.5%;box-shadow:0 14px 30px #0006}.eyebrow{min-height:1em;margin:0 0 3%;color:var(--accent);font-size:clamp(9px,2.5cqw,12px);font-weight:800;letter-spacing:.14em}.slide h2{margin:0;max-width:94%;font-size:clamp(21px,7cqw,34px);line-height:1.05}.content{margin-top:5%;font-size:clamp(11px,3.3cqw,16px);line-height:1.4}.body{max-width:76%;color:color-mix(in srgb,var(--fg) 76%,var(--bg))}.pattern-title{display:flex;flex-direction:column;justify-content:center}.pattern-title h2{font-size:clamp(27px,9cqw,46px)}.pattern-statement{text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center}.pattern-statement .body{max-width:80%}ul{margin:0;padding-left:1.2em;display:grid;gap:.4em}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:3%}.metrics div{padding:9%;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.metrics b{display:block;color:var(--accent);font-size:clamp(21px,7.5cqw,38px)}.metrics span{display:block;margin-top:6px;font-size:.8em}.pattern-quote{text-align:center}.pattern-quote blockquote{margin:3% auto 0;max-width:86%;font:600 clamp(17px,5.7cqw,28px)/1.25 Georgia,serif}.attribution,.caption{color:color-mix(in srgb,var(--fg) 68%,var(--bg));font-size:.78em}.pattern-code pre{margin:0;padding:3.5%;border:1px solid var(--border);border-radius:8px;background:var(--surface);white-space:pre-wrap}.pattern-split .content{display:grid;grid-template-columns:1fr 1fr;gap:8%}.pattern-split .body{max-width:none;margin-top:0}@media(max-width:520px){.grid{grid-template-columns:1fr;padding:16px}.slide{padding:7%}}
</style>\n<header><h1>Deckastra preset contact sheet</h1><p>${SLIDE_PATTERNS.length} patterns × ${themes.length} themes · generated; review before marking presets reviewed.</p></header>\n<main class="grid">${figures.join("\n")}</main>\n`;
}
