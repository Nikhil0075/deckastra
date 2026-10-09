import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { MotionModePanel } from "../src/components/shell/MotionModePanel";
import type { EditorApi } from "../src/lib/useEditor";

/**
 * Motion mode's panel (editor Phase 7): the transition editor writes ordinary
 * patches, and a plan by roles is asked for as a dry run, shown measured, and
 * applied only when the person says so — refused if the slide moved meanwhile.
 */

const deck = () => loadFixture("animation") as PresentationDocument;

function fakeEditor(document: PresentationDocument, slideIndex: number, overrides: Partial<EditorApi> = {}) {
  return {
    document,
    slideIndex,
    apply: vi.fn(),
    saveNow: vi.fn(async () => true),
    currentVersionId: () => "ver_1",
    ...overrides,
  } as unknown as EditorApi & { apply: ReturnType<typeof vi.fn> };
}

function show(editor: EditorApi) {
  const scene = buildDocumentScene(editor.document);
  return render(<MotionModePanel editor={editor} presentationId="doc_1" scene={scene} />, {
    wrapper: withWorkspaceClient(),
  });
}

function stubPlanner(plan: (body: Record<string, unknown>) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.endsWith("/motion/capabilities")) {
      return ok({ presets: ["fade", "fadeUp"], pacing: {}, roles: [], entrance_budget_ms: 2500, read_immediately_words: 24, notes: [] });
    }
    if (url.endsWith("/v1/presets")) return ok({
      description: "Reviewed", purposeGroups: ["business"], slidePatterns: [], patternDefinitions: {}, presets: [], themes: [],
      motionStyles: {
        restrained: { name: "Restrained", summary: "Quiet and measured", entrance: "fade", pacing: "measured", sequence: ["headline"], clickReveals: 0 },
        energetic: { name: "Energetic", summary: "Fast and vivid", entrance: "slide", pacing: "tight", sequence: ["headline", "metric"], clickReveals: 0 },
      },
    });
    if (url.endsWith("/motion-style")) return ok({
      outcome: "planned", version_id: "ver_1", style: "energetic", slides_changed: 4, warnings: [],
      operations: [{ op: "add", path: "/metadata/motionStyle", value: "energetic" }],
    });
    if (url.endsWith("/motion") || url.endsWith("/transition")) return ok(plan(JSON.parse(String(init?.body))));
    return ok({});
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("deck motion styles", () => {
  it("asks for a dry run and applies the returned patch as the person's edit", async () => {
    const fetcher = stubPlanner(() => ({}));
    const editor = fakeEditor(deck(), 0);
    show(editor);
    const select = await screen.findByTestId("motion-style-select");
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Energetic" }));
    fireEvent.click(screen.getByTestId("motion-style-apply"));
    await waitFor(() => expect(editor.apply).toHaveBeenCalledTimes(1));
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/motion-style"))!;
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({
      expected_version_id: "ver_1", style: "energetic", dry_run: true, client_label: "editor",
    });
    expect(editor.apply.mock.calls[0]![1].label).toBe("Motion style: Energetic");
  });
});

describe("the transition editor", () => {
  it("shows a morph's pairs as manual, and breaking one is a patch", () => {
    stubPlanner(() => ({}));
    const document = deck();
    const editor = fakeEditor(document, 3);
    show(editor);
    const rows = screen.getAllByTestId("pair-row");
    expect(rows.map((row) => row.getAttribute("data-origin"))).toEqual(["manual", "manual"]);
    fireEvent.click(within(rows[0]!).getByTestId("pair-break"));
    const [operations, options] = editor.apply.mock.calls[0]!;
    expect(options.label).toBe("Break shared-element pair");
    const after = applyPatch(document, operations as PatchOperation[]).document;
    expect(after.slides[3]!.transition!.sharedElements).toHaveLength(1);
  });

  it("changing kind away from a morph says the pairs went with it", () => {
    stubPlanner(() => ({}));
    const editor = fakeEditor(deck(), 3);
    show(editor);
    fireEvent.click(screen.getByTestId("transition-kind-fade"));
    expect(editor.apply).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/2 shared-element pairs were removed/)).toBeTruthy();
  });

  it("the first slide cannot morph: there is nothing to come from", () => {
    stubPlanner(() => ({}));
    show(fakeEditor(deck(), 0));
    expect((screen.getByTestId("transition-kind-morph") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("planning by roles", () => {
  const replay = (document: PresentationDocument) => (body: Record<string, unknown>) => {
    const slide = document.slides.find((one) => one.id === body.slide_id)!;
    return {
      outcome: "planned",
      version_id: "ver_1",
      track_count: slide.animations?.length ?? 0,
      warnings: ["body on the slide is long enough that the audience reads it"],
      operations: [{ op: "replace", path: `/slides/id:${slide.id}/animations`, value: slide.animations }],
    };
  };

  it("asks for a dry run, shows it measured, and applies it only on Apply", async () => {
    const document = deck();
    const fetcher = stubPlanner(replay(document));
    const editor = fakeEditor(document, 0);
    show(editor);

    fireEvent.click(screen.getByTestId("plan-submit"));
    const card = await screen.findByTestId("plan-card");
    expect(within(card).getByText("Not applied")).toBeTruthy();
    expect(within(card).getByTestId("plan-budget").textContent).toMatch(/^Total \d+\.\ds — within the 2\.5s budget$/);
    expect(within(card).getByText(/audience reads it/)).toBeTruthy();
    expect(editor.apply).not.toHaveBeenCalled();

    const [, init] = fetcher.mock.calls.find(([url]) => String(url).endsWith("/motion"))!;
    expect(JSON.parse(String(init!.body))).toMatchObject({
      dry_run: true,
      expected_version_id: "ver_1",
      sequence: ["headline", "metric"],
    });
    expect(editor.saveNow).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("plan-apply"));
    expect(editor.apply).toHaveBeenCalledTimes(1);
    expect(editor.apply.mock.calls[0]![1].label).toBe("Plan motion by roles");
    expect(screen.queryByTestId("plan-card")).toBeNull();
  });

  it("asks nothing while edits are unsaved", async () => {
    const fetcher = stubPlanner(replay(deck()));
    show(fakeEditor(deck(), 0, { saveNow: vi.fn(async () => false) }));
    fireEvent.click(screen.getByTestId("plan-submit"));
    expect(await screen.findByText(/not saved yet/)).toBeTruthy();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/motion"))).toBe(false);
  });

  it("refuses to apply a plan to a slide that changed since", async () => {
    const document = deck();
    stubPlanner(replay(document));
    const editor = fakeEditor(document, 0);
    const view = show(editor);
    fireEvent.click(screen.getByTestId("plan-submit"));
    await screen.findByTestId("plan-card");

    // Someone moves the headline before Apply.
    const slide = document.slides[0]!;
    const moved = applyPatch(document, [
      { op: "replace", path: `/slides/id:${slide.id}/elements/id:${slide.elements[0]!.id}/transform/x`, value: 11 },
    ]).document;
    (editor as { document: PresentationDocument }).document = moved;
    view.rerender(<MotionModePanel editor={editor} presentationId="doc_1" scene={buildDocumentScene(moved)} />);

    fireEvent.click(screen.getByTestId("plan-apply"));
    expect(editor.apply).not.toHaveBeenCalled();
    expect(screen.getByText(/changed since this plan/)).toBeTruthy();
  });

  it("plans a transition with the roles to carry", async () => {
    const document = deck();
    const fetcher = stubPlanner((body) => ({
      outcome: "planned",
      version_id: "ver_1",
      paired: 2,
      warnings: [],
      operations: [
        { op: "replace", path: `/slides/id:${body.slide_id}/transition`, value: { type: "morph", durationMs: 600 } },
      ],
    }));
    show(fakeEditor(document, 3));
    fireEvent.click(screen.getByTestId("plan-tab-transition"));
    await waitFor(() => expect(screen.getAllByTestId("plan-carry")).toHaveLength(2));
    // The planner starts from the slide's own kind, and offers the roles on both slides.
    fireEvent.click(screen.getAllByTestId("plan-carry")[1]!);
    fireEvent.click(screen.getByTestId("plan-submit"));
    const card = await screen.findByTestId("plan-card");
    expect(within(card).getByText(/morph · 600ms/)).toBeTruthy();
    const [, init] = fetcher.mock.calls.find(([url]) => String(url).endsWith("/transition"))!;
    expect(JSON.parse(String(init!.body))).toMatchObject({ dry_run: true, kind: "morph", carry: ["headline"] });
  });
});
