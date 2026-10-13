/**
 * Picture treatments in the editor (image-led visual systems, item 4,
 * 2026-10-13).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { applyPatch } from "@deckastra/transactions";
import { validateDocument, type ImageElement, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { WorkspaceClientProvider } from "@deckastra/workspace-client/react";
import { testWorkspaceClient } from "@deckastra/workspace-client/testing";

import {
  treatmentExportNote,
  treatmentOperations,
  treatmentPreset,
  treatmentPresets,
  treatmentWith,
} from "../src/lib/image-treatment";
import { addNamedColorOperations, deleteNamedColorOperations, renameNamedColorOperations } from "../src/lib/colors";
import { ImageSection } from "../src/components/inspector/ImageSection";

afterEach(cleanup);

function withImage(treatment?: ImageElement["treatment"]): { document: PresentationDocument; image: ImageElement } {
  const document = structuredClone(loadFixture("technical"));
  for (const slide of document.slides) {
    const image = slide.elements.find((element) => element.type === "image") as ImageElement | undefined;
    if (image) {
      if (treatment) image.treatment = treatment;
      return { document, image };
    }
  }
  throw new Error("the technical fixture has no image");
}

const imageIn = (document: PresentationDocument, id: string) =>
  document.slides.flatMap((slide) => slide.elements).find((element) => element.id === id) as ImageElement;

describe("treatments", () => {
  it("writes every preset as a valid document and recognises it again", () => {
    for (const preset of treatmentPresets(withImage().document)) {
      const { document, image } = withImage();
      const after = applyPatch(document, treatmentOperations(document, image.id, preset.treatment)).document;
      expect(validateDocument(after).errors, preset.value).toEqual([]);
      expect(treatmentPreset(after, imageIn(after, image.id)), preset.value).toBe(preset.value);
    }
  });

  it("drops zeros, and removes a treatment that no longer changes anything", () => {
    expect(treatmentWith({ contrast: 0.2, grain: 0.1 }, { grain: 0 })).toEqual({ contrast: 0.2 });
    expect(treatmentWith({ contrast: 0.2 }, { contrast: 0 })).toBeUndefined();
    const { document, image } = withImage({ contrast: 0.2 });
    const after = applyPatch(document, treatmentOperations(document, image.id, treatmentWith(image.treatment, { contrast: 0 }))).document;
    expect("treatment" in imageIn(after, image.id)).toBe(false);
  });

  it("calls an adjusted preset custom", () => {
    const { document, image } = withImage();
    image.treatment = treatmentWith(treatmentPresets(document).find((one) => one.value === "film")!.treatment, { grain: 0.9 });
    expect(treatmentPreset(document, image)).toBe("custom");
  });

  it("puts the theme's darker colour in a duotone's shadows, on a dark theme too", () => {
    const { document } = withImage();
    const duotone = (deck: PresentationDocument) => treatmentPresets(deck).find((one) => one.value === "duotone")!.treatment!.duotone!;
    const light = structuredClone(document);
    Object.assign(light.theme.colors, { foreground: "#111111", background: "#FFFFFF" });
    expect(duotone(light)).toEqual(["token:colors.foreground", "token:colors.accent"]);
    const dark = structuredClone(document);
    Object.assign(dark.theme.colors, { foreground: "#F5F5F5", background: "#0A0A0A" });
    expect(duotone(dark)).toEqual(["token:colors.background", "token:colors.accent"]);
  });

  it("says what PowerPoint will do before export", () => {
    expect(treatmentExportNote({ monochrome: 1 })).toBeUndefined();
    expect(treatmentExportNote({ contrast: 0.2 })).toMatch(/still adjustable/);
    expect(treatmentExportNote({ grain: 0.2 })).toMatch(/not adjustable/);
  });
});

describe("a duotone in named colours", () => {
  it("follows a rename and keeps its colour when the name is deleted", () => {
    const { document, image } = withImage();
    const named = addNamedColorOperations(document, "Ink", "#102030");
    let deck = applyPatch(document, named.operations).document;
    deck = applyPatch(deck, treatmentOperations(deck, image.id, { duotone: [named.token, "#ffffff"] })).document;

    const renamed = applyPatch(deck, renameNamedColorOperations(deck, "Ink", "Night")).document;
    expect(imageIn(renamed, image.id).treatment!.duotone).toEqual(["token:colors.custom.Night", "#ffffff"]);
    expect(validateDocument(renamed).errors).toEqual([]);

    const deleted = applyPatch(renamed, deleteNamedColorOperations(renamed, "Night")).document;
    expect(imageIn(deleted, image.id).treatment!.duotone![0]).toBe("#102030");
  });
});

describe("the Treatment controls", () => {
  function mount(treatment?: ImageElement["treatment"]) {
    const { document, image } = withImage(treatment);
    const edits: { operations: PatchOperation[]; label: string }[] = [];
    render(
      <WorkspaceClientProvider client={testWorkspaceClient()}>
        <ImageSection document={document} element={image} edit={(operations, label) => edits.push({ operations, label })} disabled={false} resolveAssetUrl={() => undefined} />
      </WorkspaceClientProvider>,
    );
    return { document, image, edits };
  }

  it("applies a look as one change", () => {
    const { document, image, edits } = mount();
    fireEvent.click(screen.getByTestId("image-treatment"));
    fireEvent.click(screen.getByRole("option", { name: "Black and white" }));
    expect(edits.map((one) => one.label)).toEqual(["Treat picture"]);
    expect(imageIn(applyPatch(document, edits[0]!.operations).document, image.id).treatment).toEqual({ monochrome: 1, contrast: 0.1 });
  });

  it("changes one adjustment and keeps the others", () => {
    const { document, image, edits } = mount({ monochrome: 1 });
    const field = screen.getByRole("textbox", { name: "Grain of the picture" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(edits).toHaveLength(1);
    expect(imageIn(applyPatch(document, edits[0]!.operations).document, image.id).treatment).toEqual({ monochrome: 1, grain: 0.3 });
  });

  it("says before export what PowerPoint will do with a grain", () => {
    mount({ grain: 0.3 });
    expect(screen.getByText(/not adjustable/)).toBeTruthy();
  });

  it("offers the duotone's colours only when there is a duotone", () => {
    mount();
    expect(screen.queryByText("Duotone shadows")).toBeNull();
    cleanup();
    mount({ duotone: ["token:colors.foreground", "token:colors.accent"] });
    expect(screen.getByText("Duotone shadows")).toBeTruthy();
    expect(screen.getByText("Duotone highlights")).toBeTruthy();
  });

  it("sets and clears a blend mode on the picture's style", () => {
    const { document, image, edits } = mount();
    fireEvent.click(screen.getByTestId("image-blend"));
    fireEvent.click(screen.getByRole("option", { name: "Multiply" }));
    const after = applyPatch(document, edits[0]!.operations).document;
    expect(imageIn(after, image.id).style?.blendMode).toBe("multiply");
    expect(validateDocument(after).errors).toEqual([]);
  });
});
