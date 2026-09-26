import { describe, expect, it } from "vitest";
import type { RichTextDocument } from "@deckastra/presentation-schema";
import { applyPlainTextEdit, richTextToPlain } from "../src/index";

const rich: RichTextDocument = {
  version: 1,
  blocks: [
    { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA1", type: "heading", spans: [{ text: "Quarterly " }, { text: "review", bold: true }] },
    {
      id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA2",
      type: "bullet",
      spans: [{ text: "Revenue " }, { text: "up 12%", italic: true }, { text: " on plan" }],
      style: { paragraphSpacing: 8 },
    },
    { id: "blk_01JAAAAAAAAAAAAAAAAAAAAAA3", type: "bullet", spans: [{ text: "Costs flat", underline: true }] },
  ],
};

describe("applyPlainTextEdit (MA-08)", () => {
  it("changes one word and leaves every other run, block, style and id exactly as it was", () => {
    const next = applyPlainTextEdit(rich, "Quarterly review\nRevenue up 14% on plan\nCosts flat");
    expect(next.blocks[0]).toEqual(rich.blocks[0]);
    expect(next.blocks[2]).toEqual(rich.blocks[2]);
    expect(next.blocks[1]).toEqual({
      ...rich.blocks[1],
      spans: [{ text: "Revenue " }, { text: "up 14%", italic: true }, { text: " on plan" }],
    });
  });

  it("typing at the end of a bold word continues the bold run", () => {
    const next = applyPlainTextEdit(rich, "Quarterly reviews\nRevenue up 12% on plan\nCosts flat");
    expect(next.blocks[0]!.spans).toEqual([{ text: "Quarterly " }, { text: "reviews", bold: true }]);
  });

  it("typing at the start of a line takes the first run's marks", () => {
    const next = applyPlainTextEdit(rich, "Quarterly review\nRevenue up 12% on plan\nNew costs flat");
    expect(next.blocks[2]!.spans).toEqual([{ text: "New costs flat", underline: true }]);
  });

  it("a new line becomes a block shaped like the line it came from; a removed line removes its block", () => {
    const added = applyPlainTextEdit(rich, "Quarterly review\nRevenue up 12% on plan\nCosts flat\nHeadcount steady");
    expect(added.blocks).toHaveLength(4);
    expect(added.blocks.slice(0, 3)).toEqual(rich.blocks);
    expect(added.blocks[3]).toMatchObject({ type: "bullet", spans: [{ text: "Headcount steady", underline: true }] });
    expect(added.blocks[3]!.id).not.toBe(rich.blocks[2]!.id);

    const removed = applyPlainTextEdit(rich, "Quarterly review\nCosts flat");
    expect(removed.blocks).toEqual([rich.blocks[0], rich.blocks[2]]);
  });

  it("deleting a whole run drops it without disturbing its neighbours", () => {
    const next = applyPlainTextEdit(rich, "Quarterly review\nRevenue  on plan\nCosts flat");
    expect(next.blocks[1]!.spans).toEqual([{ text: "Revenue  on plan" }]);
    expect(next.blocks[1]!.id).toBe(rich.blocks[1]!.id);
  });

  it("an unchanged field is an unchanged document", () => {
    expect(applyPlainTextEdit(rich, richTextToPlain(rich))).toEqual(rich);
  });

  it("clearing the field leaves one empty block rather than none", () => {
    const next = applyPlainTextEdit(rich, "");
    expect(richTextToPlain(next)).toBe("");
    expect(next.blocks.length).toBeGreaterThan(0);
  });
});
