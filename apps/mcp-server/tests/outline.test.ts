import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { outlineDocument } from "../src/outline";

/** An agent reading a deck learns its object styles, as it does its named colours. */
it("lists object styles with how many objects follow each", () => {
  const document = structuredClone(loadFixture("technical"));
  document.theme.objectStyles = { Card: { style: { cornerRadius: 12 } }, Caption: { typography: { fontSize: 18 } } };
  const first = document.slides[0]!.elements[0]!;
  first.styleRef = "Card";
  const outline = outlineDocument(document, { presentationId: document.id, versionId: "ver_01JB8Z9K2QW4RN7F3X00000001" });
  expect(outline.objectStyles).toEqual({ Card: 1, Caption: 0 });
});

/** Integration plan 01 §3.11: an agent sees a deck's languages and narration before it touches them. */
it("lists the deck's languages with counts, and each slide's narration by step", () => {
  const document = structuredClone(loadFixture("multilingual"));
  const outline = outlineDocument(document, { presentationId: document.id, versionId: "ver_01JB8Z9K2QW4RN7F3X00000001" });
  expect(outline.playback).toBe("narrated");
  const languages = outline.languages!;
  expect(languages[0]).toMatchObject({ locale: "en", source: true });
  const hindi = languages.find((language) => language.locale === "hi-IN")!;
  expect(hindi.outdated).toBe(0);
  expect(hindi.missing).toBeGreaterThan(0);
  expect(hindi.translated).toBeGreaterThan(10);
  const narration = outline.slides[1]!.narration!;
  expect(narration.map((cue) => cue.step)).toEqual([0, 1, 2, 3]);
  expect(narration[0]!.recordedIn.sort()).toEqual(["en", "hi-IN"]);
  expect(outline.slides[1]!.soundCount).toBe(1);
});

it("says nothing about languages for a deck that has none", () => {
  const document = loadFixture("technical");
  expect(outlineDocument(document, { presentationId: document.id, versionId: "v" }).languages).toBeUndefined();
});
