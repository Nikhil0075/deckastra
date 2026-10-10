import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "@deckastra/transactions";
import { validateDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import {
  InkMirror,
  InkSession,
  MAX_POINTS,
  addPoint,
  sanitizeInkCommand,
  sanitizeInkSnapshot,
  sanitizeStroke,
  strokesAt,
  toSlidePoint,
  type InkStroke,
} from "../src/lib/ink";
import { inkAnnotationOperations, saveAnnotatedCopy } from "../src/lib/ink-annotations";
import { PresentChannel, type SyncMessage } from "../src/lib/presentSync";

const stroke = (id: string, slideId = "sld_a", points: Array<[number, number]> = [[0.1, 0.1], [0.4, 0.4]]): InkStroke => ({
  id,
  slideId,
  tool: "pen",
  color: "#FF3B30",
  width: 6,
  points,
});

describe("the authority's ink (UI audit unit 6)", () => {
  it("applies a stroke once, however often it arrives", () => {
    const session = new InkSession();
    expect(session.apply({ op: "add", stroke: stroke("ink_1") })).toBe(true);
    expect(session.apply({ op: "add", stroke: stroke("ink_1") })).toBe(false);
    expect(session.strokes("sld_a")).toHaveLength(1);
    expect(session.rev).toBe(1);
  });

  it("treats an erase of a stroke that has gone as nothing", () => {
    const session = new InkSession();
    expect(session.apply({ op: "erase", slideId: "sld_a", strokeId: "ink_missing" })).toBe(false);
    expect(session.rev).toBe(0);
  });

  it("applies a sender's command once, by sequence number, so a replay draws nothing twice", () => {
    const session = new InkSession();
    const first = { sender: "win_1", seq: 1, op: { op: "add" as const, stroke: stroke("ink_1") } };
    expect(session.accept(first)).toBe(true);
    // The same command again, and an older one: both already seen.
    expect(session.accept(first)).toBe(false);
    expect(session.accept({ sender: "win_1", seq: 1, op: { op: "add", stroke: stroke("ink_2") } })).toBe(false);
    expect(session.strokes("sld_a").map((one) => one.id)).toEqual(["ink_1"]);
    expect(session.snapshot("sld_a").acks).toEqual({ win_1: 1 });
  });

  it("undoes and redoes per slide, and a new stroke ends only that slide's redo", () => {
    const session = new InkSession();
    session.apply({ op: "add", stroke: stroke("ink_a1", "sld_a") });
    session.apply({ op: "add", stroke: stroke("ink_b1", "sld_b") });

    // Undo on slide A takes A's stroke, not the later one on B.
    session.apply({ op: "undo", slideId: "sld_a" });
    expect(session.strokes("sld_a")).toEqual([]);
    expect(session.strokes("sld_b")).toHaveLength(1);
    expect(session.canRedo("sld_a")).toBe(true);

    session.apply({ op: "undo", slideId: "sld_b" });
    session.apply({ op: "add", stroke: stroke("ink_a2", "sld_a") });
    expect(session.canRedo("sld_a")).toBe(false);
    expect(session.canRedo("sld_b")).toBe(true);

    session.apply({ op: "redo", slideId: "sld_b" });
    expect(session.strokes("sld_b").map((one) => one.id)).toEqual(["ink_b1"]);
  });

  it("puts an erased stroke back where it was on undo", () => {
    const session = new InkSession();
    for (const id of ["ink_1", "ink_2", "ink_3"]) session.apply({ op: "add", stroke: stroke(id) });
    session.apply({ op: "erase", slideId: "sld_a", strokeId: "ink_2" });
    session.apply({ op: "undo", slideId: "sld_a" });
    expect(session.strokes("sld_a").map((one) => one.id)).toEqual(["ink_1", "ink_2", "ink_3"]);
  });

  it("undoes a cleared slide in one step, and clearing everything is not undoable", () => {
    const session = new InkSession();
    session.apply({ op: "add", stroke: stroke("ink_1") });
    session.apply({ op: "add", stroke: stroke("ink_2") });
    session.apply({ op: "clear-slide", slideId: "sld_a" });
    expect(session.strokes("sld_a")).toEqual([]);
    session.apply({ op: "undo", slideId: "sld_a" });
    expect(session.strokes("sld_a")).toHaveLength(2);

    session.apply({ op: "clear-all" });
    expect(session.count()).toBe(0);
    expect(session.canUndo("sld_a")).toBe(false);
  });
});

describe("a presenter window's mirror", () => {
  it("shows its own stroke until the authority acknowledges it", () => {
    const mirror = new InkMirror("win_p");
    const command = mirror.command({ op: "add", stroke: stroke("ink_1") });
    expect(mirror.strokes("sld_a").map((one) => one.id)).toEqual(["ink_1"]);

    // The authority applied it: the snapshot carries it and acknowledges seq 1.
    mirror.receive({ rev: 1, slideId: "sld_a", strokes: [stroke("ink_1")], canUndo: true, canRedo: false, acks: { win_p: command.seq } });
    expect(mirror.strokes("sld_a").map((one) => one.id)).toEqual(["ink_1"]);
  });

  it("drops an acknowledged stroke the authority has since undone, rather than keeping it forever", () => {
    const mirror = new InkMirror("win_p");
    mirror.command({ op: "add", stroke: stroke("ink_1") });
    mirror.receive({ rev: 2, slideId: "sld_a", strokes: [], canUndo: false, canRedo: true, acks: { win_p: 1 } });
    expect(mirror.strokes("sld_a")).toEqual([]);
  });

  it("ignores a snapshot older than the one it holds", () => {
    const mirror = new InkMirror("win_p");
    expect(mirror.receive({ rev: 5, slideId: "sld_a", strokes: [stroke("ink_new")], canUndo: true, canRedo: false, acks: {} })).toBe(true);
    // A late message from before: it must not take back the newer state.
    expect(mirror.receive({ rev: 3, slideId: "sld_a", strokes: [], canUndo: false, canRedo: false, acks: {} })).toBe(false);
    expect(mirror.strokes("sld_a").map((one) => one.id)).toEqual(["ink_new"]);
  });

  it("shows nothing for a slide the snapshot is not about", () => {
    const mirror = new InkMirror("win_p");
    mirror.receive({ rev: 1, slideId: "sld_a", strokes: [stroke("ink_1")], canUndo: true, canRedo: false, acks: {} });
    expect(mirror.strokes("sld_b")).toEqual([]);
  });

  it("agrees with the authority after a round trip through the channel, including a late joiner", () => {
    // Two PresentChannels joined by a fake bus, as two windows are.
    const buses: Array<{ onmessage: ((event: MessageEvent<SyncMessage>) => void) | null }> = [];
    const factory = () => {
      const bus = {
        onmessage: null as ((event: MessageEvent<SyncMessage>) => void) | null,
        postMessage(message: SyncMessage) {
          for (const other of buses) if (other !== bus) other.onmessage?.({ data: structuredClone(message) } as MessageEvent<SyncMessage>);
        },
        close() {},
      };
      buses.push(bus);
      return bus as unknown as BroadcastChannel;
    };

    const session = new InkSession();
    session.apply({ op: "add", stroke: stroke("ink_before") });
    const audience: PresentChannel = new PresentChannel(
      "talk",
      {
        onIndex: vi.fn(),
        currentIndex: () => 0,
        slideCount: () => 3,
        currentInk: () => session.snapshot("sld_a"),
        onInkCommand: (command) => {
          session.accept(command);
          audience.postInk(session.snapshot("sld_a"));
        },
      },
      factory,
    );
    audience.open();

    // The presenter window opens after a stroke was drawn: its hello is answered
    // with the ink already there.
    const mirror = new InkMirror("win_p");
    const presenter = new PresentChannel(
      "talk",
      { onIndex: vi.fn(), currentIndex: () => 0, slideCount: () => 3, onInkState: (snapshot) => mirror.receive(snapshot) },
      factory,
    );
    presenter.open();
    expect(mirror.strokes("sld_a").map((one) => one.id)).toEqual(["ink_before"]);

    presenter.inkCommand(mirror.command({ op: "add", stroke: stroke("ink_after") }));
    presenter.inkCommand(mirror.command({ op: "undo", slideId: "sld_a" }));
    expect(session.strokes("sld_a").map((one) => one.id)).toEqual(["ink_before"]);
    expect(mirror.strokes("sld_a").map((one) => one.id)).toEqual(["ink_before"]);
  });
});

describe("what arrives over the channel is checked", () => {
  it("refuses a stroke with a colour outside the allowlist, a bad id, or too many points", () => {
    expect(sanitizeStroke({ ...stroke("ink_1"), color: "url(javascript:alert(1))" })).toBeNull();
    expect(sanitizeStroke({ ...stroke("ink 1") })).toBeNull();
    const many = Array.from({ length: MAX_POINTS + 1 }, (_, i) => [i / MAX_POINTS, 0.5]);
    expect(sanitizeStroke({ ...stroke("ink_1"), points: many })).toBeNull();
  });

  it("clamps coordinates and width rather than trusting them", () => {
    const clean = sanitizeStroke({ ...stroke("ink_1"), width: 900, points: [[-1, 2], [0.5, 0.5]] });
    expect(clean?.width).toBe(48);
    expect(clean?.points[0]).toEqual([0, 1]);
  });

  it("ignores an unknown operation and a command with no sequence number", () => {
    expect(sanitizeInkCommand({ sender: "win_1", seq: 1, op: { op: "format-disk" } })).toBeNull();
    expect(sanitizeInkCommand({ sender: "win_1", op: { op: "clear-all" } })).toBeNull();
    expect(sanitizeInkCommand({ sender: "win_1", seq: 2, op: { op: "clear-all" } })).toEqual({ sender: "win_1", seq: 2, op: { op: "clear-all" } });
  });

  it("drops a snapshot stroke that names another slide", () => {
    const snapshot = sanitizeInkSnapshot({ rev: 1, slideId: "sld_a", strokes: [stroke("ink_1", "sld_b")], acks: { win_1: 3 } });
    expect(snapshot?.strokes).toEqual([]);
    expect(snapshot?.acks).toEqual({ win_1: 3 });
  });
});

describe("geometry", () => {
  it("maps a pointer against the slide's box, so the letterbox is outside it", () => {
    // A 16:9 slide letterboxed in a 4:3 window: the slide sits 100px down.
    const box = { left: 0, top: 100, width: 1600, height: 900 };
    expect(toSlidePoint(0, 100, box)).toEqual([0, 0]);
    expect(toSlidePoint(1600, 1000, box)).toEqual([1, 1]);
    // In the letterbox: outside 0–1, so a stroke there is clamped to the edge.
    expect(addPoint([], toSlidePoint(800, 40, box)!)).toEqual([[0.5, 0]]);
  });

  it("skips points too close to the last, and stops at the cap", () => {
    expect(addPoint([[0.5, 0.5]], [0.5001, 0.5])).toEqual([[0.5, 0.5]]);
    const full = Array.from({ length: MAX_POINTS }, (_, i) => [i / MAX_POINTS, 0] as [number, number]);
    expect(addPoint(full, [0.9, 0.9])).toHaveLength(MAX_POINTS);
  });

  it("finds the strokes an eraser touches, measured in slide pixels", () => {
    const strokes = [stroke("ink_near", "sld_a", [[0.1, 0.5], [0.3, 0.5]]), stroke("ink_far", "sld_a", [[0.8, 0.1], [0.9, 0.1]])];
    expect(strokesAt(strokes, [0.2, 0.51], { width: 1920, height: 1080 })).toEqual(["ink_near"]);
  });
});

describe("saving an annotated copy", () => {
  it("adds one locked group of locked paths per inked slide, and the copy still validates", () => {
    const document = structuredClone(loadFixture("technical"));
    const presented = document.slides.map((one) => `presented_${one.id}`);
    const strokes = new Map([[presented[1]!, [stroke("ink_1", presented[1]!, [[0.1, 0.2], [0.3, 0.6], [0.5, 0.2]]), { ...stroke("ink_2", presented[1]!, [[0.7, 0.7]]), tool: "highlighter" as const }]]]);

    const operations = inkAnnotationOperations(document, presented, strokes);
    expect(operations).toHaveLength(1);
    expect(operations[0]!.path).toBe(`/slides/id:${document.slides[1]!.id}/elements/-`);

    const result = applyPatch(document, operations);
    const added = result.document.slides[1]!.elements.at(-1) as unknown as { name: string; locked: boolean; children: Array<Record<string, unknown>> };
    expect(added.name).toBe("Annotations");
    expect(added.locked).toBe(true);
    expect(added.children.map((child) => [child.shape, child.locked, child.name])).toEqual([
      ["customPath", true, "Pen stroke"],
      ["customPath", true, "Highlight"],
    ]);
    // A single point still has a box to be scaled into.
    expect((added.children[1]!.transform as { width: number }).width).toBeGreaterThanOrEqual(1);
    expect(validateDocument(result.document).errors).toEqual([]);
  });

  it("drains the save queue first, and stops when it cannot", async () => {
    const client = {
      clientId: "web-editor",
      documents: { duplicate: vi.fn(), read: vi.fn(), commit: vi.fn() },
    };
    await expect(
      saveAnnotatedCopy(client, { presentationId: "doc_1", presentedSlideIds: [], strokes: new Map(), saveNow: async () => false }),
    ).rejects.toThrow(/not saved yet/);
    expect(client.documents.duplicate).not.toHaveBeenCalled();
  });

  it("writes the annotations to the copy, never to the deck that was presented", async () => {
    const document = structuredClone(loadFixture("technical"));
    const client = {
      clientId: "web-editor",
      documents: {
        duplicate: vi.fn(async () => ({ presentation_id: "doc_copy", title: "Copy" })),
        read: vi.fn(async () => ({ document, version_id: "ver_copy" })),
        commit: vi.fn(async () => ({})),
      },
    };
    const presented = document.slides.map((one) => one.id);
    const saved = await saveAnnotatedCopy(client, {
      presentationId: "doc_original",
      presentedSlideIds: presented,
      strokes: new Map([[presented[0]!, [stroke("ink_1", presented[0]!)]]]),
      saveNow: async () => true,
    });
    expect(client.documents.duplicate).toHaveBeenCalledWith("doc_original");
    expect(client.documents.commit).toHaveBeenCalledTimes(1);
    const [target, body] = client.documents.commit.mock.calls[0] as unknown as [string, { expected_version_id: string; operations: unknown[] }];
    expect(target).toBe("doc_copy");
    expect(body.expected_version_id).toBe("ver_copy");
    expect(saved.title).toMatch(/\(annotated\)$/);
  });
});
