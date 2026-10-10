/**
 * Real template previews (UI audit 2026-10-10, unit 2).
 *
 * The rules are about requests as much as pictures: a cover is asked for only
 * once its card is on screen, abandoned if the card leaves, never more than four
 * at a time, and the drawer asks for every slide only when it opens.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import fixture from "../../presentation-schema/fixtures/technical-deck.mydeck.json";

import { TemplateContactSheet, TemplateCoverPreview, forgetTemplatePreviews } from "../src/components/TemplatePreview";

// jsdom has no layout; scenes are built with the estimator, as the other panel tests do.
vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));
vi.mock("@deckastra/renderer/react", () => ({
  ScaledSlide: ({ scene }: { scene: { slideId: string } }) => <div data-thumbnail={scene.slideId} />,
}));

const deck = fixture as unknown as PresentationDocument;

/** Observers the test decides about: which elements are on screen, and when. */
const observed: Array<{ node: Element; callback: IntersectionObserverCallback }> = [];
function show(node: Element, onScreen: boolean) {
  for (const entry of observed.filter((one) => one.node === node)) {
    entry.callback([{ isIntersecting: onScreen, target: node } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
}

let width: PropertyDescriptor | undefined;
beforeAll(() => {
  width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 320 });
});
afterAll(() => {
  if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
});

beforeEach(() => {
  forgetTemplatePreviews();
  observed.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(node: Element) {
        observed.push({ node, callback: this.callback });
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = (slides: "cover" | "all") => ({
  ok: true,
  status: 200,
  headers: new Headers({ etag: `"${slides}"` }),
  json: async () => ({
    template_id: "business-pitch",
    catalog_revision: "rev",
    language_version: null,
    slides,
    document: slides === "cover" ? { ...deck, slides: deck.slides.slice(0, 1) } : deck,
  }),
});

/** A fetch that holds every preview until the test lets it answer. */
function heldPreviews() {
  const pending: Array<{ url: string; body: { slides?: string }; signal?: AbortSignal; release: () => void }> = [];
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    // The fixture cites a picture; only previews are held and counted.
    if (!url.includes("/preview")) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    const body = JSON.parse(String(init?.body ?? "{}")) as { slides?: "cover" | "all" };
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      pending.push({ url, body, signal: init?.signal ?? undefined, release: () => resolve(answer(body.slides ?? "cover")) });
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, pending };
}

const fallback = <span data-testid="drawn-stand-in" />;

describe("a template's cover", () => {
  it("is asked for only once the card is on screen, then drawn for real", async () => {
    const { pending } = heldPreviews();
    const { container } = render(<TemplateCoverPreview templateId="business-pitch" themeKey="flat" fallback={fallback} />, {
      wrapper: withWorkspaceClient(),
    });
    const cover = container.querySelector("[data-template-preview]")!;
    expect(screen.getByTestId("drawn-stand-in")).toBeTruthy();
    expect(pending).toHaveLength(0);

    act(() => show(cover, true));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.url).toMatch(/\/v1\/presets\/business-pitch\/preview$/);
    expect(pending[0]!.body).toMatchObject({ theme_key: "flat", slides: "cover" });

    await act(async () => pending[0]!.release());
    await waitFor(() => expect(cover.getAttribute("data-template-preview")).toBe("rendered"));
    expect(container.querySelector(`[data-thumbnail="${deck.slides[0]!.id}"]`)).toBeTruthy();
    expect(screen.queryByTestId("drawn-stand-in")).toBeNull();
  });

  it("abandons the request when the card leaves the screen before it answers", async () => {
    const { pending } = heldPreviews();
    const { container } = render(<TemplateCoverPreview templateId="business-pitch" themeKey="flat" fallback={fallback} />, {
      wrapper: withWorkspaceClient(),
    });
    const cover = container.querySelector("[data-template-preview]")!;
    act(() => show(cover, true));
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => show(cover, false));
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(screen.getByTestId("drawn-stand-in")).toBeTruthy();
  });

  it("composes at most four at a time, and the fifth waits for a free slot", async () => {
    const { pending } = heldPreviews();
    const { container } = render(
      <>
        {["a", "b", "c", "d", "e"].map((id) => (
          <TemplateCoverPreview key={id} templateId={id} themeKey="flat" fallback={fallback} />
        ))}
      </>,
      { wrapper: withWorkspaceClient() },
    );
    act(() => container.querySelectorAll("[data-template-preview]").forEach((node) => show(node, true)));
    await waitFor(() => expect(pending).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pending).toHaveLength(4);
    await act(async () => pending[0]!.release());
    await waitFor(() => expect(pending).toHaveLength(5));
    expect(pending[4]!.url).toMatch(/\/presets\/e\/preview$/);
  });

  it("keeps the drawn stand-in when the service cannot compose one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ detail: "No" }) })));
    const { container } = render(<TemplateCoverPreview templateId="business-pitch" themeKey="flat" fallback={fallback} />, {
      wrapper: withWorkspaceClient(),
    });
    act(() => show(container.querySelector("[data-template-preview]")!, true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("drawn-stand-in")).toBeTruthy();
  });

  it("is not asked for twice in one page for the same template and theme", async () => {
    const { pending } = heldPreviews();
    const first = render(<TemplateCoverPreview templateId="business-pitch" themeKey="flat" fallback={fallback} />, {
      wrapper: withWorkspaceClient(),
    });
    act(() => show(first.container.querySelector("[data-template-preview]")!, true));
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.release());
    first.unmount();

    const again = render(<TemplateCoverPreview templateId="business-pitch" themeKey="flat" fallback={fallback} />, {
      wrapper: withWorkspaceClient(),
    });
    expect(again.container.querySelector("[data-template-preview]")!.getAttribute("data-template-preview")).toBe("rendered");
    expect(pending).toHaveLength(1);
  });
});

describe("the contact sheet", () => {
  it("asks for every slide and draws each one", async () => {
    const { pending } = heldPreviews();
    const { container } = render(<TemplateContactSheet templateId="business-pitch" themeKey="flat" />, {
      wrapper: withWorkspaceClient(),
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.body).toMatchObject({ slides: "all" });
    await act(async () => pending[0]!.release());
    await waitFor(() => expect(container.querySelectorAll("[data-thumbnail]")).toHaveLength(deck.slides.length));
    expect(screen.getByTestId("template-sheet").getAttribute("aria-busy")).toBe("false");
  });
});
