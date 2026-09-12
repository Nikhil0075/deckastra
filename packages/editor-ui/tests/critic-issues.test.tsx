import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CriticIssues } from "../src/components/CriticIssues";

afterEach(cleanup);

it("shows deck and selected-slide issues from the persisted extension", () => {
  render(<CriticIssues slideId="slide-a" value={{
    "": [{ message: "Check sources", suggested_fix: "Add citations" }],
    "slide-a": [{ message: "Dense slide" }],
    "slide-b": [{ message: "Another slide" }],
  }} />);
  expect(screen.getByRole("region", { name: "Unresolved review issues" })).toBeTruthy();
  expect(screen.getByText("Add citations")).toBeTruthy();
  expect(screen.getByText("Dense slide", { exact: false })).toBeTruthy();
  expect(screen.queryByText("Another slide", { exact: false })).toBeNull();
});

it("ignores malformed future extension values without crashing the editor", () => {
  const { container } = render(<CriticIssues value={{ "": [null, 42, { message: {} }] }} />);
  expect(container.textContent).toBe("");
});
