import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { SOUND_LIBRARY_NAMES, plainText, type PresentationDocument } from "@deckastra/presentation-schema";

import {
  BUNDLED_FONTS,
  SOUND_LIBRARY,
  applyScriptRules,
  buildDocumentScene,
  checkLayout,
  encodeWav,
  librarySoundSamples,
  librarySoundWav,
  resolveFontStack,
  slideDigest,
  scriptsIn,
  waveformPeaks,
} from "../src/index";
import { SlideView } from "../src/react/index";

/** The fixture shown in a language, the way an editor's lens or an export builds it. */
function shownIn(locale: string): PresentationDocument {
  const doc = structuredClone(loadFixture("multilingual"));
  const overlay = doc.locales![locale]!;
  const set = (path: string, value: unknown) => {
    const parts = path.slice(1).split("/");
    let cursor: Record<string, unknown> = doc as never;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (part.startsWith("id:")) {
        cursor = (cursor as unknown as { id: string }[]).find((item) => item.id === part.slice(3)) as never;
      } else {
        cursor = cursor[part] as never;
      }
    }
    const last = parts.at(-1)!;
    if (Array.isArray(cursor)) cursor[Number(last)] = value;
    else cursor[last] = value;
  };
  for (const [path, entry] of Object.entries(overlay.entries)) set(path, entry.value);
  doc.metadata.language = locale;
  return doc;
}

describe("a scene in another language", () => {
  it("leaves a Latin deck's scene exactly as it was", () => {
    const technical = loadFixture("technical");
    const scene = buildDocumentScene(technical);
    expect(scene.locale).toBe("en");
    expect(scene.direction).toBe("ltr");
    // Only the new fields are new: the per-slide digest is unchanged by them.
    expect(slideDigest(scene.slides[0]!)).toBe(slideDigest(buildDocumentScene(technical).slides[0]!));
  });

  it("adds the script's faces after the brand face and grows Indic line height", () => {
    const scene = buildDocumentScene(shownIn("hi-IN"));
    expect(scene.locale).toBe("hi-IN");
    const title = scene.slides[0]!.nodes[0]!;
    if (title.renderPayload.kind !== "text") throw new Error("expected text");
    const stack = title.renderPayload.typography.fontFamily;
    expect(stack).toContain("Noto Sans Devanagari Variable");
    expect(stack.indexOf("Noto Sans Devanagari Variable")).toBeGreaterThan(0);
    const english = buildDocumentScene(loadFixture("multilingual")).slides[0]!.nodes[0]!;
    if (english.renderPayload.kind !== "text") throw new Error("expected text");
    expect(title.renderPayload.typography.lineHeight).toBeGreaterThan(english.renderPayload.typography.lineHeight ?? 1.3);
  });

  it("runs Arabic right to left, in the markup and the alignment", () => {
    const doc = shownIn("ar");
    (doc.slides[0]!.elements[0] as { paragraph?: { align: string } }).paragraph = { align: "left" };
    const scene = buildDocumentScene(doc);
    expect(scene.direction).toBe("rtl");
    const title = scene.slides[0]!.nodes[0]!;
    if (title.renderPayload.kind !== "text") throw new Error("expected text");
    expect(title.renderPayload.direction).toBe("rtl");
    expect(title.renderPayload.align).toBe("right");
    const markup = renderToStaticMarkup(<SlideView scene={scene.slides[0]!} mode="export" />);
    expect(markup).toContain('dir="rtl"');
  });

  it("carries narration, sound cues, playback and the audio files for present mode", () => {
    const scene = buildDocumentScene(loadFixture("multilingual"));
    expect(scene.playback).toEqual({ mode: "narrated", gapMs: 400 });
    expect(scene.slides[1]!.narration?.cues).toHaveLength(4);
    expect(scene.slides[1]!.soundCues).toHaveLength(1);
    expect(Object.keys(scene.audio)).toHaveLength(8);
    expect(scene.slides[0]!.narration).toBeUndefined();
  });

  it("drops uppercase and synthetic italic where a script has neither", () => {
    const style = { fontFamily: "Inter", fontSize: 20, textTransform: "uppercase" as const, fontStyle: "italic" as const };
    expect(applyScriptRules(style, "devanagari")).toMatchObject({ textTransform: "none", fontStyle: "normal" });
    expect(applyScriptRules(style, undefined)).toBe(style);
  });
});

describe("glyph coverage (W325)", () => {
  it("names Hindi typed into a Latin-only font, and is quiet once the language is set", () => {
    const doc = structuredClone(loadFixture("multilingual"));
    const title = doc.slides[0]!.elements[0] as { content: unknown };
    title.content = plainText("नमस्ते", "blk_01JB8Z9K2QW4RN7F3XZZZZZZZZ");
    const english = checkLayout(buildDocumentScene(doc).slides[0]!);
    expect(english.find((issue) => issue.code === "W325")?.detail).toMatchObject({ kind: "glyphs", script: "devanagari" });
    doc.metadata.language = "hi";
    expect(checkLayout(buildDocumentScene(doc).slides[0]!).some((issue) => issue.code === "W325")).toBe(false);
  });

  it("finds the scripts in a string", () => {
    expect([...scriptsIn("Hello नमस्ते مرحبا 123")].sort()).toEqual(["arabic", "devanagari"]);
    expect(scriptsIn("Café — 100%").size).toBe(0);
  });

  it("puts every script face it ships into the per-script fallback", () => {
    for (const font of BUNDLED_FONTS.filter((one) => one.subsets?.length)) {
      expect(resolveFontStack(font.family)).toContain(font.face);
    }
    expect(resolveFontStack("Inter", "devanagari")).toMatch(/^Inter, "Inter Variable", "Noto Sans Devanagari Variable"/);
  });
});

describe("the sound library", () => {
  it("has a recipe for every name the schema lists", () => {
    expect(SOUND_LIBRARY.map((sound) => sound.name)).toEqual([...SOUND_LIBRARY_NAMES]);
    for (const name of SOUND_LIBRARY_NAMES) {
      const samples = librarySoundSamples(name)!;
      expect(samples.length, name).toBeGreaterThan(0);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      expect(peak, name).toBeGreaterThan(0.5);
      expect(peak, name).toBeLessThanOrEqual(0.9);
    }
  });

  it("is deterministic, so an exported deck's audio bytes are stable", () => {
    const a = librarySoundWav("applause")!;
    const b = librarySoundWav("applause")!;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(new TextDecoder().decode(a.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(a.slice(8, 12))).toBe("WAVE");
    expect(librarySoundWav("no-such-sound")).toBeUndefined();
  });

  it("encodes a WAV header that says how long it is, and draws peaks", () => {
    const wav = encodeWav(new Float32Array(22050), 22050);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(40, true)).toBe(44100);
    const peaks = waveformPeaks(librarySoundSamples("chime")!, 16);
    expect(peaks).toHaveLength(16);
    expect(peaks[0]).toBeGreaterThan(peaks.at(-1)!);
  });
});

describe("italic in scripts that have none", () => {
  it("draws a Hindi span upright however it was set, and keeps a Latin one slanted", async () => {
    const { buildDocumentScene } = await import("../src/scene");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SlideView } = await import("../src/react/SlideView");
    const { loadFixture } = await import("@deckastra/presentation-schema/fixtures");
    const document = loadFixture("multilingual");
    const title = document.slides[0]!.elements[0] as unknown as { content: { blocks: { id: string; type: string; spans: unknown[] }[] } };
    title.content.blocks = [
      { ...title.content.blocks[0]!, spans: [{ text: "एक डेक", italic: true }, { text: " Deckastra", italic: true }] },
      { id: "blk_01JB8Z9K2QW4RN7F3XQUOTE0001", type: "quote", spans: [{ text: "हर भाषा" }] },
    ];
    const scene = buildDocumentScene(document);
    const payload = scene.slides[0]!.nodes.find((node) => node.id === (document.slides[0]!.elements[0] as { id: string }).id)!.renderPayload as {
      blocks: { spans: { text: string; italic?: boolean }[]; upright?: true }[];
    };
    expect(payload.blocks[0]!.spans.map((span) => span.italic)).toEqual([undefined, true]);
    expect(payload.blocks[1]!.upright).toBe(true);
    const html = renderToStaticMarkup(<SlideView scene={scene.slides[0]!} mode="export" />);
    expect(html).toMatch(/<blockquote[^>]*font-style:normal/);
    // Exactly one slanted run on the slide: the Latin word.
    expect(html.match(/font-style:italic/g)).toHaveLength(1);
  });
});
