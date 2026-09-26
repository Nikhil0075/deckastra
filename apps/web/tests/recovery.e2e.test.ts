import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import type { PresentationDocument } from "@deckastra/presentation-schema";

const API = process.env.API_URL ?? "http://localhost:8000";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ENABLED = process.env.E2E === "1";
let browser: Browser;
let context: BrowserContext;
let page: Page;
let headers: Record<string, string>;

async function request(path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function createDeck() {
  const created = await request("/v1/generate", { instruction: "Recovery browser regression", slide_count: 3 });
  const id = created.presentation_id as string;
  await page.goto(`${WEB}/edit/${id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Rect", exact: true }).waitFor({ timeout: 60_000 });
  return { id, document: created.document as PresentationDocument, version: created.version_id as string };
}
async function blockSaves(id: string) {
  await page.route(`**/v1/presentations/${id}/transactions`, route =>
    route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue());
}
async function journalKey(id: string, tab = page) {
  return tab.evaluate(id => `deckastra.editor-recovery.v1:${id}:${sessionStorage.getItem(`deckastra.editor-recovery.owner:${id}`)}`, id);
}
async function localRecord(id: string, tab = page) {
  const key = await journalKey(id, tab);
  await tab.waitForFunction(key => !!localStorage.getItem(key), key);
  return tab.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
}
async function saveReview(id: string, tab = page) {
  const acknowledgement = tab.waitForResponse(response => response.url().endsWith(`/v1/presentations/${id}/transactions`) && response.request().method() === "POST");
  await tab.getByRole("button", { name: "Save reviewed result" }).click();
  const response = await acknowledgement;
  expect(response.status()).toBe(200);
  const saved = await response.json();
  await tab.getByRole("dialog").waitFor({ state: "hidden" });
  return saved;
}

beforeAll(async () => {
  if (!ENABLED) return;
  const health = await fetch(`${API}/health`).then(r => r.json());
  if (health.generation !== "stub") throw new Error("Recovery E2E requires an isolated stub-mode API; it must not spend model credits.");
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  page = await context.newPage();
  page.on("dialog", dialog => void dialog.accept());
  headers = { "Content-Type": "application/json" };
  const session = await request("/v1/dev/session", { email: "dev@localhost" });
  headers.Authorization = `Bearer ${session.token}`;
}, 120_000);
afterAll(async () => { await context?.close(); await browser?.close(); });

describe.skipIf(!ENABLED)("conflict recovery browser journey", () => {
  it("recovers an offline edit after reload and merges independent server work", async () => {
    const deck = await createDeck();
    const before = await request(`/v1/presentations/${deck.id}`);
    await blockSaves(deck.id);
    await page.getByRole("button", { name: "Rect", exact: true }).click();
    const local = await localRecord(deck.id);
    const addedId = local.document.slides[0].elements.at(-1).id;
    await request(`/v1/presentations/${deck.id}/transactions`, {
      operations: [{ op: "replace", path: "/metadata/title", value: "Saved elsewhere" }],
      expected_version_id: before.version_id, intent: "Other writer retitle",
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Review conflicting versions" }).waitFor({ timeout: 60_000 });
    expect((await localRecord(deck.id)).document.slides[0].elements.map((e: { id: string }) => e.id)).toContain(addedId);
    await page.unroute(`**/v1/presentations/${deck.id}/transactions`);
    await page.getByRole("button", { name: "Review conflicting versions" }).click();
    await page.getByText("No overlapping changes.", { exact: false }).waitFor();
    const acknowledged = await saveReview(deck.id);
    expect(acknowledged.document.slides[0].elements.map((e: { id: string }) => e.id)).toContain(addedId);
    const saved = await request(`/v1/presentations/${deck.id}`);
    expect(saved.version_id).toBe(acknowledged.version_id);
    expect(saved.document.metadata.title).toBe("Saved elsewhere");
    expect(saved.document.slides[0].elements.map((e: { id: string }) => e.id)).toContain(addedId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("header").getByText("Saved elsewhere", { exact: true }).waitFor();
    expect(await page.evaluate(key => localStorage.getItem(key), await journalKey(deck.id))).toBeNull();
  }, 180_000);

  it("requires a choice for the same property changed by both writers", async () => {
    const deck = await createDeck();
    // Add a shape through the editor and wait for its acknowledged version.
    await page.getByRole("button", { name: "Rect", exact: true }).click();
    const initial = await localRecord(deck.id);
    const element = initial.document.slides[0].elements.at(-1);
    await page.waitForFunction(key => localStorage.getItem(key) === null, await journalKey(deck.id));
    const baseline = await request(`/v1/presentations/${deck.id}`);
    await blockSaves(deck.id);
    // Rect insertion selects the element; moving with the keyboard is a real edit.
    await page.keyboard.press("ArrowRight");
    const local = await localRecord(deck.id);
    const mine = local.document.slides[0].elements.find((e: { id: string }) => e.id === element.id).transform.x;
    const path = `/slides/id:${deck.document.slides[0]!.id}/elements/id:${element.id}/transform/x`;
    await request(`/v1/presentations/${deck.id}/transactions`, {
      operations: [{ op: "replace", path, value: element.transform.x + 200 }],
      expected_version_id: baseline.version_id, intent: "Other writer move",
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Review conflicting versions" }).waitFor({ timeout: 60_000 });
    await page.unroute(`**/v1/presentations/${deck.id}/transactions`);
    await page.getByRole("button", { name: "Review conflicting versions" }).click();
    await page.getByRole("radio", { name: "Keep mine", exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "Save reviewed result" }).isDisabled()).toBe(true);
    await page.getByRole("radio", { name: "Keep mine", exact: false }).check();
    await saveReview(deck.id);
    const saved = await request(`/v1/presentations/${deck.id}`);
    expect(saved.document.slides[0].elements.find((e: { id: string }) => e.id === element.id).transform.x).toBe(mine);
  }, 180_000);

  it("isolates a duplicate tab's journal and recovers the first tab's work after it closes", async () => {
    const deck = await createDeck();
    await blockSaves(deck.id);
    await page.getByRole("button", { name: "Rect", exact: true }).click();
    const firstRecord = await localRecord(deck.id);
    const firstKey = await journalKey(deck.id);
    const firstElement = firstRecord.document.slides[0].elements.at(-1).id;
    // window.open clones sessionStorage, exercising the same ownership hazard
    // as Duplicate Tab. Both pages share localStorage and the actual API.
    const popup = page.waitForEvent("popup");
    await page.evaluate(() => { window.open(location.href, "_blank"); });
    const second = await popup;
    second.on("dialog", dialog => void dialog.accept());
    try {
      await second.getByRole("button", { name: "Rect", exact: true }).waitFor({ timeout: 60_000 });
      const secondKey = await journalKey(deck.id, second);
      expect(secondKey).not.toBe(firstKey);
      // The copies notice is one line until opened.
      await second.getByTestId("recovery-toggle").click();
      const recoverButton = second.getByRole("button", { name: /^Recover copy:/ });
      expect(await recoverButton.isDisabled()).toBe(true);
      await second.getByRole("button", { name: "Rect", exact: true }).click();
      const secondRecord = await localRecord(deck.id, second);
      const secondElement = secondRecord.document.slides[0].elements.at(-1).id;
      expect(secondElement).not.toBe(firstElement);
      await second.waitForFunction(key => localStorage.getItem(key) === null, secondKey);
      expect((await second.evaluate(key => JSON.parse(localStorage.getItem(key)!), firstKey)).document).toEqual(firstRecord.document);
      const saved = await request(`/v1/presentations/${deck.id}`);
      expect(saved.document.slides[0].elements.some((e: { id: string }) => e.id === secondElement)).toBe(true);
      expect(saved.document.slides[0].elements.some((e: { id: string }) => e.id === firstElement)).toBe(false);
      await page.close();
      await second.getByRole("button", { name: "Refresh saved copies" }).click();
      await recoverButton.click();
      await second.getByRole("button", { name: "Review conflicting versions" }).click();
      await second.getByText("No overlapping changes.", { exact: false }).waitFor();
      const acknowledged = await saveReview(deck.id, second);
      const combined = await request(`/v1/presentations/${deck.id}`);
      expect(combined.version_id).toBe(acknowledged.version_id);
      expect(combined.document.slides[0].elements.some((e: { id: string }) => e.id === firstElement)).toBe(true);
      expect(combined.document.slides[0].elements.some((e: { id: string }) => e.id === secondElement)).toBe(true);
      expect(await second.evaluate(key => localStorage.getItem(key), firstKey)).toBeNull();
      await second.reload({ waitUntil: "domcontentloaded" });
      await second.getByRole("button", { name: "Rect", exact: true }).waitFor();
      expect(await second.evaluate(key => localStorage.getItem(key), secondKey)).toBeNull();
    } finally {
      // Keep the shared harness alive for later journeys even after the original
      // page was intentionally closed to test abandoned-copy recovery.
      if (page.isClosed()) page = second;
      else await second.close();
    }
  }, 180_000);
});
