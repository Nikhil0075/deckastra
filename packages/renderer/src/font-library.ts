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

export type FontGroup = "Sans" | "Serif" | "Display" | "Mono" | "Handwriting";

export interface BundledFont {
  /** The name a deck uses. */
  family: string;
  /** The name the bundled stylesheet registers. */
  face: string;
  group: FontGroup;
  /** The package stylesheet, relative to `node_modules`. */
  css: string;
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
];

/** Common system families, offered after the bundled ones and marked as depending on the machine. */
export const SYSTEM_FONTS: readonly string[] = ["Arial", "Helvetica", "Georgia", "Times New Roman", "Verdana", "Courier New"];

export function bundledFont(family: string): BundledFont | undefined {
  const wanted = family.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return BUNDLED_FONTS.find((font) => font.family.toLowerCase() === wanted || font.face.toLowerCase() === wanted);
}
