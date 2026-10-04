import { describe, expect, it } from "vitest";
import { applyPatch } from "@deckastra/transactions";
import { newId, type PresentationDocument, type Slide } from "@deckastra/presentation-schema";
import { buildDocumentScene, slideDigest } from "@deckastra/renderer";
import fixtureJson from "../../presentation-schema/fixtures/technical-deck.mydeck.json";

import {
  CodeEditError,
  codeTextForScope,
  prepareCodeEdit,
} from "../src/lib/code-edit";
import { createPortableSlide, portableSlideText } from "../src/lib/portable-slide";

const fixture = fixtureJson as unknown as PresentationDocument;

function deck(): PresentationDocument {
  return structuredClone(fixture);
}

describe("editable Code JSON", () => {
  it("round-trips every scope without an operation or transaction", () => {
    const document = deck();
    expect(prepareCodeEdit(document, { kind: "deck" }, codeTextForScope(document, { kind: "deck" })).operations).toEqual([]);

    for (const slide of document.slides) {
      const scope = { kind: "slide", slideId: slide.id } as const;
      expect(prepareCodeEdit(document, scope, codeTextForScope(document, scope)).operations).toEqual([]);
    }
  });

  it("diffs a slide at element and slide-property granularity and reproduces the candidate", () => {
    const document = deck();
    const slide = structuredClone(document.slides[0]!) as Slide;
    slide.name = "Edited from JSON";
    slide.elements[0] = { ...slide.elements[0]!, name: "Renamed element" };
    const scope = { kind: "slide", slideId: slide.id } as const;

    const prepared = prepareCodeEdit(document, scope, JSON.stringify(slide, null, 2));
    expect(prepared.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "replace", path: `/slides/id:${slide.id}/name` }),
      expect.objectContaining({ op: "replace", path: `/slides/id:${slide.id}/elements/id:${slide.elements[0]!.id}` }),
    ]));
    expect(applyPatch(document, prepared.operations).document).toEqual(prepared.candidate);
  });

  it("mints one real id for a repeated placeholder and rewrites its references", () => {
    const document = deck();
    const slide = structuredClone(document.slides[0]!) as Slide;
    const source = structuredClone(slide.elements[0]!) as Record<string, unknown>;
    source.id = "el_new1";
    source.name = "Pasted from code";
    slide.elements.push(source as never);
    slide.animations = [
      ...(slide.animations ?? []),
      {
        id: "anm_new1",
        targetId: "el_new1",
        trigger: { type: "withPrevious" },
        clips: [{ id: "clp_new1", preset: "fade", startMs: 0, durationMs: 300 }],
      } as never,
    ];
    const scope = { kind: "slide", slideId: slide.id } as const;
    let counter = 0;
    const prepared = prepareCodeEdit(document, scope, JSON.stringify(slide), {
      mintId: (prefix) => `${prefix}_01JB8Z9K2QW4RN7F3X9A${String(++counter).padStart(6, "0")}`,
    });

    const added = prepared.candidate.slides.find((item) => item.id === slide.id)!.elements.at(-1)!;
    expect(added.id).toMatch(/^el_/);
    expect(added.id).not.toBe("el_new1");
    expect(prepared.candidate.slides.find((item) => item.id === slide.id)!.animations?.at(-1)?.targetId).toBe(added.id);
    expect(applyPatch(document, prepared.operations).document).toEqual(prepared.candidate);
  });

  it("mints text-block placeholders in a hand-written text element", () => {
    const document = deck();
    const slide = structuredClone(document.slides[0]!) as Slide;
    const source = structuredClone(slide.elements.find((element) => element.type === "text")!) as Record<string, any>;
    source.id = "el_new_text";
    source.name = "Typed text";
    for (const block of source.content.blocks) block.id = "blk_new1";
    slide.elements.push(source as never);

    const prepared = prepareCodeEdit(
      document,
      { kind: "slide", slideId: slide.id },
      JSON.stringify(slide),
    );
    const added = prepared.candidate.slides[0]!.elements.find((element) => element.name === "Typed text") as Record<string, any>;
    expect(added.content.blocks[0].id).toMatch(/^blk_[0-9A-Z]{26}$/);
    expect(added.content.blocks[0].id).not.toBe("blk_new1");
    expect(prepared.mintedIds.get("blk_new1")).toBe(added.content.blocks[0].id);
  });

  it("removes animation tracks when their existing target is deleted in JSON", () => {
    const document = deck();
    const target = document.slides[0]!.elements[0]!;
    document.slides[0]!.animations = [{
      id: newId("anm"),
      targetId: target.id,
      trigger: { type: "slideEnter" },
      clips: [{ id: newId("clp"), preset: "fade", startMs: 0, durationMs: 300 }],
    }];
    const slide = structuredClone(document.slides[0]!) as Slide;
    slide.elements = slide.elements.filter((element) => element.id !== target.id);

    const prepared = prepareCodeEdit(
      document,
      { kind: "slide", slideId: slide.id },
      JSON.stringify(slide),
    );
    expect(prepared.candidate.slides[0]!.animations).toEqual([]);
    expect(prepared.report.valid).toBe(true);
    expect(applyPatch(document, prepared.operations).document).toEqual(prepared.candidate);
  });

  it("uses move operations for deck and z-order changes", () => {
    const document = deck();
    const candidate = structuredClone(document);
    candidate.slides = [candidate.slides[1]!, candidate.slides[0]!, ...candidate.slides.slice(2)];
    const prepared = prepareCodeEdit(document, { kind: "deck" }, JSON.stringify(candidate));
    expect(prepared.operations.some((operation) => operation.op === "move" && operation.from.startsWith("/slides/id:"))).toBe(true);
    expect(applyPatch(document, prepared.operations).document).toEqual(prepared.candidate);
  });

  it("copies a portable envelope and imports it with fresh internal ids", () => {
    const document = deck();
    const source = document.slides[0]!;
    const target = document.slides[1]!;
    const sourceIds = new Set(source.elements.map((element) => element.id));
    const envelope = createPortableSlide(document, source.id);

    expect(envelope.format).toBe("deckastra-slide");
    expect(JSON.stringify(envelope)).not.toContain("storageKey");
    const prepared = prepareCodeEdit(
      document,
      { kind: "slide", slideId: target.id },
      portableSlideText(document, source.id),
    );
    const imported = prepared.candidate.slides.find((slide) => slide.id === target.id)!;
    expect(imported.id).toBe(target.id);
    expect(imported.elements).toHaveLength(source.elements.length);
    expect(imported.elements.every((element) => !sourceIds.has(element.id))).toBe(true);
    expect(prepared.mintedIds.size).toBeGreaterThan(source.elements.length);
    expect(applyPatch(document, prepared.operations).document).toEqual(prepared.candidate);

    let expectedDigest = slideDigest(buildDocumentScene(document).slides[0]!);
    for (const [before, after] of [...prepared.mintedIds].sort(([a], [b]) => b.length - a.length)) {
      expectedDigest = expectedDigest.replaceAll(before, after);
    }
    const importedIndex = prepared.candidate.slides.findIndex((slide) => slide.id === target.id);
    expect(slideDigest(buildDocumentScene(prepared.candidate).slides[importedIndex]!)).toBe(expectedDigest);
  });

  it("merges portable theme dependencies and labels unavailable media", () => {
    const document = deck();
    const source = structuredClone(document.slides.find((slide) => slide.elements.some((element) => element.type === "image"))!);
    const image = source.elements.find((element) => element.type === "image") as Record<string, unknown>;
    image.assetId = "ast_01JB8Z9K2QW4RN7F3X0MISS00";
    image.styleRef = "Portable card";
    image.style = { fill: { type: "solid", color: "token:colors.custom.Portable blue" } };
    const sourceDocument = structuredClone(document);
    sourceDocument.slides = [source];
    sourceDocument.theme.colors.custom = { ...(sourceDocument.theme.colors.custom ?? {}), "Portable blue": "#123456" };
    sourceDocument.theme.objectStyles = {
      ...(sourceDocument.theme.objectStyles ?? {}),
      "Portable card": { style: { fill: { type: "solid", color: "token:colors.custom.Portable blue" } } },
    };
    sourceDocument.assets.push({
      id: image.assetId as string,
      type: "image",
      storageKey: "source-only/private.png",
      fileName: "private.png",
      checksum: "missing-checksum",
    });
    const envelope = createPortableSlide(sourceDocument, source.id);
    const target = document.slides[0]!;
    const prepared = prepareCodeEdit(document, { kind: "slide", slideId: target.id }, JSON.stringify(envelope));
    const imported = prepared.candidate.slides[0]!;

    expect(prepared.candidate.theme.colors.custom?.["Portable blue"]).toBe("#123456");
    expect(prepared.candidate.theme.objectStyles?.["Portable card"]).toBeTruthy();
    expect(imported.elements.some((element) => element.name === "Missing asset · private.png" && element.type === "shape")).toBe(true);
    expect(prepared.messages.join(" ")).toContain("labeled placeholder");
    expect(JSON.stringify(prepared.candidate.assets)).not.toContain("source-only/private.png");
    expect(prepared.report.valid).toBe(true);
  });

  it("refuses locked deck and slide identities and the asset manifest", () => {
    const document = deck();
    const changedId = structuredClone(document);
    changedId.id = document.slides[0]!.id;
    expectCode(() => prepareCodeEdit(document, { kind: "deck" }, JSON.stringify(changedId)), "E_LOCKED_FIELD");

    const changedAssets = structuredClone(document);
    changedAssets.assets = [];
    expectCode(() => prepareCodeEdit(document, { kind: "deck" }, JSON.stringify(changedAssets)), "E_LOCKED_FIELD");

    const slide = structuredClone(document.slides[0]!) as Slide;
    slide.id = document.slides[1]!.id;
    expectCode(
      () => prepareCodeEdit(document, { kind: "slide", slideId: document.slides[0]!.id }, JSON.stringify(slide)),
      "E_LOCKED_FIELD",
    );
  });

  it("treats JSON as untrusted and reports parse locations", () => {
    const document = deck();
    expectCode(() => prepareCodeEdit(document, { kind: "deck" }, '{"__proto__": {}}'), "E_UNSAFE_KEY");
    try {
      prepareCodeEdit(document, { kind: "deck" }, '{\n  "broken":\n}');
      throw new Error("Expected invalid JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(CodeEditError);
      expect((error as CodeEditError).code).toBe("E_JSON");
      expect((error as CodeEditError).line).toBeGreaterThan(1);
    }
  });

  it("blocks duplicate ids before Apply", () => {
    const document = deck();
    const slide = structuredClone(document.slides[0]!) as Slide;
    slide.elements.push(structuredClone(slide.elements[0]!));
    expectCode(
      () => prepareCodeEdit(document, { kind: "slide", slideId: slide.id }, JSON.stringify(slide)),
      "E001",
    );
  });
});

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CodeEditError);
    expect((error as CodeEditError).code).toBe(code);
  }
}
