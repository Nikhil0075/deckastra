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
