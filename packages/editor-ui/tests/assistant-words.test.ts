import { describe, expect, it } from "vitest";

import { actionState, defaultScope, plain, progressWords, promptDisclosure, QUICK_ACTIONS, scopeOptions } from "../src/lib/assistant-words";

const fixLayout = QUICK_ACTIONS.find((action) => action.id === "fix-layout")!;

describe("what the assistant says", () => {
  it("replaces a service sentence that carries engineering words, setting names included", () => {
    expect(plain("Configure DECKASTRA_VERTEX_PROJECT and DECKASTRA_VERTEX_LOCATION")).toBe("Not set up yet.");
    expect(plain("Model tasks require representative qualification")).toBe("Not set up yet.");
    expect(plain("Install the Gemma pack")).toBe("Not set up yet.");
    // A useful sentence is kept, snake_case words and all.
    expect(plain("Select a slide with pictures first.")).toBe("Select a slide with pictures first.");
    expect(plain("the slide_count is fine")).toBe("the slide_count is fine");
    expect(plain(null)).toBeNull();
  });

  it("starts on the selection when there is one, and offers it only then", () => {
    expect(defaultScope(0)).toBe("slide");
    expect(defaultScope(2)).toBe("elements");
    expect(scopeOptions(0).map((option) => option.value)).toEqual(["slide", "deck"]);
    expect(scopeOptions(1)[0]!.label).toBe("The selected object");
  });

  it("says where an action runs, never which service", () => {
    const here = actionState(fixLayout, { tasks: { tidy: { available: true, provider: "engine", reason: null } } } as never);
    expect(here).toEqual({ available: true, reason: null, where: "On this computer", cost: null });
    const online = actionState(fixLayout, { tasks: { tidy: { available: true, provider: "vertex", reason: null } } } as never);
    expect(online.where).toBe("Online");
    // Unknown capabilities are not "available"; an unlisted task is said to be missing.
    expect(actionState(fixLayout, undefined).available).toBe(false);
    expect(actionState(fixLayout, { tasks: {} } as never).reason).toBe("Not available in this version.");
  });

  it("shows what a paid action holds, in credits, before the click (rule 6)", () => {
    const paid = actionState(fixLayout, {
      tasks: { tidy: { available: true, provider: "vertex", reason: null, minimum_reservation_usd: 0.0121 } },
    } as never);
    expect(paid.cost).toBe("Up to 3 credits");
    // On this device, unavailable, or with no estimate: nothing to say.
    expect(actionState(fixLayout, { tasks: { tidy: { available: true, provider: "engine", reason: null, minimum_reservation_usd: 0.02 } } } as never).cost).toBeNull();
    expect(actionState(fixLayout, { tasks: { tidy: { available: false, provider: "vertex", reason: "x", minimum_reservation_usd: 0.02 } } } as never).cost).toBeNull();
    expect(actionState(fixLayout, { tasks: { tidy: { available: true, provider: "vertex", reason: null } } } as never).cost).toBeNull();
  });

  it("names what leaves the computer before Run", () => {
    const vertex = { provider: "vertex", available: true, reason: null } as never;
    expect(promptDisclosure(vertex, "deck", 0).text).toBe("Only your request and the whole deck are sent to Google Cloud, when you press Run.");
    expect(promptDisclosure({ provider: "local", available: true, reason: null } as never, "slide", 0).text).toBe("Nothing leaves this computer.");
    expect(promptDisclosure({ provider: "none", available: false, reason: "Set DECKASTRA_INTELLIGENCE" } as never, "slide", 0)).toEqual({
      available: false,
      text: "Not set up yet.",
    });
  });

  it("reports progress without the service's own words when they are engineering", () => {
    const run = { status: "running", cancel_requested: false } as never;
    expect(progressWords(run, { message: "Loading model weights" } as never)).toBe("Working…");
    expect(progressWords(run, { message: "Checking spacing" } as never)).toBe("Checking spacing");
    expect(progressWords({ status: "running", cancel_requested: true } as never, undefined)).toBe("Stopping…");
    expect(progressWords({ status: "completed", result: { summary: "Prepared 0 deterministic layout adjustments." } } as never, undefined)).toBe("Done.");
  });
});
