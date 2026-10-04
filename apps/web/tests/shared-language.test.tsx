import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { testWorkspaceClient, withWorkspaceClient } from "@deckastra/workspace-client/testing";

import SharedPage from "../app/shared/[token]/page";

vi.mock("@deckastra/editor-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@deckastra/editor-ui")>()),
  useBrowserMeasurer: () => undefined,
}));

const deck = loadFixture("multilingual") as PresentationDocument;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toMatch(/\/v1\/shared\/tok_abc$/);
      return { ok: true, json: async () => ({ title: deck.metadata.title, role: "viewer", document: deck }) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Every text drawn on the slides, for asserting which language is showing. */
const drawn = () => document.body.textContent ?? "";

async function open(path: string) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    render(<SharedPage params={Promise.resolve({ token: "tok_abc" })} />, { wrapper: withWorkspaceClient(testWorkspaceClient()) });
  });
  return screen.findByTestId("shared-language");
}

it("opens the language a link names, and keeps the choice in the address", async () => {
  const picker = (await open("/shared/tok_abc?lang=hi-IN")) as HTMLSelectElement;
  await waitFor(() => expect(picker.value).toBe("hi-IN"));
  expect(drawn()).toContain("एक डेक, हर भाषा");

  fireEvent.change(picker, { target: { value: picker.options[0]!.value } });
  expect(new URL(window.location.href).searchParams.get("lang")).toBeNull();
  expect(drawn()).not.toContain("एक डेक, हर भाषा");

  fireEvent.change(picker, { target: { value: "ar" } });
  expect(new URL(window.location.href).searchParams.get("lang")).toBe("ar");
});

it("shows the deck as written when the link names a language it does not have", async () => {
  const picker = (await open("/shared/tok_abc?lang=fr")) as HTMLSelectElement;
  expect(picker.value).toBe(picker.options[0]!.value);
  expect(drawn()).not.toContain("एक डेक, हर भाषा");
});

it("says a narrated deck will play with sound", async () => {
  await open("/shared/tok_abc");
  expect(screen.getByRole("button", { name: "Play with sound" })).toBeTruthy();
});
