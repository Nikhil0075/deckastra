import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { PresentationDocumentSchema, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { ThemeCustomise } from "../src/components/ThemeCustomise";
import {
  fontPairOperations,
  placeLogoOperations,
  placedLogo,
  removeLogoOperations,
  typeScaleOperations,
  writePath,
} from "../src/lib/theme-customise";
import type { EditorApi } from "../src/lib/useEditor";

/** Editing the whole design system (design review, 2026-09-27). */

afterEach(cleanup);

const technical = () => structuredClone(loadFixture("technical")) as PresentationDocument;

function run(document: PresentationDocument, operations: PatchOperation[]) {
  expect(operations.length).toBeGreaterThan(0);
  const result = applyPatch(document, operations);
  const parsed = PresentationDocumentSchema.safeParse(result.document);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([]);
  expect(applyPatch(result.document, result.inverse).document).toEqual(document);
  return result.document;
}

it("writes a path that does not exist yet as one add, and removes it again", () => {
  const document = technical();
  delete (document.theme as { table?: unknown }).table;
  const operations = writePath(document, "theme.table.headerColor", "#FFFFFF");
  expect(operations).toEqual([{ op: "add", path: "/theme/table", value: { headerColor: "#FFFFFF" } }]);
  const after = run(document, operations);
  expect(writePath(after, "theme.table.headerColor", undefined)).toEqual([{ op: "remove", path: "/theme/table/headerColor" }]);
  expect(writePath(after, "theme.table.headerColor", "#FFFFFF")).toEqual([]);
});

it("sets every size on a modular scale from one body size", () => {
  const document = technical();
  const after = run(document, typeScaleOperations(document, 20, 1.25));
  const typography = after.theme.typography as unknown as Record<string, { fontSize: number }> & { scaleRatio: number };
  expect(typography.scaleRatio).toBe(1.25);
  expect(typography.body.fontSize).toBe(20);
  expect(typography.h3.fontSize).toBe(25);
  expect(typography.h2.fontSize).toBe(31);
  expect(typography.h1.fontSize).toBe(39);
  expect(typography.caption.fontSize).toBe(13);
});

it("pairs a heading face with a body face across every text style", () => {
  const document = technical();
  const after = run(document, fontPairOperations(document, "Lora", "Inter"));
  const typography = after.theme.typography as unknown as Record<string, { fontFamily: string }>;
  expect([typography.h1.fontFamily, typography.display.fontFamily, typography.metric.fontFamily]).toEqual(["Lora", "Lora", "Lora"]);
  expect([typography.body.fontFamily, typography.caption.fontFamily]).toEqual(["Inter", "Inter"]);
  expect(typography.code.fontFamily).not.toBe("Lora");
});

it("puts a logo on every slide inside the safe area, moves it, and takes it away", () => {
  const document = technical();
  const image = document.assets.find((asset) => asset.type === "image")!;
  const placed = run(document, placeLogoOperations(document, image.id, "bottomRight", 48));
  expect(placedLogo(placed)?.count).toBe(document.slides.length);
  const logo = placed.slides[0]!.elements.at(-1)!;
  const safe = document.viewport.safeArea!;
  expect(logo.transform.y + logo.transform.height).toBe(document.viewport.height - safe.bottom);
  expect(logo.transform.x + logo.transform.width).toBe(document.viewport.width - safe.right);
  expect(logo).toMatchObject({ type: "image", semanticRole: "logo", locked: true });

  const moved = run(placed, placeLogoOperations(placed, image.id, "topLeft", 48));
  expect(placedLogo(moved)?.count).toBe(document.slides.length);
  expect(moved.slides[0]!.elements.at(-1)!.transform).toMatchObject({ x: safe.left, y: safe.top });

  const removed = run(moved, removeLogoOperations(moved));
  expect(placedLogo(removed)).toBeUndefined();
});

it("edits a table heading from the Customise view and says whether its text can be read", () => {
  let document = technical();
  const editor = {
    get document() {
      return document;
    },
    slideIndex: 0,
    apply: (operations: PatchOperation[]) => {
      document = applyPatch(document, operations).document;
    },
  } as unknown as EditorApi;
  const view = render(<ThemeCustomise editor={editor} />, { wrapper: withWorkspaceClient() });
  fireEvent.click(screen.getByRole("button", { name: /^Heading row:/ }));
  fireEvent.click(screen.getAllByRole("option").find((option) => option.getAttribute("aria-label") !== "None")!);
  expect((document.theme as { table?: { headerFill?: unknown } }).table?.headerFill).toBeTruthy();
  view.rerender(<ThemeCustomise editor={editor} />);
  expect(screen.getByTestId("theme-table-contrast").textContent).toMatch(/:1 on its row/);
});

it("gives a theme with no chart settings its series along with the first chart change", () => {
  let document = technical();
  delete (document.theme as { chart?: unknown }).chart;
  const editor = {
    get document() {
      return document;
    },
    slideIndex: 0,
    apply: (operations: PatchOperation[]) => {
      document = run(document, operations);
    },
  } as unknown as EditorApi;
  render(<ThemeCustomise editor={editor} />, { wrapper: withWorkspaceClient() });
  fireEvent.click(screen.getByRole("checkbox", { name: "Show gridlines" }));
  expect(document.theme.chart).toMatchObject({ showGridlines: false, series: document.theme.colors.chartSeries });
});
