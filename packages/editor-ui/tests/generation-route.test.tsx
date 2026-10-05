// @vitest-environment jsdom
/**
 * What a person is told before they press Generate (final package review,
 * item 19). The wording is a pure function; the drawer is checked through the
 * real component.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { GenerationStatus } from "@deckastra/workspace-contracts";

import { GenerateDeck } from "../src/components/GenerateDeck";
import { generationRoute } from "../src/lib/generation-route";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const status = (over: Partial<GenerationStatus>): GenerationStatus =>
  ({ provider: "vertex", available: true, reason: null, ...over }) as GenerationStatus;

describe("the route, in words", () => {
  it("says what leaves the machine on each route", () => {
    const hosted = generationRoute(status({ provider: "vertex" }))!;
    expect(hosted.detail).toContain("sent to Google Cloud");
    expect(hosted.detail).toContain("credits");
    // The stub writes a template. Saying so is the whole point of item 20.
    const stub = generationRoute(status({ provider: "stub" }))!;
    expect(stub.title).toContain("Demo planner");
    expect(stub.tone).toBe("waiting");
  });

  it("carries the service's own reason when generation cannot run", () => {
    const route = generationRoute(status({ provider: "none", available: false, reason: "Generation is not set up." }))!;
    expect(route.available).toBe(false);
    expect(route.detail).toBe("Generation is not set up.");
    expect(route.offerSetUp).toBe(true);
  });

  it("turns a signed-out answer into an action, and keeps setting names off the screen", () => {
    const signedOut = generationRoute(status({ available: false, reason: "Sign in to use Deckastra AI credits." }))!;
    expect(signedOut.title).toBe("Sign in to write decks with AI");
    expect(signedOut.offerSetUp).toBe(true);
    const unset = generationRoute(status({ available: false, reason: "Set DECKASTRA_VERTEX_PROJECT first." }))!;
    expect(unset.detail).not.toMatch(/DECKASTRA_/);
    expect(unset.detail).toMatch(/blank deck/);
  });

  it("does not offer a set-up screen for a mistyped setting, which it cannot fix", () => {
    expect(generationRoute(status({ provider: "misconfigured", available: false, reason: "locla" }))!.offerSetUp).toBe(false);
  });

  it("claims nothing when the server said nothing", () => {
    expect(generationRoute(undefined)).toBeNull();
  });
});

describe("the generate drawer", () => {
  const show = (generation: GenerationStatus | undefined, onSetUp?: () => void) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ repositories: [] }))));
    render(
      <GenerateDeck
        open
        projectId="prj_a"
        reviewAvailable
        generation={generation}
        onSetUp={onSetUp}
        onClose={() => {}}
        onGenerated={() => {}}
      />,
      { wrapper: withWorkspaceClient() },
    );
  };

  it("names the route before anything is written", () => {
    show(status({ provider: "vertex" }));
    expect(screen.getByTestId("generation-route").textContent).toContain("Google Cloud");
  });

  it("will not start a generation that cannot work, and offers the way to fix it", () => {
    const onSetUp = vi.fn();
    show(status({ provider: "none", available: false, reason: "Generation is not set up on this install." }), onSetUp);
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "A deck" } });
    expect(screen.getByTestId("generate-submit")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("generation-set-up"));
    expect(onSetUp).toHaveBeenCalled();
  });

  it("says nothing, and refuses nothing, against a server that does not report it", () => {
    show(undefined);
    expect(screen.queryByTestId("generation-route")).toBeNull();
    fireEvent.change(screen.getByTestId("generate-instruction"), { target: { value: "A deck" } });
    expect(screen.getByTestId("generate-submit")).toHaveProperty("disabled", false);
  });
});
