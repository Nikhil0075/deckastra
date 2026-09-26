import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { expect, it } from "vitest";

import { buildDocumentScene, type TablePayload } from "../src/index";

/** A deck's tables follow the theme's table style unless a table says otherwise (2026-09-27). */

function tablePayload(mutate: (document: ReturnType<typeof loadFixture>) => void): TablePayload {
  const document = structuredClone(loadFixture("technical"));
  mutate(document);
  const node = buildDocumentScene(document)
    .slides.flatMap((slide) => slide.nodes)
    .find((candidate) => candidate.renderPayload.kind === "table")!;
  return node.renderPayload as TablePayload;
}

it("draws a table with no style of its own in the theme's table style", () => {
  const before = tablePayload(() => {});
  const themed = tablePayload((document) => {
    (document.theme as { table?: unknown }).table = {
      headerFill: { type: "solid", color: "#1E4BD2" },
      headerColor: "#FFFFFF",
      borders: "all",
      banding: "rows",
      fontSize: 24,
    };
    for (const slide of document.slides) for (const element of slide.elements) if (element.type === "table") delete (element as { tableStyle?: unknown }).tableStyle;
  });
  expect(themed.headerFill).toBe("#1E4BD2");
  expect(themed.headerTypography.color).toBe("#FFFFFF");
  expect(themed.borders).toBe("all");
  expect(themed.banding).toBe("rows");
  expect(themed.typography.fontSize).toBe(24);
  expect(before.headerTypography.color).not.toBe("#FFFFFF");
});

it("lets a table's own style win over the theme's", () => {
  const payload = tablePayload((document) => {
    (document.theme as { table?: unknown }).table = { headerColor: "#FFFFFF", borders: "all" };
    for (const slide of document.slides)
      for (const element of slide.elements)
        if (element.type === "table") (element as { tableStyle?: unknown }).tableStyle = { headerColor: "#111111", borders: "none" };
  });
  expect(payload.headerTypography.color).toBe("#111111");
  expect(payload.borders).toBe("none");
});
