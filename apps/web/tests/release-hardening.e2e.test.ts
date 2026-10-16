import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

/**
 * Final release journey: real API, real browser, keyboard entry, 200% layout,
 * and an accessibility fix that must survive a reload without changing layers.
 * Generation is intentionally outside this gate.
 */
const ENABLED = process.env.E2E === "1";
const API = process.env.API_URL ?? "http://localhost:8000";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
let browser: Browser | undefined;
let page: Page | undefined;
let headers: Record<string, string>;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

beforeAll(async () => {
  if (!ENABLED) return;
  const health = await fetch(`${API}/health`).then((response) => response.json());
  if (health.status !== "ok") throw new Error("Release E2E requires a ready isolated API.");
  const session = await fetch(`${API}/v1/dev/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "dev@localhost" }),
  }).then((response) => response.json());
  headers = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
}, 120_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
});

describe.skipIf(!ENABLED)("release accessibility and persistence journey", () => {
  it("fixes screen-reader order by keyboard at 200% without changing visual layers", async () => {
    const created = await request("/v1/decks/from-template", {
      method: "POST", body: JSON.stringify({ template_id: "technical-architecture", title: "Release hardening" }),
    }) as { presentation_id: string; version_id: string; document: { slides: Array<{ id: string; elements: Array<{ id: string }> }> } };
    const slide = created.document.slides[0]!;
    const lowerId = "el_01JB8Z9K2QW4RN7F3X87000001";
    const upperId = "el_01JB8Z9K2QW4RN7F3X87000002";
    const text = (id: string, y: number, words: string) => ({
      id, type: "text", name: words, transform: { x: 120, y, width: 620, height: 80 },
      content: { version: 1, blocks: [{ id: id.replace("el_", "blk_"), type: "paragraph", spans: [{ text: words }] }] },
      typography: {
        fontFamily: "token:typography.body.fontFamily",
        fontSize: 32,
        color: "token:colors.foreground",
      },
      fit: "autoHeight",
      semanticRole: "body",
    });
    const originalLayers = slide.elements.map((element) => element.id);
    const saved = await request(`/v1/presentations/${created.presentation_id}/transactions`, {
      method: "POST",
      body: JSON.stringify({
        expected_version_id: created.version_id,
        intent: "Add reading-order acceptance objects",
        operations: [
          { op: "add", path: `/slides/id:${slide.id}/elements/-`, value: text(lowerId, 700, "Read second") },
          { op: "add", path: `/slides/id:${slide.id}/elements/-`, value: text(upperId, 520, "Read first") },
        ],
      }),
    }) as { version_id: string };

    await page!.goto(`${WEB}/edit/${created.presentation_id}`, { waitUntil: "domcontentloaded" });
    await page!.getByTestId("tool-check").waitFor({ timeout: 60_000 });
    // Browser zoom changes layout and text sizing while preserving the same
    // keyboard path a person uses at WCAG 1.4.4's required scale.
    await page!.evaluate(() => { document.documentElement.style.zoom = "200%"; });

    let reachedCheck = false;
    // A populated technical template exposes its slide/element controls first;
    // keep this as a genuine traversal instead of programmatically focusing the
    // target. The current fixture reaches Design Check at roughly 100 stops.
    for (let step = 0; step < 160; step += 1) {
      await page!.keyboard.press("Tab");
      reachedCheck = await page!.getByTestId("tool-check").evaluate((node) => node === document.activeElement);
      if (reachedCheck) break;
    }
    expect(reachedCheck, "Design Check must be reachable by keyboard").toBe(true);
    await page!.keyboard.press("Enter");
    await page!.getByRole("region", { name: "Design check" }).waitFor();

    const response = page!.waitForResponse((item) =>
      item.url().endsWith(`/v1/presentations/${created.presentation_id}/transactions`) && item.request().method() === "POST",
    );
    const fix = page!.getByRole("button", { name: "Match the visual order" }).first();
    await fix.focus();
    await page!.keyboard.press("Enter");
    expect((await response).status()).toBe(200);

    const after = await request(`/v1/presentations/${created.presentation_id}`) as {
      version_id: string;
      document: { slides: Array<{ id: string; elements: Array<{ id: string; metadata?: { a11yOrder?: number } }> }> };
    };
    expect(after.version_id).not.toBe(saved.version_id);
    const elements = after.document.slides.find((candidate) => candidate.id === slide.id)!.elements;
    expect(elements.map((element) => element.id)).toEqual([...originalLayers, lowerId, upperId]);
    expect(elements.find((element) => element.id === upperId)!.metadata?.a11yOrder)
      .toBeLessThan(elements.find((element) => element.id === lowerId)!.metadata?.a11yOrder ?? Number.POSITIVE_INFINITY);

    await page!.reload({ waitUntil: "domcontentloaded" });
    await page!.getByTestId("tool-check").waitFor({ timeout: 60_000 });
    const reloaded = await request(`/v1/presentations/${created.presentation_id}`) as typeof after;
    expect(reloaded.version_id).toBe(after.version_id);
  }, 180_000);
});

