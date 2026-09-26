// @vitest-environment jsdom
/**
 * The speaker notes field (audit P2, 2026-09-19): rich text in, a patch out.
 *
 * jsdom has no editing engine, so "typing" here is what typing leaves behind —
 * the field's DOM changed and an `input` event fired — which is exactly what the
 * component reads. The document is a real one and every commit goes through the
 * real applier, so an undoable, valid patch is what is being checked.
 */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type PatchOperation, type PresentationDocument, type RichTextDocument } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import { SpeakerNotes } from "../src/components/shell/SpeakerNotes";
import type { EditorApi } from "../src/lib/useEditor";

const base = loadFixture("technical");
const [first, second] = base.slides;

const bulleted: RichTextDocument = {
  version: 1,
  blocks: [
    { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAAA", type: "paragraph", spans: [{ text: "Say " }, { text: "this", bold: true }] },
    { id: "blk_01JBBBBBBBBBBBBBBBBBBBBBBB", type: "bullet", spans: [{ text: "one" }] },
  ],
};

let applied: Array<{ operations: PatchOperation[]; coalesceKey?: string }>;
let setSlide: (index: number) => void;
let current: () => PresentationDocument;

function Harness({ initial }: { initial: PresentationDocument }) {
  const [document, setDocument] = useState(initial);
  const [slideIndex, setSlideIndex] = useState(0);
  setSlide = setSlideIndex;
  current = () => document;
  const editor = {
    document,
    slideIndex,
    registerDraft: () => () => {},
    apply: (operations: PatchOperation[], options?: { coalesceKey?: string }) => {
      applied.push({ operations, coalesceKey: options?.coalesceKey });
      setDocument((doc) => applyPatch(doc, operations).document);
    },
  } as unknown as EditorApi;
  return <SpeakerNotes editor={editor} />;
}

function withNotes(notes: unknown): PresentationDocument {
  return { ...base, slides: base.slides.map((slide, i) => (i === 0 ? { ...slide, speakerNotes: notes as never } : slide)) };
}

const field = () => screen.getByTestId("speaker-notes");

/** What typing leaves behind: new content in the field, and an input event. */
function type(html: string) {
  field().innerHTML = html;
  fireEvent.input(field());
}

beforeEach(() => {
  applied = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the speaker notes field", () => {
  it("shows rich notes as rich — a list and a bold word, not one run-on line", () => {
    render(<Harness initial={withNotes(bulleted)} />);
    expect(field().innerHTML).toBe("<div>Say <strong>this</strong></div><ul><li>one</li></ul>");
  });

  it("commits what was typed on blur, as one undoable, valid patch keyed to this slide", () => {
    render(<Harness initial={withNotes("Plain")} />);
    type("<div>Plain, then <b>bold</b></div><ol><li>first</li></ol>");
    fireEvent.blur(field());

    expect(applied).toHaveLength(1);
    expect(applied[0]!.coalesceKey).toBe(`notes:${first!.id}`);
    const notes = current().slides[0]!.speakerNotes as RichTextDocument;
    expect(notes.blocks.map((block) => block.type)).toEqual(["paragraph", "numbered"]);
    expect(notes.blocks[0]!.spans).toEqual([{ text: "Plain, then " }, { text: "bold", bold: true }]);
    expect(validateDocument(current()).valid).toBe(true);
  });

  it("commits nothing for a visit that changed nothing", () => {
    render(<Harness initial={withNotes(bulleted)} />);
    fireEvent.input(field());
    fireEvent.blur(field());
    expect(applied).toHaveLength(0);
  });

  it("waits for an IME composition to end before committing", () => {
    vi.useFakeTimers();
    render(<Harness initial={withNotes("Plain")} />);
    fireEvent.compositionStart(field());
    type("<div>Plain 日本</div>");
    act(() => void vi.advanceTimersByTime(2000));
    expect(applied).toHaveLength(0);

    fireEvent.compositionEnd(field());
    act(() => void vi.advanceTimersByTime(2000));
    expect(applied).toHaveLength(1);
    expect(current().slides[0]!.speakerNotes).toBe("Plain 日本");
  });

  it("commits a draft to the slide it was written on when the slide changes", () => {
    render(<Harness initial={withNotes("Plain")} />);
    type("<div>For the first slide</div>");
    act(() => setSlide(1));
    expect(current().slides[0]!.speakerNotes).toBe("For the first slide");
    expect(current().slides[1]!.speakerNotes).toBe(second!.speakerNotes);
  });

  it("commits a draft when the notes are collapsed, though the field is gone", () => {
    render(<Harness initial={withNotes("Plain")} />);
    type("<div>Before collapsing</div>");
    fireEvent.click(screen.getByRole("button", { name: "Collapse speaker notes" }));
    expect(current().slides[0]!.speakerNotes).toBe("Before collapsing");
  });

  it("does not rebuild the field after its own commit, so the caret stays put", () => {
    vi.useFakeTimers();
    render(<Harness initial={withNotes("Plain")} />);
    type("<div>Plain, typing</div>");
    const line = field().firstChild;
    act(() => void vi.advanceTimersByTime(1000));
    expect(applied).toHaveLength(1);
    expect(field().firstChild).toBe(line);
  });

  it("pastes only what the allowlist keeps", () => {
    render(<Harness initial={withNotes("Plain")} />);
    const range = document.createRange();
    range.selectNodeContents(field());
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    fireEvent.paste(field(), {
      clipboardData: {
        getData: (kind: string) =>
          kind === "text/html" ? '<p><b>kept</b><img src=x onerror="alert(1)"><a href="javascript:x()">words</a></p>' : "",
      },
    });
    expect(field().innerHTML).toBe("<div>Plain</div><div><strong>kept</strong>words</div>");
    expect(field().querySelector("img, a, [onerror]")).toBeNull();
    fireEvent.blur(field());
    expect(applied).toHaveLength(1);
  });
});

describe("notes in the presenter view", () => {
  it("draws the notes' structure from the document, never as markup", async () => {
    const { RichNotes } = await import("../src/components/RichNotes");
    const { container } = render(
      <RichNotes
        notes={{
          version: 1,
          blocks: [
            ...bulleted.blocks,
            { id: "blk_01JCCCCCCCCCCCCCCCCCCCCCCC", type: "numbered", spans: [{ text: "<img src=x onerror=alert(1)>" }] },
            { id: "blk_01JDDDDDDDDDDDDDDDDDDDDDDD", type: "paragraph", spans: [{ text: "docs", link: "https://example.com" }] },
          ],
        }}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("this");
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
    expect(container.querySelector("ol > li")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img, a")).toBeNull();
  });
});
