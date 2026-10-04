import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { describe, expect, it } from "vitest";

import { buildDocumentScene } from "../src/index";
import { SlideView } from "../src/react/index";

const scene = buildDocumentScene(loadFixture("technical"));
const animationScene = buildDocumentScene(loadFixture("animation"));

function render(index: number, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(<SlideView scene={scene.slides[index]!} {...props} />);
}

describe("slide rendering", () => {
  it("renders real text content, not a placeholder", () => {
    const html = render(0);
    expect(html).toContain("Agents propose. Deterministic engines compose.");
    expect(html).toContain("ARCHITECTURE REVIEW");
  });

  it("renders the slide at logical size", () => {
    // Children stay in logical units; the root is scaled once by the caller
    // (doc 04 §4.2). A slide that sized itself to the viewport would force every
    // child to be re-scaled individually.
    expect(render(0)).toContain("width:1920px");
    expect(render(0)).toContain("height:1080px");
  });

  it("emits every element of a container group", () => {
    const html = render(1);
    expect((html.match(/data-role="metric"/g) ?? []).length).toBe(4);
    expect(html).toContain("250ms");
    expect(html).toContain("600MB");
  });

  it("resolves theme tokens to concrete colors in the markup", () => {
    expect(render(1)).not.toContain("token:");
  });

  it("renders a table as a real table, not an image", () => {
    const html = render(3);
    expect(html).toContain("<table");
    expect(html).toContain("Per-corner radius");
    expect(html).toContain("Rasterized");
  });

  it("renders code with line numbers, highlighted", () => {
    const html = render(4);
    expect(html).toContain("patch.json");
    // Syntax highlighting splits the source across spans, so the raw substring
    // is gone by design — the text is still all there, in order.
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("&quot;op&quot;: &quot;replace&quot;");
    expect(html).toMatch(/<span style="color:[^"]*">&quot;op&quot;<\/span>/);
  });

  it("draws a diagram as real shapes, not a placeholder", () => {
    const html = render(2);
    expect(html).toContain("Orchestrator");
    expect(html).toContain("Transaction service");
    // Nodes are laid out, connected and grouped — a diagram, not a box of text.
    expect(html).toContain("data-diagram-node");
    expect(html).toContain("<marker");
    expect(html).toContain("Model-driven");
    expect(html).not.toContain("not implemented yet");
  });

  it("gives each element a stable id and layer in the DOM", () => {
    const html = render(0);
    expect(html).toMatch(/data-element-id="el_[0-9A-HJKMNP-TV-Z]{26}"/);
    expect(html).toContain('data-layer="content"');
  });

  it("emits stable line, word and grapheme targets without splitting complex Unicode", () => {
    const document = loadFixture("technical");
    const text = document.slides[0]!.elements.find((element) => element.type === "text");
    if (!text || text.type !== "text") throw new Error("fixture has no text");
    const content = text.content as { blocks: { spans: { text: string }[] }[] };
    content.blocks[0]!.spans = [{ text: "A👩‍🚀e\u0301 B" }];
    const html = renderToStaticMarkup(<SlideView scene={buildDocumentScene(document).slides[0]!} />);
    expect(html).toContain('data-sub-target="line/0"');
    expect(html).toContain('data-sub-target="word/0"');
    expect(html).toMatch(/data-sub-target="glyph\/\d+">👩‍🚀<\/span>/);
    expect(html).toMatch(/data-sub-target="glyph\/\d+">é<\/span>/);
  });

  it("keeps static export runs contiguous unless a sampled text effect needs subtargets", () => {
    const document = loadFixture("multilingual");
    const slide = buildDocumentScene(document).slides[1]!; // click-reveal text
    const contiguous = renderToStaticMarkup(<SlideView scene={slide} segmentText={false} />);
    expect(contiguous).not.toContain('data-sub-target="glyph/');
    const target = slide.nodes.find(node => node.type === "text")!;
    const sampled = renderToStaticMarkup(<SlideView scene={slide} segmentText={false} textAnimationTargets={[target.id]} />);
    expect(sampled).toContain('data-sub-target="glyph/');
    expect(sampled).toContain(`data-element-id="${target.id}"`);
  });

  it("marks a styled inner text span as the number-count slot", () => {
    const document = loadFixture("technical");
    const text = document.slides[0]!.elements.find((element) => element.type === "text");
    if (!text) throw new Error("fixture has no text");
    document.slides[0]!.animations = [{
      id: "trk_01JB8Z9K2QW4RN7F3X03999001",
      targetId: text.id,
      trigger: { type: "slideEnter" },
      clips: [{ id: "clp_01JB8Z9K2QW4RN7F3X03999002", preset: "numberCount", startMs: 0, durationMs: 420 }],
    }];
    const html = renderToStaticMarkup(<SlideView scene={buildDocumentScene(document).slides[0]!} />);
    expect(html).toContain('data-number-slot=""');
    expect(html).toMatch(/data-number-slot=""[^>]*>/);
  });

  it("mounts a dedicated translated sheen layer for shimmer", () => {
    const document = loadFixture("technical");
    const target = document.slides[0]!.elements[0]!;
    document.slides[0]!.animations = [{
      id: "trk_01JB8Z9K2QW4RN7F3X03999003",
      targetId: target.id,
      subTarget: "effect/shimmer",
      trigger: { type: "slideEnter" },
      clips: [{ id: "clp_01JB8Z9K2QW4RN7F3X03999004", preset: "shimmer", startMs: 0, durationMs: 1_200, repeat: -1 }],
    }];
    const html = renderToStaticMarkup(<SlideView scene={buildDocumentScene(document).slides[0]!} />);
    expect(html).toContain('data-sub-target="effect/shimmer"');
    expect(html).toContain("linear-gradient(110deg");
    expect(html).toContain("mix-blend-mode:screen");
  });

  it("paints in zPath order via z-index", () => {
    const html = render(0);
    const zIndexes = [...html.matchAll(/z-index:(\d+)/g)].map((m) => Number(m[1]));
    // Spaced by 10 so a later insertion does not require renumbering everything
    // (doc 04 §8.3).
    expect(zIndexes).toEqual([...zIndexes].sort((a, b) => a - b));
    expect(new Set(zIndexes).size).toBe(zIndexes.length);
  });

  it("keeps an opacity-0 animation start state in the DOM", () => {
    // The element must exist and occupy layout; only its opacity is 0. Dropping
    // it would break both the fade-in and export (doc 02 §8.2).
    const html = renderToStaticMarkup(<SlideView scene={animationScene.slides[0]!} />);
    expect(html).toContain("Motion reinforces order");
    expect(html).toMatch(/opacity:0/);
  });
});

describe("export safety", () => {
  it("never mounts editor chrome in export mode", () => {
    // Structural, not cosmetic. A CSS-only guard that someone later overrides puts
    // selection handles in a customer's PDF (doc 04 §9.1).
    const withChrome = renderToStaticMarkup(
      <SlideView scene={scene.slides[0]!} mode="editor" showGuides>
        <div data-deckastra-chrome="">selection handles</div>
      </SlideView>,
    );
    const exported = renderToStaticMarkup(
      <SlideView scene={scene.slides[0]!} mode="export" showGuides>
        <div data-deckastra-chrome="">selection handles</div>
      </SlideView>,
    );

    expect(withChrome).toContain("selection handles");
    expect(exported).not.toContain("selection handles");
    expect(exported).not.toContain("data-deckastra-chrome");
  });

  it("renders identical content markup in editor and export mode", () => {
    // Pointer-events is the one intentional difference (the editor resolves
    // selection by hit-testing these boxes), so it is normalised away here
    // rather than weakening the comparison.
    const strip = (html: string) =>
      html
        .replace(/<div data-deckastra-chrome[\s\S]*?<\/div>/g, "")
        .replace(/pointer-events:(auto|none)/g, "pointer-events:x");
    expect(strip(render(0, { mode: "export" }))).toBe(strip(render(0, { mode: "editor" })));
  });

  it("makes elements hit-testable only in editor mode", () => {
    // Without this the editor canvas has nothing to click: selection is resolved
    // from `data-element-id` on these boxes, and an inert box never receives the
    // pointer event. Present and export stay inert so a click can never land on
    // a rendered element there.
    expect(render(0, { mode: "editor" })).toContain("pointer-events:auto");
    expect(render(0, { mode: "present" })).not.toContain("pointer-events:auto");
    expect(render(0, { mode: "export" })).not.toContain("pointer-events:auto");
  });
});

describe("determinism", () => {
  it("renders byte-identical markup twice", () => {
    // The prerequisite for visual regression meaning anything.
    for (let i = 0; i < scene.slides.length; i += 1) {
      expect(render(i)).toBe(render(i));
    }
  });

  it("renders byte-identical markup from a rebuilt scene", () => {
    const rebuilt = buildDocumentScene(loadFixture("technical"));
    for (let i = 0; i < scene.slides.length; i += 1) {
      expect(renderToStaticMarkup(<SlideView scene={rebuilt.slides[i]!} />)).toBe(render(i));
    }
  });
});

describe("group boxes", () => {
  it("paints a styled group's own fill, border and radius", () => {
    // A group draws no content of its own, so it was previously skipped entirely
    // and a card built as a styled group rendered as an invisible container with
    // its children floating on the slide background.
    const kpiSlide = scene.slides[1]!;
    const html = renderToStaticMarkup(<SlideView scene={kpiSlide} />);

    const cardFill = kpiSlide.nodes
      .flatMap(function collect(node): typeof node[] {
        return [node, ...(node.children ?? []).flatMap(collect)];
      })
      .find((n) => n.type === "group" && n.resolvedStyle.fill)?.resolvedStyle.fill;

    expect(cardFill).toBeDefined();
    expect(html).toContain(`background:${cardFill}`);
    expect(html).toContain("isolation:isolate");
  });

  it("isolates groups so a child cannot paint outside its group's z-band", () => {
    const html = renderToStaticMarkup(<SlideView scene={scene.slides[1]!} />);
    expect(html).toContain("isolation:isolate");
  });
});
