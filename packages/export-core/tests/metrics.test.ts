import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";
import { sceneUsedEstimatedMetrics } from "../src/index";

it("finds estimated text inside a container, then clears when it is measured", () => {
  const slide = buildDocumentScene(loadFixture("animation")).slides[0]!;
  const text = slide.nodes.find((node) => node.renderPayload.kind === "text")!;
  slide.nodes = [{ ...text, renderPayload: { kind: "group" }, children: [text] }];
  expect(sceneUsedEstimatedMetrics(slide)).toBe(true);
  if (text.renderPayload.kind === "text") text.renderPayload.metrics.estimated = false;
  expect(sceneUsedEstimatedMetrics(slide)).toBe(false);
});

it("does not report estimates for a slide with no text", () => {
  const slide = buildDocumentScene(loadFixture("animation")).slides[0]!;
  slide.nodes = [];
  expect(sceneUsedEstimatedMetrics(slide)).toBe(false);
});
