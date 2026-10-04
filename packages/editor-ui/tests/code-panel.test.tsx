// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import fixtureJson from "../../presentation-schema/fixtures/technical-deck.mydeck.json";

import { CodePanel } from "../src/components/shell/CodePanel";
import { JsonCodeEditor } from "../src/components/shell/JsonCodeEditor";
import { jsonSchemaAssist } from "../src/components/shell/json-schema-assist";
import type { EditorApi } from "../src/lib/useEditor";

const fixture = fixtureJson as unknown as PresentationDocument;
const originalGetClientRects = Range.prototype.getClientRects;

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

afterAll(() => {
  Range.prototype.getClientRects = originalGetClientRects;
});

function makeEditor(document = structuredClone(fixture), primaryId?: string): EditorApi {
  return {
    document,
    slideIndex: 0,
    selection: { selectedIds: primaryId ? [primaryId] : [], primaryId },
    apply: vi.fn(),
    historyEntries: [],
  } as unknown as EditorApi;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "deckastra");
  vi.unstubAllGlobals();
});

describe("Code mode", () => {
  it("gives Ctrl+Enter priority over CodeMirror's standard bindings", () => {
    const onApply = vi.fn();
    const onChange = vi.fn();
    render(<JsonCodeEditor value={'{\n  "ok": true\n}\n'} onChange={onChange} onApply={onApply} />);
    const content = screen.getByTestId("code-json").querySelector(".cm-content")!;
    fireEvent.keyDown(content, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("completes a JSON key after its opening quote", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "{\n  \"ele\"\n}",
        selection: { anchor: 8 },
        extensions: [jsonSchemaAssist({
          type: "object",
          properties: { elements: { type: "array" }, name: { type: "string" } },
        })],
      }),
    });

    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    const completion = currentCompletions(view.state).find((item) => item.label === "elements")!;
    expect(completion).toBeTruthy();
    expect(typeof completion.apply).toBe("function");
    if (typeof completion.apply !== "function") throw new Error("Expected a completion apply function.");
    completion.apply(view, completion, 5, 8);
    expect(view.state.doc.toString()).toBe("{\n  \"elements\": \n}");
    view.destroy();
    parent.remove();
  });

  it("starts on the current slide and keeps Selection disabled without a selection", () => {
    render(<CodePanel editor={makeEditor()} />);
    expect(screen.getByText("Current slide · 1")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Slide" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Deck" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Selection" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("code-json").textContent).toContain(fixture.slides[0]!.id);
    expect(screen.getByTestId("code-apply").hasAttribute("disabled")).toBe(true);
  });

  it("shows a selected object read-only and opens its slide for editing", () => {
    const element = fixture.slides[0]!.elements[0]!;
    render(<CodePanel editor={makeEditor(structuredClone(fixture), element.id)} />);
    expect(screen.getByText(`Selection · ${element.type}`)).toBeTruthy();
    expect(screen.getByTestId("code-json").textContent).toContain(element.id);
    expect(screen.queryByTestId("code-apply")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit in slide" }));
    expect(screen.getByText("Current slide · 1")).toBeTruthy();
    expect(screen.getByTestId("code-json").textContent).toContain(fixture.slides[0]!.id);
  });

  it("switches to the whole deck and copies the canonical clean bytes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CodePanel editor={makeEditor()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Deck" }));
    expect(screen.getByText("Whole deck")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByTestId("code-copy")));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain('"schemaVersion": "1.1.0"');
    expect(writeText.mock.calls[0]![0]).toContain(fixture.slides.at(-1)!.id);
    expect(screen.getByRole("status").textContent).toBe("Copied");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => fireEvent.click(screen.getByTestId("code-copy")));
    expect(screen.getByRole("status").textContent).toBe("Could not copy");
  });

  it("uses the desktop clipboard bridge when the browser clipboard is refused", async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "deckastra", { configurable: true, value: { writeClipboardText } });
    const browserWrite = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });
    render(<CodePanel editor={makeEditor()} />);

    await act(async () => fireEvent.click(screen.getByTestId("code-copy")));
    expect(writeClipboardText).toHaveBeenCalledTimes(1);
    expect(writeClipboardText.mock.calls[0]![0]).toContain('"format": "deckastra-slide"');
    expect(browserWrite).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("follows another current slide while the draft is clean", () => {
    const document = structuredClone(fixture);
    const editor = makeEditor(document);
    const { rerender } = render(<CodePanel editor={editor} />);
    rerender(<CodePanel editor={{ ...editor, slideIndex: 1 } as EditorApi} />);
    expect(screen.getByText("Current slide · 2")).toBeTruthy();
    expect(screen.getByTestId("code-json").textContent).toContain(document.slides[1]!.id);
  });
});
