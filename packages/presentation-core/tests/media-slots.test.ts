/**
 * A picture slot as a brief (template media slots, 2026-10-13).
 */
import { describe, expect, it } from "vitest";
import type { MediaSlot, Slide } from "@deckastra/presentation-schema";

import { mediaSlotBrief, slideMediaSlots } from "../src/media-slots";

const landscape = { width: 1920, height: 1080 };

describe("a slot's brief", () => {
  it("asks for a whole figure, hands and feet included, for a cut-out", () => {
    const brief = mediaSlotBrief({ role: "subject", transparentRequired: true, orientation: "portrait" }, { width: 600, height: 900 }, "A runner mid-stride");
    expect(brief.kind).toBe("cut-out");
    expect(brief.aspectRatio).toBe("3:4");
    expect(brief.prompt).toMatch(/^A runner mid-stride, the whole figure in frame/);
    expect(brief.prompt).toContain("Complete hands and feet visible");
    expect(brief.checks.join(" ")).toMatch(/Hands, feet and the top of the head/);
    expect(brief.checks.join(" ")).toMatch(/does not remove backgrounds yet/);
  });

  it("keeps a product's every edge inside the picture", () => {
    const brief = mediaSlotBrief({ role: "product" }, landscape, "A heat-pump module");
    expect(brief.kind).toBe("product render");
    expect(brief.prompt).toContain("clear margin of space around every edge");
    expect(brief.checks).toContain("Every edge of the product is inside the picture, with space around it.");
  });

  it("keeps the words' side calm and puts the subject on the other", () => {
    const slot: MediaSlot = { role: "background", textSafeArea: { x: 0.05, y: 0.2, width: 0.4, height: 0.6 }, focalRegion: { x: 0.7, y: 0.5 } };
    const brief = mediaSlotBrief(slot, landscape, "A wind farm at dawn");
    expect(brief.kind).toBe("scene");
    expect(brief.aspectRatio).toBe("16:9");
    expect(brief.prompt).toContain("Place the main subject in the right of the picture.");
    expect(brief.prompt).toContain("Keep the left calm and uncluttered: words will sit there.");
    expect(brief.prompt).toMatch(/No text, letters or logos\.$/);
  });

  it("says how the picture will be cut and graded", () => {
    const brief = mediaSlotBrief({ role: "background", mask: "arch", treatmentPreset: "mono" }, { width: 600, height: 900 });
    expect(brief.prompt).toContain("It will be cut to an arch");
    expect(brief.prompt).toContain("black and white");
    expect(brief.prompt.startsWith("A scene, photographed.")).toBe(true);
  });

  it("asks for no subject at all in a texture", () => {
    const brief = mediaSlotBrief({ role: "texture", focalRegion: { x: 0.2, y: 0.2 } }, landscape, "brushed steel");
    expect(brief.kind).toBe("texture");
    expect(brief.prompt).not.toContain("main subject");
  });

  it("treats a role from a newer build as a scene", () => {
    expect(mediaSlotBrief({ role: "hologram" } as MediaSlot, landscape).kind).toBe("scene");
  });
});

describe("a slide's slots", () => {
  it("lists each frame and whether a picture already fills it", () => {
    const box = { x: 0, y: 0, width: 1920, height: 1080, rotation: 0 };
    const slide = {
      id: "sld_01JB8Z9K2QW4RN7F3XG5HTMD01",
      elements: [
        { id: "el_01JB8Z9K2QW4RN7F3XG5HTMD01", type: "shape", shape: "rectangle", name: "Image frame", transform: box, mediaSlot: { role: "background" } },
        { id: "el_01JB8Z9K2QW4RN7F3XG5HTMD02", type: "image", assetId: "ast_01JB8Z9K2QW4RN7F3XG5HTMD01", transform: box },
        { id: "el_01JB8Z9K2QW4RN7F3XG5HTMD03", type: "shape", shape: "pill", name: "Arch frame", transform: { ...box, width: 600 }, mediaSlot: { role: "background", mask: "arch" } },
        { id: "el_01JB8Z9K2QW4RN7F3XG5HTMD04", type: "shape", shape: "rectangle", name: "Card", transform: box },
      ],
    } as unknown as Slide;
    expect(slideMediaSlots(slide).map((one) => [one.name, one.filled])).toEqual([["Image frame", true], ["Arch frame", false]]);
  });
});
