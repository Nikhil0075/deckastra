import { localeDirection, sameLanguage, sourceLocale, type PresentationDocument } from "@deckastra/presentation-schema";
import { localeProgress } from "@deckastra/presentation-core";

/**
 * The languages the editor offers by name (integration plan 01 §3.2).
 *
 * A table rather than `Intl.DisplayNames`: what the picker says must not depend
 * on the ICU a runtime was built with, the same reason number formatting is
 * hand-written in the renderer. Any other BCP-47 tag still works — it is shown
 * as the tag itself.
 */
export interface LanguageOption {
  tag: string;
  /** In English, for sorting and search. */
  name: string;
  /** In the language itself, so a speaker recognises it. */
  native: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { tag: "en", name: "English", native: "English" },
  { tag: "hi-IN", name: "Hindi", native: "हिन्दी" },
  { tag: "bn-IN", name: "Bengali", native: "বাংলা" },
  { tag: "mr-IN", name: "Marathi", native: "मराठी" },
  { tag: "ta-IN", name: "Tamil", native: "தமிழ்" },
  { tag: "te-IN", name: "Telugu", native: "తెలుగు" },
  { tag: "gu-IN", name: "Gujarati", native: "ગુજરાતી" },
  { tag: "kn-IN", name: "Kannada", native: "ಕನ್ನಡ" },
  { tag: "ml-IN", name: "Malayalam", native: "മലയാളം" },
  { tag: "pa-IN", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { tag: "or-IN", name: "Odia", native: "ଓଡ଼ିଆ" },
  { tag: "ur-IN", name: "Urdu", native: "اردو" },
  { tag: "ar", name: "Arabic", native: "العربية" },
  { tag: "he", name: "Hebrew", native: "עברית" },
  { tag: "fr", name: "French", native: "Français" },
  { tag: "de", name: "German", native: "Deutsch" },
  { tag: "es", name: "Spanish", native: "Español" },
  { tag: "pt-BR", name: "Portuguese (Brazil)", native: "Português" },
  { tag: "it", name: "Italian", native: "Italiano" },
  { tag: "nl", name: "Dutch", native: "Nederlands" },
  { tag: "ru", name: "Russian", native: "Русский" },
  { tag: "tr", name: "Turkish", native: "Türkçe" },
  { tag: "id", name: "Indonesian", native: "Bahasa Indonesia" },
  { tag: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { tag: "th", name: "Thai", native: "ไทย" },
  { tag: "ja", name: "Japanese", native: "日本語" },
  { tag: "ko", name: "Korean", native: "한국어" },
  { tag: "zh-CN", name: "Chinese (Simplified)", native: "简体中文" },
];

export function languageOption(tag: string): LanguageOption | undefined {
  return LANGUAGE_OPTIONS.find((option) => sameLanguage(option.tag, tag)) ?? LANGUAGE_OPTIONS.find((option) => sameLanguage(option.tag.split("-")[0]!, tag.split("-")[0]!));
}

/** "Hindi · हिन्दी", or the tag when this table does not know it. */
export function languageLabel(tag: string): string {
  const option = languageOption(tag);
  if (!option) return tag;
  return option.name === option.native ? option.name : `${option.name} · ${option.native}`;
}

/** The short form for a crowded bar: "EN", "HI", "AR". */
export function languageCode(tag: string): string {
  return tag.split("-")[0]!.toUpperCase();
}

export interface DeckLanguage {
  tag: string;
  source: boolean;
  label: string;
  direction: "ltr" | "rtl";
  /** 0..1 translated and current; 1 for the source. */
  done: number;
  translated: number;
  outdated: number;
  missing: number;
  total: number;
  status?: "draft" | "reviewed" | "partially reviewed";
}

/** The deck's own language first, then each overlay, with how far along it is. */
export function deckLanguages(document: PresentationDocument): DeckLanguage[] {
  const source = sourceLocale(document);
  const out: DeckLanguage[] = [
    { tag: source, source: true, label: languageLabel(source), direction: localeDirection(source), done: 1, translated: 0, outdated: 0, missing: 0, total: 0 },
  ];
  for (const [tag, overlay] of Object.entries(document.locales ?? {})) {
    if (sameLanguage(tag, source)) continue;
    const progress = localeProgress(document, tag);
    out.push({
      tag,
      source: false,
      label: languageLabel(tag),
      direction: overlay.direction ?? localeDirection(tag),
      done: progress.total ? progress.translated / progress.total : 1,
      translated: progress.translated,
      outdated: progress.outdated,
      missing: progress.missing,
      total: progress.total,
      status: Object.values(overlay.entries).some((entry) => entry.reviewStatus === "draft") && (overlay.status === "reviewed" || Object.values(overlay.entries).some((entry) => entry.reviewStatus === "reviewed")) ? "partially reviewed" : overlay.status,
    });
  }
  return out;
}
