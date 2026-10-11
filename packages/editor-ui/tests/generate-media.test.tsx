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
  expect(JSON.parse(String(quote[1]!.body))).toEqual({ presentation_id: "pres_1", expected_version_id: "ver_1", slide_id: "sld_1", prompt: "A wind farm at dawn" });
  // Nothing has been started by asking the price.
  expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/v1/assistant/runs") && init?.method === "POST")).toBe(false);

  fireEvent.click(screen.getByTestId("generate-confirm"));
  expect((await screen.findByTestId("generate-done", undefined, { timeout: 4000 })).textContent).toContain("Waiting for you");
  const started = fetcher.mock.calls.find(([url, init]) => String(url).endsWith("/v1/assistant/runs") && init?.method === "POST")!;
  expect(JSON.parse(String(started[1]!.body))).toMatchObject({
    task: "image", presentation_id: "pres_1", expected_version_id: "ver_1", instruction: "A wind farm at dawn",
    scope: { kind: "slide", slide_ids: ["sld_1"] }, image_quote_token: "q".repeat(24),
  });
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
