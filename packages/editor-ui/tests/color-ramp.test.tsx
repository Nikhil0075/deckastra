import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ColorRamp } from "../src/components/inspector/ColorRamp";
import { colorRamp, hexToHsv, hsvToHex } from "../src/lib/color-math";

/** Picking a colour by eye (colour ramp, 2026-09-26). */

afterEach(cleanup);

it("converts between hex and HSV without drifting", () => {
  for (const hex of ["#D2001E", "#1E4BD2", "#00A36C", "#FFFFFF", "#000000", "#808080"]) {
    expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
  }
});

it("ramps a colour from a tint to a shade with the colour itself in the middle", () => {
  const ramp = colorRamp("#1E4BD2");
  expect(ramp).toHaveLength(9);
  expect(ramp[4]).toBe("#1E4BD2");
  const light = hexToHsv(ramp[0]!)!;
  const dark = hexToHsv(ramp[8]!)!;
  expect(light.v).toBeGreaterThan(dark.v);
  expect(light.s).toBeLessThan(hexToHsv("#1E4BD2")!.s);
});

it("commits a lighter or darker step in one click, and a keyboard move per step", () => {
  const commits: string[] = [];
  render(<ColorRamp label="Fill" value="#1E4BD2" onCommit={(hex) => commits.push(hex)} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^Darker/ })[0]!);
  expect(commits).toHaveLength(1);
  expect(hexToHsv(commits[0]!)!.v).toBeLessThan(hexToHsv("#1E4BD2")!.v);

  fireEvent.keyDown(screen.getByRole("slider", { name: "Fill: brightness and vividness" }), { key: "ArrowUp" });
  expect(commits).toHaveLength(2);
});

it("moves the hue while dragging and commits once, on release", () => {
  const commits: string[] = [];
  render(<ColorRamp label="Fill" value="#1E4BD2" onCommit={(hex) => commits.push(hex)} />);
  const hue = screen.getByRole("slider", { name: "Fill: hue" });
  fireEvent.change(hue, { target: { value: "10" } });
  fireEvent.change(hue, { target: { value: "20" } });
  expect(commits).toEqual([]);
  fireEvent.pointerUp(hue);
  expect(commits).toHaveLength(1);
  expect(Math.round(hexToHsv(commits[0]!)!.h)).toBeGreaterThanOrEqual(18);
});

it("offers opacity where asked, as an 8-digit hex, and drops the alpha at full opacity", () => {
  const commits: string[] = [];
  render(<ColorRamp label="Fill" value="#1E4BD2" alpha onCommit={(hex) => commits.push(hex)} />);
  const opacity = screen.getByRole("slider", { name: "Fill: opacity" });
  fireEvent.change(opacity, { target: { value: "50" } });
  fireEvent.pointerUp(opacity);
  expect(commits.at(-1)).toMatch(/^#1E4BD2[0-9A-F]{2}$/);
  expect(commits.at(-1)!.slice(7)).toBe("80");
});
