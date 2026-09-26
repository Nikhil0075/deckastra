import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { BrandIconSchema, PresentationDocumentSchema, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { ICON_CATEGORIES, ICON_NAMES, buildDocumentScene, findIcon } from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";

import { AddLibrary, type LibraryItem } from "../src/components/shell/AddLibrary";
import { addBrandIconOperations, brandIconName, parseSvgIcon } from "../src/lib/svg-icon";

/** The larger icon library and the brand's own icons (design review, 2026-09-27). */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("has two hundred icons, each filed in a category", () => {
  expect(ICON_NAMES.length).toBeGreaterThanOrEqual(200);
  for (const name of ICON_NAMES) expect(ICON_CATEGORIES).toContain(findIcon(name)!.category);
  // The curated drawing wins over Lucide's for a shared name.
  expect(findIcon("database")!.paths[0]).toMatch(/^M4 6c0-1.7/);
  expect(findIcon("flask-conical")?.category).toBe("Science");
});

it("keeps only the geometry of an SVG, centred on a square grid", () => {
  const result = parseSvgIcon(`<?xml version="1.0"?>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" onload="alert(1)">
      <title>Logo</title>
      <style>.a{fill:red}</style>
      <path d="M0 0H40V20Z" fill="#123456" onclick="steal()"/>
      <circle cx="10" cy="10" r="4"/>
      <rect x="20" y="5" width="10" height="10" rx="2"/>
      <a href="https://example.com"><path d="M1 1L2 2"/></a>
    </svg>`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(BrandIconSchema.safeParse(result.icon).success).toBe(true);
  expect(result.icon.viewBox).toBe(40);
  expect(result.icon.fill).toBe(true);
  expect(result.icon.paths).toHaveLength(2);
  // Moved down 10 to centre a 40 × 20 drawing on a 40 × 40 grid.
  expect(result.icon.paths[0]!.replace(/\s+/g, " ").replace(/ ?([A-Za-z]) ?/g, "$1")).toBe("M0 10H40V30Z");
  expect(result.icon.circles).toEqual([[10, 20, 4]]);
  expect(JSON.stringify(result.icon)).not.toMatch(/alert|steal|example|red|style/);
});

it("refuses what it cannot draw faithfully, and says why", () => {
  const cases: [string, RegExp][] = [
    [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="rotate(45)"><path d="M0 0L1 1"/></g></svg>`, /transforms/],
    [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image href="x.png"/></svg>`, /picture/],
    [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>Hi</text></svg>`, /text/],
    [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>1</script></svg>`, /script/],
    [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>`, /no shapes/],
    [`<html><body/></html>`, /not an SVG|not a readable/],
    [`<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>`, /document type/],
  ];
  for (const [svg, reason] of cases) {
    const result = parseSvgIcon(svg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  }
});

function withBrandIcon(): { document: PresentationDocument; name: string } {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const parsed = parseSvgIcon(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2H22V22H2Z"/></svg>`);
  if (!parsed.ok) throw new Error(parsed.reason);
  const name = brandIconName(document, "Acme mark.svg");
  return { document: applyPatch(document, addBrandIconOperations(document, name, parsed.icon)).document, name };
}

it("keeps a brand icon with the theme and draws it filled on a slide", () => {
  const { document, name } = withBrandIcon();
  expect(name).toBe("Acme mark");
  expect(PresentationDocumentSchema.safeParse(document).success).toBe(true);
  (document.slides[0]!.elements as unknown[]).push({
    id: "el_01JBRANDBRANDBRANDBRANDBRA",
    type: "icon",
    icon: { set: "brand", name },
    transform: { x: 100, y: 100, width: 96, height: 96 },
  });
  const node = buildDocumentScene(document).slides[0]!.nodes.find((n) => n.id === "el_01JBRANDBRANDBRANDBRANDBRA")!;
  expect(node.renderPayload).toMatchObject({ kind: "icon", fill: true, viewBox: 24, paths: ["M2 2H22V22H2Z"] });
  expect((node.renderPayload as { missing?: string }).missing).toBeUndefined();
});

it("lists brand icons in the library, adds one, and uploads another from a file", async () => {
  const { document: start, name } = withBrandIcon();
  let document = start;
  const added: LibraryItem[] = [];
  const apply = (operations: PatchOperation[]) => {
    document = applyPatch(document, operations).document;
  };
  const view = render(<AddLibrary tab="brand" onTab={() => {}} onClose={() => {}} onAdd={(item) => added.push(item)} onAddImage={() => {}} document={document} apply={apply} />);
  fireEvent.click(within(screen.getByTestId("library-brand")).getByRole("button", { name: `Add ${name.toLowerCase()}` }));
  expect(added).toEqual([{ kind: "icon", name, set: "brand" }]);

  const file = new File([`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>`], "Dot.svg", { type: "image/svg+xml" });
  fireEvent.change(screen.getByLabelText("SVG icon file"), { target: { files: [file] } });
  await waitFor(() => expect(Object.keys(document.theme.icons ?? {})).toContain("Dot"));

  view.rerender(<AddLibrary tab="brand" onTab={() => {}} onClose={() => {}} onAdd={() => {}} onAddImage={() => {}} document={document} apply={apply} />);
  const bad = new File([`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>x</text></svg>`], "Bad.svg", { type: "image/svg+xml" });
  fireEvent.change(screen.getByLabelText("SVG icon file"), { target: { files: [bad] } });
  await waitFor(() => expect(screen.getByTestId("library-svg-problem").textContent).toMatch(/text/));
});

it("files icons by category and says what an object becomes in PowerPoint", () => {
  render(<AddLibrary tab="icons" onTab={() => {}} onClose={() => {}} onAdd={() => {}} onAddImage={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Healthcare" }));
  const shown = within(screen.getByTestId("library-icons")).getAllByRole("button", { name: /^Add (?!.*favourites)/ });
  expect(shown.length).toBeGreaterThan(8);
  expect(shown.map((button) => button.getAttribute("aria-label"))).toContain("Add stethoscope");
  cleanup();
  render(<AddLibrary tab="shapes" onTab={() => {}} onClose={() => {}} onAdd={() => {}} onAddImage={() => {}} />);
  expect(screen.getByTitle(/In PowerPoint: Becomes a picture of the formula/)).toBeTruthy();
});
