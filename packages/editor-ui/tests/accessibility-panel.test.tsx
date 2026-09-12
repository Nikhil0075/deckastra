import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { AccessibilityPanel } from "../src/components/AccessibilityPanel";

afterEach(cleanup);

it("shows actionable issues and navigates to the affected object", () => {
  const document = structuredClone(loadFixture("technical"));
  const slide = document.slides.find((candidate) => candidate.elements.some((element) => element.type === "diagram"))!;
  const diagram = slide.elements.find((element) => element.type === "diagram")!;
  diagram.name = "Architecture map";
  diagram.metadata = { ...diagram.metadata, altText: "" };
  const onSelect = vi.fn();

  render(<AccessibilityPanel document={document} slideId={slide.id} onSelect={onSelect} />);
  expect(screen.getByRole("region", { name: "Accessibility review" })).toBeTruthy();
  expect(screen.getByText("Architecture map has no alternative text.")).toBeTruthy();
  fireEvent.click(screen.getByText("Architecture map has no alternative text."));
  expect(onSelect).toHaveBeenCalledWith(slide.id, diagram.id);

  fireEvent.click(screen.getByText(/Reading order/));
  expect(screen.getByRole("list", { name: "Current slide reading order" })).toBeTruthy();
});
