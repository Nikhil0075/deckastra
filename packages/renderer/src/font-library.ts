/**
 * The fonts this product ships (Design tab review, 2026-09-26).
 *
 * One list, read by the editor (which imports each stylesheet so the faces are
 * there while editing and presenting), by the font picker (which offers them),
 * and by the exporter (which hands the same files to its render page as
 * `data:` URLs, because the render host has no network and none of these is
 * installed on a user's machine). All are SIL Open Font License 1.1.
 *
 * `css` is a path under `node_modules`: the package's own `@font-face`
 * stylesheet, with its unicode ranges and weight axis exactly as the foundry
 * published them. Only the Latin and Latin Extended files are kept for export.
 */

export type FontGroup = "Sans" | "Serif" | "Display" | "Mono" | "Handwriting" | "World scripts";

export interface BundledFont {
  /** The name a deck uses. */
  family: string;
  /** The name the bundled stylesheet registers. */
  face: string;
  group: FontGroup;
  /** The package stylesheet, relative to `node_modules`. */
  css: string;
  /**
   * Subsets beyond Latin that an export embeds, named as Fontsource names them
   * in its stylesheet comments ("devanagari", "arabic"). A face drawn for a
   * script is the point of shipping it, so a PDF of a Hindi deck must carry the
   * Devanagari file and not only the Latin one (integration plan 01 §3.9).
   */
  subsets?: readonly string[];
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: "Inter", face: "Inter Variable", group: "Sans", css: "@fontsource-variable/inter/wght.css" },
  { family: "Manrope", face: "Manrope Variable", group: "Sans", css: "@fontsource-variable/manrope/wght.css" },
  { family: "DM Sans", face: "DM Sans Variable", group: "Sans", css: "@fontsource-variable/dm-sans/wght.css" },
  { family: "Work Sans", face: "Work Sans Variable", group: "Sans", css: "@fontsource-variable/work-sans/wght.css" },
  { family: "Nunito", face: "Nunito Variable", group: "Sans", css: "@fontsource-variable/nunito/wght.css" },
  { family: "Playfair Display", face: "Playfair Display Variable", group: "Serif", css: "@fontsource-variable/playfair-display/wght.css" },
  { family: "Lora", face: "Lora Variable", group: "Serif", css: "@fontsource-variable/lora/wght.css" },
  { family: "Source Serif 4", face: "Source Serif 4 Variable", group: "Serif", css: "@fontsource-variable/source-serif-4/wght.css" },
  { family: "Fraunces", face: "Fraunces Variable", group: "Serif", css: "@fontsource-variable/fraunces/wght.css" },
  { family: "Jost", face: "Jost Variable", group: "Display", css: "@fontsource-variable/jost/wght.css" },
  { family: "Space Grotesk", face: "Space Grotesk Variable", group: "Display", css: "@fontsource-variable/space-grotesk/wght.css" },
  { family: "Bebas Neue", face: "Bebas Neue", group: "Display", css: "@fontsource/bebas-neue/index.css" },
  { family: "Archivo Black", face: "Archivo Black", group: "Display", css: "@fontsource/archivo-black/index.css" },
  { family: "JetBrains Mono", face: "JetBrains Mono Variable", group: "Mono", css: "@fontsource-variable/jetbrains-mono/wght.css" },
  { family: "IBM Plex Mono", face: "IBM Plex Mono", group: "Mono", css: "@fontsource/ibm-plex-mono/index.css" },
  { family: "Caveat", face: "Caveat Variable", group: "Handwriting", css: "@fontsource-variable/caveat/wght.css" },
  // World scripts (integration plan 01 §3.9). Noto covers each script with
  // metrics designed to sit beside Latin faces; Mukta, Hind and Baloo 2 are the
  // Devanagari display and text faces Indian decks are commonly set in. CJK is
  // not here on purpose: those faces are tens of megabytes and arrive as
  // language packs rather than in every installer.
  { family: "Noto Sans Devanagari", face: "Noto Sans Devanagari Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-devanagari/wght.css", subsets: ["devanagari"] },
  { family: "Noto Serif Devanagari", face: "Noto Serif Devanagari Variable", group: "World scripts", css: "@fontsource-variable/noto-serif-devanagari/wght.css", subsets: ["devanagari"] },
  { family: "Mukta", face: "Mukta", group: "World scripts", css: "@fontsource/mukta/index.css", subsets: ["devanagari"] },
  { family: "Hind", face: "Hind", group: "World scripts", css: "@fontsource/hind/index.css", subsets: ["devanagari"] },
  { family: "Baloo 2", face: "Baloo 2 Variable", group: "World scripts", css: "@fontsource-variable/baloo-2/wght.css", subsets: ["devanagari"] },
  { family: "Noto Sans Bengali", face: "Noto Sans Bengali Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-bengali/wght.css", subsets: ["bengali"] },
  { family: "Noto Sans Tamil", face: "Noto Sans Tamil Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-tamil/wght.css", subsets: ["tamil"] },
  { family: "Noto Sans Telugu", face: "Noto Sans Telugu Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-telugu/wght.css", subsets: ["telugu"] },
  { family: "Noto Sans Kannada", face: "Noto Sans Kannada Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-kannada/wght.css", subsets: ["kannada"] },
  { family: "Noto Sans Malayalam", face: "Noto Sans Malayalam Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-malayalam/wght.css", subsets: ["malayalam"] },
  { family: "Noto Sans Gujarati", face: "Noto Sans Gujarati Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-gujarati/wght.css", subsets: ["gujarati"] },
  { family: "Noto Sans Gurmukhi", face: "Noto Sans Gurmukhi Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-gurmukhi/wght.css", subsets: ["gurmukhi"] },
  { family: "Noto Sans Oriya", face: "Noto Sans Oriya Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-oriya/wght.css", subsets: ["oriya"] },
  { family: "Noto Sans Arabic", face: "Noto Sans Arabic Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-arabic/wght.css", subsets: ["arabic"] },
  { family: "Noto Naskh Arabic", face: "Noto Naskh Arabic Variable", group: "World scripts", css: "@fontsource-variable/noto-naskh-arabic/wght.css", subsets: ["arabic"] },
  { family: "Noto Sans Hebrew", face: "Noto Sans Hebrew Variable", group: "World scripts", css: "@fontsource-variable/noto-sans-hebrew/wght.css", subsets: ["hebrew"] },
];

/** Common system families, offered after the bundled ones and marked as depending on the machine. */
export const SYSTEM_FONTS: readonly string[] = ["Arial", "Helvetica", "Georgia", "Times New Roman", "Verdana", "Courier New"];

export function bundledFont(family: string): BundledFont | undefined {
  const wanted = family.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return BUNDLED_FONTS.find((font) => font.family.toLowerCase() === wanted || font.face.toLowerCase() === wanted);
}
