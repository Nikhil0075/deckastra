import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ELEMENT_SCHEMA_BY_TYPE,
  PresentationDocumentSchema,
  UnknownElementSchema,
  newId,
  validateDocument,
  type PresentationDocument,
} from "../src/index";

function animationDoc(): PresentationDocument {
  return JSON.parse(readFileSync(new URL("../fixtures/animation-test.mydeck.json", import.meta.url), "utf8"));
}

function baseElement(type: string) {
  return { id: newId("el"), type, transform: { x: 0, y: 0, width: 100, height: 100 } };
}

describe("known element validation", () => {
  it("rejects the reported line endpoint aliases and names both missing fields", () => {
    const doc = animationDoc();
    expect(PresentationDocumentSchema.safeParse(doc).success).toBe(true);
    const index = doc.slides[1]!.elements.findIndex((element) => element.type === "line");
    expect(index).toBeGreaterThanOrEqual(0);
    const line = doc.slides[1]!.elements[index] as unknown as Record<string, unknown>;
    line.start = line.from;
    line.end = line.to;
    delete line.from;
    delete line.to;

    expect(PresentationDocumentSchema.safeParse(doc).success).toBe(false);
    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    for (const field of ["from", "to"]) {
      expect(report.errors).toContainEqual(expect.objectContaining({
        code: "E002",
        path: `/slides/1/elements/${index}/${field}`,
        message: expect.stringContaining(`"${field}"`),
      }));
    }
  });

  it.each([
    ["text", "content"], ["shape", "shape"], ["image", "assetId"],
    ["group", "children"], ["componentInstance", "componentId"],
  ])("does not accept a %s missing %s via the fallback", (type, field) => {
    const doc = animationDoc();
    doc.slides[0]!.elements = [baseElement(type)] as never;
    expect(PresentationDocumentSchema.safeParse(doc).success).toBe(false);
    expect(validateDocument(doc).errors).toContainEqual(expect.objectContaining({
      code: "E002", path: `/slides/0/elements/0/${field}`,
      message: expect.stringContaining(`"${field}"`),
    }));
  });

  it.each(["group", "componentInstance"])("expands nested field failures inside %s", (type) => {
    const child = { ...baseElement("line"), to: { x: 10, y: 20 } };
    const innerGroup = { ...baseElement("group"), children: [child] };
    const parent = type === "group"
      ? { ...baseElement(type), children: [innerGroup] }
      : { ...baseElement(type), componentId: newId("cmp"), componentVersion: "1.0.0",
          parameters: {}, slotContent: { body: [innerGroup] } };
    const doc = animationDoc();
    doc.slides[0]!.elements = [parent] as never;
    const childPath = type === "group" ? "children/0" : "slotContent/body/0";
    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: "E002", path: `/slides/0/elements/0/${childPath}/children/0/from`,
      message: expect.stringContaining('"from"'),
    }));
  });

  it.each(Object.keys(ELEMENT_SCHEMA_BY_TYPE))("excludes %s from UnknownElementSchema", (type) => {
    expect(UnknownElementSchema.safeParse(baseElement(type)).success).toBe(false);
  });

  it("reports invalid base fields on an unknown type with a prototype-key name without throwing", () => {
    const doc = animationDoc();
    doc.slides[0]!.elements = [{ ...baseElement("constructor"), transform: {} }] as never;
    expect(validateDocument(doc).valid).toBe(false);
  });
});
