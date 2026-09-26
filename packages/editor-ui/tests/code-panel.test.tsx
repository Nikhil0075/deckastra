// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodePanel } from "../src/components/shell/ModePanels";
import type { EditorApi } from "../src/lib/useEditor";

const element = { id: "el_a", type: "shape", name: "Box" };
const slide = { id: "sld_1", elements: [element] };

function editor(primaryId?: string): EditorApi {
  return {
    document: { slides: [slide] },
    slideIndex: 0,
    selection: { selectedIds: primaryId ? [primaryId] : [], primaryId },
  } as unknown as EditorApi;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Code mode", () => {
  it("shows the slide when nothing is selected, with no scope switch", () => {
    render(<CodePanel editor={editor()} />);
    expect(screen.getByText("Slide 1")).toBeTruthy();
    expect(screen.getByTestId("code-json").textContent).toContain('"sld_1"');
    expect(screen.queryByRole("radiogroup", { name: "Show" })).toBeNull();
  });

  it("follows the selection, and Slide pins the whole slide", () => {
    render(<CodePanel editor={editor("el_a")} />);
    const json = () => JSON.parse(screen.getByTestId("code-json").textContent ?? "");
    expect(json().id).toBe("el_a");
    fireEvent.click(screen.getByRole("radio", { name: "Slide" }));
    expect(json().id).toBe("sld_1");
  });

  it("copies exactly what it shows, and says when it could not", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { rerender } = render(<CodePanel editor={editor()} />);
    await act(async () => fireEvent.click(screen.getByTestId("code-copy")));
    expect(writeText).toHaveBeenCalledWith(screen.getByTestId("code-json").textContent);
    expect(screen.getByRole("status").textContent).toBe("Copied");

    // A different subject clears the confirmation: it belonged to other text.
    rerender(<CodePanel editor={editor("el_a")} />);
    expect(screen.getByRole("status").textContent).toBe("");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => fireEvent.click(screen.getByTestId("code-copy")));
    expect(screen.getByRole("status").textContent).toBe("Could not copy");
  });
});
