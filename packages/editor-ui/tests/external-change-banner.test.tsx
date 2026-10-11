// @vitest-environment jsdom
/**
 * A change from elsewhere gets its Undo in a banner, not in the bar (UI audit
 * Unit 9): in the bar it was the control a 1366px window with a long title
 * cut off.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalChangeBanner, SaveIndicator } from "../src/components/shell/SaveIndicator";
import type { EditorApi } from "../src/lib/useEditor";

afterEach(cleanup);

function editor(overrides: Record<string, unknown> = {}): EditorApi {
  return {
    save: { status: "updated" },
    externalChange: { transactionId: "txn_1" },
    undoExternalChange: vi.fn(async () => ({ ok: false, message: "Your later edit would be disturbed." })),
    saveNow: vi.fn(async () => true),
    ...overrides,
  } as unknown as EditorApi;
}

describe("a change from elsewhere", () => {
  it("is said in the bar in two words, and undone from a banner", async () => {
    const ed = editor();
    render(
      <>
        <SaveIndicator editor={ed} />
        <ExternalChangeBanner editor={ed} />
      </>,
    );
    expect(screen.getByText("Updated elsewhere")).toBeTruthy();
    const banner = screen.getByTestId("external-change-banner");
    fireEvent.click(screen.getByTestId("undo-external-change"));
    expect(ed.undoExternalChange).toHaveBeenCalled();
    // A refusal is said where the person pressed.
    expect(await screen.findByText("Your later edit would be disturbed.")).toBeTruthy();
    expect(banner.contains(screen.getByText("Your later edit would be disturbed."))).toBe(true);
  });

  it("offers nothing once the deck is saved again, or when there is nothing to undo", () => {
    const { rerender, container } = render(<ExternalChangeBanner editor={editor({ save: { status: "saved" } })} />);
    expect(container.textContent).toBe("");
    rerender(<ExternalChangeBanner editor={editor({ externalChange: null })} />);
    expect(container.textContent).toBe("");
  });
});
