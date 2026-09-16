import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { DiagramElement, PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene, flattenScene, type IconPayload } from "../src/scene";
import { buildDiagramPayload, type DiagramPayload } from "../src/diagram";
import { documentDigest, digestHash, slideDigest } from "../src/digest";
import { describeFontUsage, fontMetrics, resolveFontStack } from "../src/fonts";
import { findIcon, ICON_NAMES } from "../src/icons";
import { highlight } from "../src/highlight";
import { resolveTheme } from "../src/theme";
import { estimateLabelWidth } from "../src/scale";

const technical = loadFixture("technical");
const theme = resolveTheme(technical.theme);

function diagram(element: Partial<DiagramElement>): DiagramPayload {
  const full = {
    id: "el_01JB8Z9K2QW4RN7F3XG5HTMD10",
    type: "diagram",
    transform: { x: 0, y: 0, width: 1200, height: 600 },
    diagramType: "flow",
    nodes: [],
    edges: [],
    ...element,
  } as DiagramElement;
  return buildDiagramPayload(full, full.transform.width, full.transform.height, theme);
}

const NODES = [
  { id: "nd_01JB8Z9K2QW4RN7F3XG5HTMD11", label: "One" },
  { id: "nd_01JB8Z9K2QW4RN7F3XG5HTMD12", label: "Two" },
  { id: "nd_01JB8Z9K2QW4RN7F3XG5HTMD13", label: "Three" },
];
const EDGES = [
  { id: "edg_01JB8Z9K2QW4RN7F3XG5HTMD14", from: NODES[0]!.id, to: NODES[1]!.id },
  { id: "edg_01JB8Z9K2QW4RN7F3XG5HTMD15", from: NODES[1]!.id, to: NODES[2]!.id },
];

// --------------------------------------------------------------------- diagram

describe("diagram layout", () => {
  it("bounds label search independently of document dimensions", () => {
    const payload = diagram({
      transform: { x: 0, y: 0, width: 1200, height: 1e9 },
      nodes: NODES, edges: EDGES.map(edge => ({ ...edge, label: "Connection" })),
      layoutHint: { algorithm: "manual" },
    });
    expect(payload.edges).toHaveLength(2);
    expect(payload.edges.every(edge => Number.isFinite(edge.label?.y))).toBe(true);
  });

  it("keeps reciprocal labels clear of nodes, headings and each other", () => {
    const payloads = flattenScene(buildDocumentScene(technical).slides[2]!)
      .map(node => node.renderPayload).filter((p): p is DiagramPayload => p.kind === "diagram");
    expect(payloads).toHaveLength(1);
    const payload = payloads[0]!;
    const boxes = payload.nodes.map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
    for (const group of payload.groups) if (group.label) boxes.push({
      x: group.label.x, y: group.label.y - group.label.size,
      width: estimateLabelWidth(group.label.text, group.label.size), height: group.label.size * 1.3,
    });
    for (const edge of payload.edges) {
      if (!edge.label) continue;
      const l = edge.label;
      const w = estimateLabelWidth(l.text, l.size);
      const box = { x: l.x - w / 2, y: l.y - l.size, width: w, height: l.size * 1.3 };
      expect(boxes.some(b => box.x < b.x + b.width && b.x < box.x + box.width &&
        box.y < b.y + b.height && b.y < box.y + box.height), l.text).toBe(false);
      boxes.push(box);
    }
    expect(payload.warnings).toEqual([]);
  });

  it("ranks a chain left to right and never overlaps two nodes", () => {
    const payload = diagram({ nodes: NODES, edges: EDGES, layoutHint: { direction: "LR" } });
    const xs = payload.nodes.map((node) => node.x);
    expect(xs[0]).toBeLessThan(xs[1]!);
    expect(xs[1]).toBeLessThan(xs[2]!);

    for (let i = 0; i < payload.nodes.length; i += 1) {
      for (let j = i + 1; j < payload.nodes.length; j += 1) {
        const a = payload.nodes[i]!;
        const b = payload.nodes[j]!;
        const overlaps =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("terminates on a cycle", () => {
    // A Critic that routes work back to the Layout Agent is a cycle, and the
    // fixture has one. A ranking pass that assumed a DAG would hang here.
    const payload = diagram({
      nodes: NODES,
      edges: [...EDGES, { id: "edg_01JB8Z9K2QW4RN7F3XG5HTMD16", from: NODES[2]!.id, to: NODES[0]!.id }],
    });
    expect(payload.nodes).toHaveLength(3);
    expect(payload.edges).toHaveLength(3);
  });

  it("refuses a force layout without a seed rather than moving on reload", () => {
    const payload = diagram({
      nodes: NODES,
      edges: EDGES,
      layoutHint: { algorithm: "force" },
    });
    expect(payload.algorithm).toBe("layered");
    expect(payload.warnings[0]).toContain("seed");
  });

  it("places a seeded force layout identically every time", () => {
    const a = diagram({ nodes: NODES, edges: EDGES, layoutHint: { algorithm: "force", seed: 7 } });
    const b = diagram({ nodes: NODES, edges: EDGES, layoutHint: { algorithm: "force", seed: 7 } });
    const c = diagram({ nodes: NODES, edges: EDGES, layoutHint: { algorithm: "force", seed: 8 } });

    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    expect(a.nodes.map((n) => [n.x, n.y])).not.toEqual(c.nodes.map((n) => [n.x, n.y]));
  });

  it("honours a dragged node in hybrid mode and ignores it in managed", () => {
    // Doc 02 §18.5: silently discarding a user's drag on the next relayout is the
    // one outcome that must not be reachable, so managed has to be asked for.
    const dragged = [{ ...NODES[0]!, position: { x: 999, y: 111 } }, NODES[1]!, NODES[2]!];

    const hybrid = diagram({ nodes: dragged, edges: EDGES, layoutHint: { mode: "hybrid" } });
    expect(hybrid.nodes[0]!.x).toBe(999);
    expect(hybrid.nodes[0]!.y).toBe(111);

    const managed = diagram({ nodes: dragged, edges: EDGES, layoutHint: { mode: "managed" } });
    expect(managed.nodes[0]!.x).not.toBe(999);
  });

  it("drops a dangling edge but says which one", () => {
    const payload = diagram({
      nodes: NODES,
      edges: [{ id: "edg_01JB8Z9K2QW4RN7F3XG5HTMD17", from: NODES[0]!.id, to: "nd_missing" }],
    });
    expect(payload.edges).toHaveLength(0);
    expect(payload.warnings[0]).toContain("edg_01JB8Z9K2QW4RN7F3XG5HTMD17");
  });

  it("wraps a group around its members with room for the label", () => {
    const payload = diagram({
      nodes: NODES,
      edges: EDGES,
      groups: [
        {
          id: "grp_01JB8Z9K2QW4RN7F3XG5HTMD18",
          label: "Inside",
          kind: "boundary",
          nodeIds: [NODES[0]!.id, NODES[1]!.id],
        },
      ],
    });

    const group = payload.groups[0]!;
    const members = payload.nodes.slice(0, 2);
    for (const member of members) {
      expect(member.x).toBeGreaterThan(group.x);
      expect(member.y).toBeGreaterThan(group.y);
      expect(member.x + member.width).toBeLessThan(group.x + group.width);
    }
    expect(group.label!.y).toBeLessThan(members[0]!.y);
  });

  it("lays out the fixture's architecture diagram", () => {
    const nodes = flattenScene(buildDocumentScene(technical).slides[2]!);
    const payload = nodes.find((node) => node.type === "diagram")!.renderPayload as DiagramPayload;

    expect(payload.nodes).toHaveLength(6);
    expect(payload.edges).toHaveLength(7);
    expect(payload.groups).toHaveLength(1);
    expect(payload.algorithm).toBe("layered");
    // The declared ranks put the request first and the transaction service last.
    const byLabel = new Map(payload.nodes.map((node) => [node.label, node]));
    expect(byLabel.get("User request")!.x).toBeLessThan(byLabel.get("Critic")!.x);
    expect(byLabel.get("Critic")!.x).toBeLessThan(byLabel.get("Transaction service")!.x);
  });

  it("says so instead of drawing an empty diagram", () => {
    expect(diagram({ nodes: [], edges: [] }).notice).toBeTruthy();
  });
});

// ----------------------------------------------------------------------- icons

describe("icons", () => {
  it("resolves a curated name and a keyword near-miss", () => {
    expect(findIcon("database")).toBeDefined();
    expect(findIcon("Database")).toBeDefined();
    expect(findIcon("arrow right")).toBeDefined();
    // An agent asking for "warning" means the alert icon; a blank box helps nobody.
    expect(findIcon("warning")).toBe(findIcon("alert"));
  });

  it("returns nothing for an uncurated glyph rather than a wrong one", () => {
    expect(findIcon("acme-corp-logo")).toBeUndefined();
  });

  it("carries drawable geometry for every curated name", () => {
    for (const name of ICON_NAMES) {
      const icon = findIcon(name)!;
      expect((icon.paths.length + (icon.circles?.length ?? 0)) > 0).toBe(true);
      expect(icon.keywords.length).toBeGreaterThan(0);
    }
  });

  it("names the icon it could not draw", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    doc.slides[0]!.elements.push({
      id: "el_01JB8Z9K2QW4RN7F3XG5HTMD19",
      type: "icon",
      transform: { x: 0, y: 0, width: 64, height: 64 },
      icon: { set: "simple-icons", name: "acme" },
    } as never);

    const nodes = flattenScene(buildDocumentScene(doc).slides[0]!);
    const payload = nodes.find((node) => node.type === "icon")!.renderPayload as IconPayload;
    expect(payload.missing).toContain("acme");
    expect(payload.name).toBe("acme");
  });

  it("draws a curated icon in a theme colour", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    doc.slides[0]!.elements.push({
      id: "el_01JB8Z9K2QW4RN7F3XG5HTMD20",
      type: "icon",
      transform: { x: 0, y: 0, width: 64, height: 64 },
      icon: { set: "lucide", name: "database" },
      color: "token:colors.accent",
    } as never);

    const nodes = flattenScene(buildDocumentScene(doc).slides[0]!);
    const payload = nodes.find((node) => node.type === "icon")!.renderPayload as IconPayload;
    expect(payload.missing).toBeUndefined();
    expect(payload.paths.length).toBeGreaterThan(0);
    expect(payload.color).not.toContain("token:");
  });
});

// ---------------------------------------------------------------- highlighting

describe("syntax highlighting", () => {
  it("classifies the parts that make code readable", () => {
    const tokens = highlight('const x = "hi"; // note', "typescript");
    const kinds = new Map(tokens.map((token) => [token.text.trim(), token.kind]));
    expect(kinds.get("const")).toBe("keyword");
    expect(kinds.get('"hi"')).toBe("string");
    expect(kinds.get("// note")).toBe("comment");
  });

  it("never loses or reorders a character", () => {
    // The whole source has to come back out: highlighting that drops a byte
    // silently corrupts a code slide.
    for (const [code, language] of [
      ['def f(x):\n    return "a" + x  # c', "python"],
      ["SELECT a FROM t WHERE b = 1 -- x", "sql"],
      ["fn main() { let v: Vec<u8> = vec![1]; }", "rust"],
      ['{"a": [1, 2], "b": null}', "json"],
    ] as const) {
      expect(highlight(code, language).map((token) => token.text).join("")).toBe(code);
    }
  });

  it("stops an unbalanced quote at the end of the line", () => {
    const tokens = highlight('let a = "oops\nlet b = 1', "typescript");
    expect(tokens.find((token) => token.text === "let" && token.kind === "keyword")).toBeDefined();
    // Without the newline guard the second line would be painted as a string.
    expect(tokens.filter((token) => token.kind === "keyword")).toHaveLength(2);
  });

  it("is case-insensitive only where the language is", () => {
    expect(highlight("select 1", "sql")[0]!.kind).toBe("keyword");
    expect(highlight("Const x", "typescript")[0]!.kind).toBe("plain");
  });

  it("returns one plain token for a language it does not know", () => {
    // Guessing a grammar produces confidently wrong colours.
    const tokens = highlight("BEGIN foo END", "cobol");
    expect(tokens).toEqual([{ text: "BEGIN foo END", kind: "plain" }]);
  });

  it("terminates on an unterminated block comment", () => {
    const tokens = highlight("/* forever", "typescript");
    expect(tokens).toEqual([{ text: "/* forever", kind: "comment" }]);
  });
});

// ----------------------------------------------------------------------- fonts

describe("fonts", () => {
  it("uses per-family metrics rather than one constant", () => {
    // A monospace face advances at ~0.60 and Times at ~0.49; treating both as
    // 0.52 mis-wraps a code block one way and a serif quote the other.
    expect(fontMetrics("JetBrains Mono").averageAdvance).toBeGreaterThan(
      fontMetrics("Times New Roman").averageAdvance,
    );
  });

  it("guesses a category for an unknown family instead of failing", () => {
    expect(fontMetrics("Fira Code").averageAdvance).toBe(fontMetrics("JetBrains Mono").averageAdvance);
    expect(resolveFontStack("Whatever Sans")).toContain("sans-serif");
  });

  it("builds a metric-matched stack ending in a generic", () => {
    const stack = resolveFontStack("Inter");
    expect(stack.startsWith("Inter,")).toBe(true);
    expect(stack).toContain("Arial");
    expect(stack.endsWith("sans-serif")).toBe(true);
  });

  it("reports a substitution so a visual diff can be attributed to it", () => {
    const usage = describeFontUsage(["Inter", "Georgia"], {
      available: new Set(["Arial", "Georgia"]),
      unknown: false,
    });
    expect(usage.find((entry) => entry.family === "Georgia")!.resolved).toBe(true);

    const inter = usage.find((entry) => entry.family === "Inter")!;
    expect(inter.resolved).toBe(false);
    expect(inter.substitute).toBe("Arial");
  });

  it("says unknown rather than claiming every face is missing", () => {
    // There is nothing to probe in Node, and the headless renderer installs the
    // curated set — "unknown" is the honest answer, not "all missing".
    const usage = describeFontUsage(["Inter"], { available: new Set(), unknown: true });
    expect(usage[0]!.resolved).toBe(true);
  });

  it("records font resolution on the scene", () => {
    const scene = buildDocumentScene(technical);
    expect(scene.fonts.length).toBeGreaterThan(0);
    expect(scene.fontDigest).toBeTruthy();
    expect(scene.slides[0]!.fonts.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------- digests

describe("render digest", () => {
  it("is stable across rebuilds of the same document", () => {
    expect(documentDigest(buildDocumentScene(technical))).toBe(
      documentDigest(buildDocumentScene(loadFixture("technical"))),
    );
  });

  it("changes when geometry changes, and names the node that moved", () => {
    const moved = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    const target = moved.slides[0]!.elements[0]!;
    target.transform.x += 5;

    const before = slideDigest(buildDocumentScene(technical).slides[0]!);
    const after = slideDigest(buildDocumentScene(moved).slides[0]!);

    expect(after).not.toBe(before);
    // Readable, not hashed: the failing line has to say which node changed.
    const changed = after
      .split("\n")
      .filter((line, i) => line !== before.split("\n")[i])
      .join("");
    expect(changed).toContain(target.id);
  });

  it("changes when a font falls back", () => {
    const resolved = buildDocumentScene(technical, {
      fonts: { available: new Set(["Inter", "JetBrains Mono"]), unknown: false },
    });
    const substituted = buildDocumentScene(technical, {
      fonts: { available: new Set(["Arial"]), unknown: false },
    });
    expect(documentDigest(substituted)).not.toBe(documentDigest(resolved));
  });

  it("hashes to a short id for the places that want one", () => {
    const hash = digestHash(documentDigest(buildDocumentScene(technical)));
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
