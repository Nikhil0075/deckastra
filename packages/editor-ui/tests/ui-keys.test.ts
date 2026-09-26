/**
 * The keyboard and number rules under the UI primitives. Pure, so they are
 * tested directly — the components only route DOM events into these.
 */

import { describe, expect, it } from "vitest";

import { parseNumberInput, rovingIndex, stepNumber, typeaheadIndex } from "../src/lib/ui-keys";

describe("rovingIndex", () => {
  const vertical = { orientation: "vertical" as const };

  it("moves along its own axis and ignores the other", () => {
    expect(rovingIndex(0, 3, "ArrowDown", vertical)).toBe(1);
    expect(rovingIndex(1, 3, "ArrowUp", vertical)).toBe(0);
    // A vertical menu must leave ArrowRight alone — a submenu or caret needs it.
    expect(rovingIndex(1, 3, "ArrowRight", vertical)).toBeNull();
    expect(rovingIndex(1, 3, "ArrowLeft", { orientation: "horizontal" })).toBe(0);
    expect(rovingIndex(1, 3, "Enter", vertical)).toBeNull();
  });

  it("wraps by default and stops at the ends when told not to", () => {
    expect(rovingIndex(2, 3, "ArrowDown", vertical)).toBe(0);
    expect(rovingIndex(0, 3, "ArrowUp", vertical)).toBe(2);
    expect(rovingIndex(2, 3, "ArrowDown", { ...vertical, wrap: false })).toBe(2);
    expect(rovingIndex(0, 3, "ArrowUp", { ...vertical, wrap: false })).toBe(0);
  });

  it("skips disabled items rather than landing on them", () => {
    const disabled = new Set([1]);
    expect(rovingIndex(0, 3, "ArrowDown", { ...vertical, disabled })).toBe(2);
    expect(rovingIndex(2, 3, "ArrowUp", { ...vertical, disabled })).toBe(0);
    expect(rovingIndex(2, 3, "Home", { ...vertical, disabled: new Set([0]) })).toBe(1);
    expect(rovingIndex(0, 3, "End", { ...vertical, disabled: new Set([2]) })).toBe(1);
  });

  it("answers null when nothing can take focus", () => {
    expect(rovingIndex(0, 0, "ArrowDown", vertical)).toBeNull();
    expect(rovingIndex(0, 2, "ArrowDown", { ...vertical, disabled: new Set([0, 1]) })).toBeNull();
  });
});

describe("typeaheadIndex", () => {
  const labels = ["Open", "Duplicate", "Delete", "Export"];

  it("finds the next item by first letter, searching forward and wrapping", () => {
    expect(typeaheadIndex(labels, 0, "d")).toBe(1);
    expect(typeaheadIndex(labels, 1, "d")).toBe(2);
    expect(typeaheadIndex(labels, 2, "d")).toBe(1);
    expect(typeaheadIndex(labels, 0, "z")).toBeNull();
  });

  it("skips disabled items", () => {
    expect(typeaheadIndex(labels, 0, "d", new Set([1]))).toBe(2);
  });
});

describe("parseNumberInput", () => {
  it("accepts ordinary numbers, with or without thousands separators", () => {
    expect(parseNumberInput("160")).toBe(160);
    expect(parseNumberInput(" -2.5 ")).toBe(-2.5);
    expect(parseNumberInput("1,280")).toBe(1280);
    expect(parseNumberInput(".5")).toBe(0.5);
  });

  it("refuses what is not a number instead of writing NaN into a document", () => {
    for (const text of ["", " ", "abc", "12px", "1e3", "--1", "Infinity", "NaN"]) {
      expect(parseNumberInput(text), text).toBeNull();
    }
  });

  it("refuses out-of-range and fractional input instead of clamping to a value nobody typed", () => {
    expect(parseNumberInput("-40", { min: 0 })).toBeNull();
    expect(parseNumberInput("101", { max: 100 })).toBeNull();
    expect(parseNumberInput("2.5", { integer: true })).toBeNull();
    expect(parseNumberInput("0", { min: 0 })).toBe(0);
  });
});

describe("stepNumber", () => {
  it("steps, steps by ten with Shift, and clamps at the boundary", () => {
    expect(stepNumber(10, 1)).toBe(11);
    expect(stepNumber(10, -1, { large: true })).toBe(0);
    expect(stepNumber(1, -1, { min: 0, large: true })).toBe(0);
    expect(stepNumber(99, 1, { max: 100, large: true })).toBe(100);
  });

  it("keeps fractional steps free of float noise", () => {
    expect(stepNumber(0.2, 1, { step: 0.1 })).toBe(0.3);
    expect(stepNumber(1.02, 1, { step: 0.01 })).toBe(1.03);
  });
});
