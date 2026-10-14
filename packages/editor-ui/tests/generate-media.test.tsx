// @vitest-environment jsdom
/**
 * Generating a picture or clip from the Media tab (UI audit follow-up): the same
 * price-then-job steps the agent tools take, through the real HTTP client.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { GenerateMedia } from "../src/components/shell/GenerateMedia";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function capabilities(image: { available: boolean; reason: string | null }) {
  return {
    provider: "vertex", available: true, reason: null,
    tasks: {
      image: { provider: "vertex", ...image },
      video: { provider: "vertex", available: false, reason: "Sign in to make video clips." },
    },
  };
}

function mount(saveNow = vi.fn(async () => true)) {
  render(
    <GenerateMedia presentationId="pres_1" slideId="sld_1" currentVersionId={() => "ver_1"} saveNow={saveNow} />,
    { wrapper: withWorkspaceClient() },
  );
  return saveNow;
}

it("says why it cannot generate, in words, instead of hiding", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(capabilities({ available: false, reason: "Sign in to your Deckastra account to generate pictures." }))));
  mount();
  expect((await screen.findByTestId("generate-unavailable")).textContent).toContain("Sign in");
  expect(screen.queryByTestId("generate-prompt")).toBeNull();
});

it("asks the price for this exact description, then generates only on confirm", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/v1/assistant/capabilities")) return json(capabilities({ available: true, reason: null }));
    if (path.endsWith("/v1/media/quotes/image")) return json({ quote_token: "q".repeat(24), expires_at: 0, task: "image", provider: "vertex", units: 1, estimated_usd: 0.04, credit_cost: 8 });
    if (path.endsWith("/v1/assistant/runs") && init?.method === "POST") return json({ id: "run_1", status: "queued" });
    if (path.endsWith("/v1/assistant/runs/run_1")) return json({ id: "run_1", status: "completed", result: { status: "pending" } });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  const saveNow = mount();
  fireEvent.change(await screen.findByTestId("generate-prompt"), { target: { value: "A wind farm at dawn" } });
  fireEvent.click(screen.getByTestId("generate-price-check"));
  expect((await screen.findByTestId("generate-price")).textContent).toContain("8 credits");
  expect(saveNow).toHaveBeenCalled();
  const quote = fetcher.mock.calls.find(([url]) => String(url).endsWith("/quotes/image"))!;
  expect(JSON.parse(String(quote[1]!.body))).toEqual({ presentation_id: "pres_1", expected_version_id: "ver_1", slide_id: "sld_1", prompt: "A wind farm at dawn", style_source: "prompt" });
  // Nothing has been started by asking the price.
  expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/v1/assistant/runs") && init?.method === "POST")).toBe(false);

  fireEvent.click(screen.getByTestId("generate-confirm"));
  expect((await screen.findByTestId("generate-done", undefined, { timeout: 4000 })).textContent).toContain("Waiting for you");
  const started = fetcher.mock.calls.find(([url, init]) => String(url).endsWith("/v1/assistant/runs") && init?.method === "POST")!;
  expect(JSON.parse(String(started[1]!.body))).toMatchObject({
    task: "image", presentation_id: "pres_1", expected_version_id: "ver_1", instruction: "A wind farm at dawn",
    scope: { kind: "slide", slide_ids: ["sld_1"] }, image_quote_token: "q".repeat(24), style_source: "prompt",
  });
});

it("shows the deck-derived parts and prices the exact edited prompt", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/v1/assistant/capabilities")) return json(capabilities({ available: true, reason: null }));
    if (path.endsWith("/v1/assistant/media-prompt")) return json({
      prompt: "A launch vehicle\nUse deep navy #14213D.\nNo text, letters or logos.",
      parts: [
        { source: "subject", label: "Your description", text: "A launch vehicle" },
        { source: "palette", label: "From the deck: palette", text: "Use deep navy #14213D." },
        { source: "always", label: "Always", text: "No text, letters or logos." },
      ],
      aspect_ratio: "16:9", checks: [], style_source: "deck",
    });
    if (path.endsWith("/v1/media/quotes/image")) {
      const body = JSON.parse(String(init?.body));
      return json({ quote_token: "q".repeat(24), expires_at: 0, task: "image", provider: "vertex", units: 1, estimated_usd: 0.04, credit_cost: 8, prompt: body.composed_prompt });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <GenerateMedia presentationId="pres_1" slideId="sld_1" currentVersionId={() => "ver_1"} saveNow={vi.fn(async () => true)} designLanguage="cinema-noir" />,
    { wrapper: withWorkspaceClient() },
  );
  fireEvent.change(await screen.findByTestId("generate-prompt"), { target: { value: "A launch vehicle" } });
  const exact = await screen.findByTestId("generate-final-prompt");
  fireEvent.change(exact, { target: { value: "A launch vehicle\nNo text." } });
  fireEvent.click(screen.getByTestId("generate-price-check"));
  await screen.findByTestId("generate-price");
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/quotes/image"))!;
  expect(JSON.parse(String(call[1]!.body))).toMatchObject({ style_source: "deck", composed_prompt: "A launch vehicle\nNo text." });
});

it("forgets a price when the description changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/capabilities")) return json(capabilities({ available: true, reason: null }));
    return json({ quote_token: "q".repeat(24), expires_at: 0, task: "image", provider: "vertex", units: 1, estimated_usd: 0.04, credit_cost: 8 });
  }));
  mount();
  const field = await screen.findByTestId("generate-prompt");
  fireEvent.change(field, { target: { value: "One" } });
  fireEvent.click(screen.getByTestId("generate-price-check"));
  await screen.findByTestId("generate-price");
  fireEvent.change(field, { target: { value: "One, but at night" } });
  await waitFor(() => expect(screen.queryByTestId("generate-price")).toBeNull());
});

/** A slide's picture frame says what it needs, and its brief is the description to price (2026-10-13). */
it("offers the frame's brief, says what it needs, and prices exactly that", async () => {
  const fetcher = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.includes("/v1/assistant/capabilities")) return json(capabilities({ available: true, reason: null }));
    if (path.endsWith("/v1/media/quotes/image")) return json({ quote_token: "q".repeat(24), expires_at: 0, task: "image", provider: "vertex", units: 1, estimated_usd: 0.04, credit_cost: 8 });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  const slide = {
    id: "sld_1",
    elements: [{
      id: "el_frame", type: "shape", shape: "rectangle", name: "Portrait frame",
      transform: { x: 0, y: 0, width: 600, height: 900, rotation: 0 },
      mediaSlot: { role: "subject", transparentRequired: true, orientation: "portrait" },
    }],
  };
  render(
    <GenerateMedia presentationId="pres_1" slideId="sld_1" currentVersionId={() => "ver_1"} saveNow={vi.fn(async () => true)} slide={slide as never} />,
    { wrapper: withWorkspaceClient() },
  );
  const box = await screen.findByTestId("generate-slot");
  expect(box.getAttribute("data-slot-kind")).toBe("cut-out");
  expect(box.textContent).toContain("it needs a cut-out, 3:4");
  expect(box.textContent).toContain("Hands, feet and the top of the head");

  fireEvent.change(screen.getByTestId("generate-prompt"), { target: { value: "A runner mid-stride" } });
  fireEvent.click(screen.getByTestId("generate-use-brief"));
  const prompt = (screen.getByTestId("generate-prompt") as HTMLTextAreaElement).value;
  expect(prompt).toMatch(/^A runner mid-stride, the whole figure in frame/);
  expect(prompt).toContain("Complete hands and feet visible");

  fireEvent.click(screen.getByTestId("generate-price-check"));
  await screen.findByTestId("generate-price");
  const quote = fetcher.mock.calls.find(([url]) => String(url).endsWith("/quotes/image"))!;
  expect(JSON.parse(String((quote as unknown as [string, RequestInit])[1].body)).prompt).toBe(prompt);
});

it("shows no frame brief for a video clip or a slide without a frame", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(capabilities({ available: true, reason: null }))));
  render(
    <GenerateMedia presentationId="pres_1" slideId="sld_1" currentVersionId={() => "ver_1"} saveNow={vi.fn(async () => true)} slide={{ id: "sld_1", elements: [] } as never} />,
    { wrapper: withWorkspaceClient() },
  );
  await screen.findByTestId("generate-prompt");
  expect(screen.queryByTestId("generate-slot")).toBeNull();
});

it("suggests Match the deck per slide until the person picks one", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(capabilities({ available: true, reason: null }))));
  const framed = {
    id: "sld_1",
    elements: [{ id: "el_frame", type: "shape", shape: "rectangle", name: "Image frame",
      transform: { x: 0, y: 0, width: 800, height: 450, rotation: 0 }, mediaSlot: { role: "background" } }],
  };
  const plain = { id: "sld_2", elements: [] };
  const view = (slide: { id: string }) => (
    <GenerateMedia presentationId="pres_1" slideId={slide.id} currentVersionId={() => "ver_1"} saveNow={vi.fn(async () => true)} slide={slide as never} />
  );
  const checked = (id: string) => screen.getByTestId(id).getAttribute("aria-checked");
  const { rerender } = render(view(framed), { wrapper: withWorkspaceClient() });
  await screen.findByTestId("generate-style-deck");
  expect(checked("generate-style-deck")).toBe("true");
  // A slide with no frame and no language: the suggestion follows it.
  rerender(view(plain));
  await waitFor(() => expect(checked("generate-style-prompt")).toBe("true"));
  // Once chosen, the choice is kept across slides.
  fireEvent.click(screen.getByTestId("generate-style-deck"));
  rerender(view(framed));
  rerender(view(plain));
  expect(checked("generate-style-deck")).toBe("true");
});
