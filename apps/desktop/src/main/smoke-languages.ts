import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

import { capture, trustedClick, until } from "./smoke";

/**
 * The acceptance steps for integration plan 01: a deck in another language, and
 * a deck that narrates itself. Both work on a deck of their own and delete it
 * afterwards, so a run never changes anyone's work.
 *
 * `languages`: add Hindi from the Languages panel, translate it (the keyless
 * stand-in in a checkout), apply the proposal, switch the canvas to Hindi with
 * the bar's menu, check the saved source words are untouched, and export a PDF
 * in Hindi for `pypdf` to read.
 *
 * `narration`: a slide with three click reveals, a narration line per step typed
 * into the Motion panel, voiced (the stand-in), the deck set to play itself,
 * then present mode — which must reach the last reveal with nobody pressing a
 * key — and a PowerPoint export carrying the recordings.
 */

interface Kit {
  page: <T = unknown>(js: string) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  need: (what: string, expression: string, timeoutMs?: number) => Promise<void>;
  press: (testId: string) => Promise<void>;
  pressText: (selector: string, text: string | RegExp) => Promise<void>;
  stored: (id: string) => Promise<Record<string, any>>;
  settle: () => Promise<void>;
  openSection: (title: RegExp) => Promise<void>;
  newDeck: () => Promise<{ original: string; created: string }>;
  commit: (id: string, operations: unknown[]) => Promise<void>;
  exportTo: (id: string, kind: "pdf" | "pptx", file: string, locale?: string) => Promise<number>;
  cleanup: (created: string, original: string) => Promise<void>;
}

function kit(window: BrowserWindow, name: string): Kit {
  const page = <T = unknown>(js: string) => window.webContents.executeJavaScript(js) as Promise<T>;
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const need = async (what: string, expression: string, timeoutMs = 15_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`${name}: ${what}`);
  };
  const press = (testId: string) => trustedClick(window, `[data-testid="${testId}"]`);
  const pressText = async (selector: string, text: string | RegExp) => {
    const tag = `smoke-${Math.random().toString(36).slice(2)}`;
    const found = await page<boolean>(`(() => {
      const wanted = ${text instanceof RegExp ? text.toString() : JSON.stringify(text)};
      const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => {
        const words = (node.textContent || "").trim();
        return typeof wanted === "string" ? words === wanted : wanted.test(words);
      });
      if (!hit) return false;
      hit.setAttribute("data-smoke-target", ${JSON.stringify(tag)});
      return true;
    })()`);
    if (!found) throw new Error(`${name}: no ${selector} reading ${String(text)}`);
    await trustedClick(window, `[data-smoke-target="${tag}"]`);
  };
  const current = async () => (await page<{ presentationId: string }>(`window.deckastra.currentPresentation()`)).presentationId;
  const stored = (id: string) =>
    page<Record<string, any>>(`fetch("/__api/v1/presentations/${id}").then((r) => r.json()).then((j) => ({ ...j.document, __version: j.version_id }))`);
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 3; i += 1) {
      if (i > 150) throw new Error(`${name}: the edits never finished saving`);
      await sleep(200);
      const status = await page<string | null>(`document.querySelector("[data-save-status]")?.getAttribute("data-save-status") ?? null`);
      quiet = status === "saved" || status === "updated" || status === "idle" ? quiet + 1 : 0;
    }
  };
  const openSection = async (title: RegExp) => {
    const open = await page<boolean>(`(() => {
      const toggle = [...document.querySelectorAll(".dk-section__toggle")].find((b) => ${title.toString()}.test((b.textContent || "").trim()));
      return toggle ? toggle.getAttribute("aria-expanded") === "true" : false;
    })()`);
    if (!open) await pressText(".dk-section__toggle", title);
  };
  const newDeck = async () => {
    await need("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
    const original = await current();
    await press("open-deck-list");
    await need("the deck list never offered New deck", `document.querySelector('[data-testid="new-deck"]') && !document.querySelector('[data-testid="new-deck"]').disabled`, 20_000);
    await press("new-deck");
    let created = original;
    for (let i = 0; i < 120 && created === original; i += 1) {
      await sleep(250);
      created = await current();
    }
    if (created === original) throw new Error(`${name}: New deck did not open a deck`);
    // Main updates its id before React finishes reading/mounting the deck.
    // Committing while that read is in flight can cache the preceding version.
    await need("the new deck never opened in the editor", `document.querySelector('[data-presentation-id="${created}"] [data-editor-canvas]')`, 20_000);
    return { original, created };
  };
  // A change made "elsewhere", through the service, as an agent's would be: the
  // editor's head watcher takes it in. Content for the step to work on.
  const commit = async (id: string, operations: unknown[]) => {
    const head = await stored(id);
    const body = JSON.stringify({ operations, intent: "Smoke content", expected_version_id: head.__version });
    const answer = await page<{ version_id?: string; detail?: unknown }>(
      `fetch("/__api/v1/presentations/${id}/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(body)} }).then((r) => r.json())`,
    );
    if (!answer.version_id) throw new Error(`${name}: the content could not be committed: ${JSON.stringify(answer)}`);
    // Wait for the open editor to take it in.
    await need("the editor never showed the committed content", `document.querySelector('[data-presentation-id="${id}"][data-document-version="${answer.version_id}"]') && document.querySelectorAll("[data-editor-canvas] [data-element-id]").length > 0`, 20_000);
  };
  const exportTo = async (id: string, kind: "pdf" | "pptx", file: string, locale?: string) => {
    const started = await page<{ id?: string }>(
      `fetch("/__api/v1/presentations/${id}/exports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify({ kind, ...(locale ? { locale } : {}) })}) }).then((r) => r.json())`,
    );
    if (!started.id) throw new Error(`${name}: the ${kind} export was refused: ${JSON.stringify(started)}`);
    let status = "";
    for (let i = 0; i < 360 && !["completed", "failed", "cancelled"].includes(status); i += 1) {
      await sleep(500);
      status = (await page<{ status: string }>(`fetch("/__api/v1/exports/${started.id}").then((r) => r.json())`)).status;
    }
    if (status !== "completed") throw new Error(`${name}: the ${kind} export ended ${status || "never"}`);
    const base64 = await page<string>(
      `fetch("/__api/v1/exports/${started.id}/download").then((r) => r.arrayBuffer()).then((b) => { let s = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 1) s += String.fromCharCode(u[i]); return btoa(s); })`,
    );
    const bytes = Buffer.from(base64, "base64");
    await writeFile(file, bytes);
    return bytes.length;
  };
  const cleanup = async (created: string, original: string) => {
    await page(`fetch("/__api/v1/presentations/${created}", { method: "DELETE" }).then((r) => r.status)`).catch(() => undefined);
    await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(original)} })`).catch(() => undefined);
  };
  return { page, sleep, need, press, pressText, stored, settle, openSection, newDeck, commit, exportTo, cleanup };
}

const ID = (prefix: string, n: number) => `${prefix}_01JB8Z9K2QW4RN7F3XSM0KE${String(n).padStart(3, "0")}`;

function textElement(id: string, block: string, words: string, y: number, size: number) {
  return {
    id,
    type: "text",
    transform: { x: 160, y, width: 1500, height: size * 1.8 },
    content: { version: 1, blocks: [{ id: block, type: "paragraph", spans: [{ text: words }] }] },
    typography: { fontFamily: "token:typography.body.fontFamily", fontSize: size, color: "token:colors.foreground" },
  };
}

export async function runLanguages(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  try {
    await runLanguagesInner(window, dir, record);
  } catch (error) {
    // A picture of where it stopped: a failed UI step that cannot say what it
    // was looking at is a failure nobody can act on.
    await capture(window, join(dir, "languages-failure.png")).catch(() => undefined);
    throw error;
  }
}

async function runLanguagesInner(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const k = kit(window, "languages");
  const { original, created } = await k.newDeck();
  record.created = created;
  try {
    const deck = await k.stored(created);
    const slide = deck.slides[0].id as string;
    const headline = ID("el", 1);
    await k.commit(created, [
      { op: "add", path: `/slides/id:${slide}/elements/-`, value: textElement(headline, ID("blk", 1), "Welcome to the quarterly review", 200, 72) },
      { op: "add", path: `/slides/id:${slide}/elements/-`, value: textElement(ID("el", 2), ID("blk", 2), "Revenue grew 42% in Q3", 480, 40) },
    ]);
    await k.settle();

    // Add Hindi from the bar's language menu, through the Languages panel.
    await k.press("language-menu");
    await k.pressText('[role="menuitem"], [role="menuitemradio"]', /^Add or manage languages/);
    await k.need("the Languages panel did not open", `document.querySelector('[data-testid="languages-panel"]')`, 10_000);
    // Say where it arrived: whether the list opened, and what it offered, so a
    // failure here names its cause instead of only "no option".
    const hindiOffered = `[...document.querySelectorAll('[role="option"]')].some((node) => /^Hindi/.test(node.textContent ?? ""))`;
    const opens: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await k.press("add-language-select");
      const offered = await until(window, hindiOffered, 5_000);
      opens.push(
        await k.page<Record<string, unknown>>(`({
          offered: ${offered},
          expanded: document.querySelector('[data-testid="add-language-select"]')?.getAttribute("aria-expanded"),
          options: [...document.querySelectorAll('[role="option"]')].slice(0, 4).map((node) => node.textContent),
          saveStatus: document.querySelector('[data-testid="save-status"]')?.textContent ?? null,
        })`),
      );
      if (offered) break;
    }
    record.languageSelectOpens = opens;
    await k.pressText('[role="option"]', /^Hindi/);
    await k.press("add-language");
    await k.settle();
    let stored = await k.stored(created);
    if (!stored.locales?.["hi-IN"]) throw new Error("languages: adding Hindi did not store an overlay");

    // Translate what is missing; a small translation may apply at once, a
    // larger one waits in Pending changes with its pictures.
    await k.need("Translate missing was not offered", `document.querySelector('[data-testid="translate-missing-hi-IN"]') && !document.querySelector('[data-testid="translate-missing-hi-IN"]').disabled`, 10_000);
    await k.press("translate-missing-hi-IN");
    await k.need("the translation never came back", `document.querySelector('[data-testid="languages-message"]')`, 60_000);
    if (await k.page<boolean>(`document.querySelector('[data-testid="translate-missing-hi-IN"]')?.textContent?.includes('Confirm translation') === true`)) {
      await k.press("translate-missing-hi-IN");
      await k.need("the confirmed translation never came back", `!document.querySelector('[data-testid="translate-missing-hi-IN"]')?.textContent?.includes('Confirm translation')`, 60_000);
    }
    record.translateMessage = await k.page<string>(`document.querySelector('[data-testid="languages-message"]').textContent`);
    if (await k.page<boolean>(`Boolean(document.querySelector('[data-testid="proposal-apply"]'))`)) {
      await k.need("the proposal's After picture never drew", `document.querySelector('[data-testid="proposal-after"] [data-final-frame]')`, 15_000);
      await capture(window, join(dir, "languages-proposal.png"));
      await k.press("proposal-apply");
      await k.need("applying the translation did not clear the card", `!document.querySelector('[data-testid="proposal-card"]')`, 20_000);
    }
    await k.settle();
    stored = await k.stored(created);
    const entries = Object.keys(stored.locales["hi-IN"].entries);
    if (entries.length < 3) throw new Error(`languages: only ${entries.length} Hindi entries were stored`);
    record.entries = entries.length;

    // Show Hindi on the canvas: the words change, the saved source does not.
    await k.press("language-menu");
    await k.pressText('[role="menuitemradio"], [role="menuitem"]', /^Hindi/);
    await k.need("the locale banner did not say Hindi is showing", `document.querySelector('[data-testid="locale-banner"]')`, 10_000);
    // Hindi from whichever translator ran: the stand-in marks its words
    // "[hi-IN] …", a real one writes Devanagari. Either way not the English.
    const hindiShown = `[...document.querySelectorAll("[data-editor-canvas] [data-plain-text]")].map((n) => n.getAttribute("data-plain-text") ?? "").filter((text) => text !== "Welcome to the quarterly review" && (text.startsWith("[hi-IN]") || /[\\u0900-\\u097F]/.test(text)))`;
    await k.need("the canvas does not show the Hindi words", `${hindiShown}.length > 0`, 10_000);
    record.hindiWords = await k.page<string[]>(hindiShown);
    await capture(window, join(dir, "languages-hindi.png"));
    stored = await k.stored(created);
    const words = stored.slides[0].elements.find((element: any) => element.id === headline).content.blocks[0].spans[0].text;
    if (words !== "Welcome to the quarterly review") throw new Error(`languages: showing Hindi changed the saved source to ${JSON.stringify(words)}`);
    record.sourceKept = true;

    record.pdfBytes = await k.exportTo(created, "pdf", join(dir, "languages.pdf"), "hi-IN");
    await k.press("locale-banner-original");
    await k.need("Show original did not return to English", `!document.querySelector('[data-testid="locale-banner"]')`, 10_000);
  } finally {
    await k.cleanup(created, original);
  }
}

export async function runNarration(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  try {
    await runNarrationInner(window, dir, record);
  } catch (error) {
    // A picture of where it stopped: a failed UI step that cannot say what it
    // was looking at is a failure nobody can act on.
    await capture(window, join(dir, "narration-failure.png")).catch(() => undefined);
    throw error;
  }
}

async function runNarrationInner(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const k = kit(window, "narration");
  const { original, created } = await k.newDeck();
  record.created = created;
  try {
    const deck = await k.stored(created);
    const slide = deck.slides[0].id as string;
    const bullets = [ID("el", 11), ID("el", 12), ID("el", 13)];
    await k.commit(created, [
      { op: "add", path: `/slides/id:${slide}/elements/-`, value: textElement(ID("el", 10), ID("blk", 10), "Three steps", 120, 72) },
      ...bullets.map((id, index) => ({
        op: "add",
        path: `/slides/id:${slide}/elements/-`,
        value: textElement(id, ID("blk", 11 + index), ["Write it", "Translate it", "Narrate it"][index]!, 360 + index * 140, 44),
      })),
      {
        op: "add",
        path: `/slides/id:${slide}/animations`,
        value: bullets.map((id, index) => ({
          id: ID("anm", index + 1),
          targetId: id,
          trigger: { type: "click" },
          clips: [{ id: ID("clp", index + 1), preset: "fade", startMs: 0, durationMs: 300 }],
        })),
      },
    ]);
    await k.settle();

    // A line per step, typed into the Motion panel.
    // The assistant (where Languages lives) sits over the mode's own panel.
    await k.page(`document.querySelector('[data-testid="close-assistant"]')?.click()`);
    await k.press("mode-motion");
    await k.need("the narration panel did not appear", `document.querySelectorAll('[data-testid="narration-step"]').length === 4`, 10_000);
    const lines = ["Three steps make this work.", "First, write it.", "Then translate it.", "Finally, narrate it."];
    for (let step = 0; step < 4; step += 1) {
      await k.press(`add-narration-${step}`);
      await k.need(`the line for step ${step} did not appear`, `document.querySelectorAll('[data-testid="narration-step"][data-step="${step}"] textarea').length === 1`, 10_000);
      await trustedClick(window, `[data-testid="narration-step"][data-step="${step}"] textarea`);
      await window.webContents.insertText(lines[step]!);
      // Blur commits the line.
      await trustedClick(window, `[data-testid="narration-step"][data-step="${step}"] .dk-narration__step-title`);
      await k.settle();
    }
    let stored = await k.stored(created);
    const cues = stored.slides[0].narration?.cues ?? [];
    if (cues.map((cue: any) => cue.text).join("|") !== lines.join("|")) throw new Error(`narration: the stored lines are ${JSON.stringify(cues)}`);

    // Voiced by the stand-in, as a proposal.
    await k.press("narration-voice");
    await k.need("voicing never answered", `document.querySelector('[data-testid="narration-message"]')`, 60_000);
    if (await k.page<boolean>(`document.querySelector('[data-testid="narration-voice"]')?.textContent?.includes('Confirm voice') === true`)) {
      await k.press("narration-voice");
      await k.need("confirmed voicing never answered", `!document.querySelector('[data-testid="narration-voice"]')?.textContent?.includes('Confirm voice')`, 60_000);
      // The quote's message is replaced by the result's, and between the two
      // there is a moment with neither; reading it then threw.
      await k.need("voicing never reported its result", `document.querySelector('[data-testid="narration-message"]')`, 60_000);
    }
    record.voiceMessage = await k.page<string | null>(`document.querySelector('[data-testid="narration-message"]')?.textContent ?? null`);
    stored = await k.stored(created);
    if (!stored.slides[0].narration.cues.every((cue: any) => cue.takes?.en)) {
      await k.press("open-assistant");
      await k.need("the voices did not arrive as a proposal", `document.querySelector('[data-testid="proposal-apply"]')`, 20_000);
      await k.press("proposal-apply");
      await k.need("applying the voices did not clear the card", `!document.querySelector('[data-testid="proposal-card"]')`, 20_000);
      await k.settle();
      await k.press("close-assistant");
      await k.press("mode-motion");
    }
    stored = await k.stored(created);
    const takes = stored.slides[0].narration.cues.map((cue: any) => cue.takes?.en?.durationMs ?? 0);
    if (takes.some((ms: number) => !(ms > 0))) throw new Error(`narration: takes are missing: ${JSON.stringify(takes)}`);
    record.takeDurations = takes;

    // Plays itself.
    await k.need("the playback switch is not there", `document.querySelector('[aria-label="How the deck plays"]')`, 10_000);
    await k.pressText('[aria-label="How the deck plays"] [role="radio"]', "Plays itself");
    await k.settle();
    if ((await k.stored(created)).playback?.mode !== "narrated") throw new Error("narration: the deck is not stored as narrated");
    await k.need("the audio lanes did not draw", `document.querySelectorAll('[data-testid="narration-bar"]').length === 4`, 10_000);
    await capture(window, join(dir, "narration-editor.png"));

    // Present: the reveals must arrive with nobody pressing anything.
    await k.press("present");
    await k.need("present mode did not open", `document.querySelector("[data-present-slide-id]")`, 15_000);
    await k.need("present mode does not say it is narrated", `document.querySelector('[data-present-playback="narrated"]')`, 5_000);
    const total = takes.reduce((sum: number, ms: number) => sum + ms, 0) + 4 * 1500;
    await k.need(
      "the narrated deck never reached its last reveal on its own",
      `Number(document.querySelector("[data-present-step]")?.getAttribute("data-present-step")) === 3`,
      total + 10_000,
    );
    record.reachedLastStepUnaided = true;
    await capture(window, join(dir, "narration-present.png"));
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" } as Electron.KeyboardInputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" } as Electron.KeyboardInputEvent);
    await k.need("present mode did not close", `document.querySelector("[data-editor-canvas]")`, 10_000);

    // Recorded through the microphone: the permission handler, MediaRecorder,
    // the WAV re-encode and the upload, the path a person takes. Chromium's fake
    // device stands in for the hardware (see app.ts).
    const cueId = stored.slides[0].narration.cues[1].id as string;
    const button = `[data-cue-id="${cueId}"] [data-testid="narration-record"]`;
    await trustedClick(window, button);
    await k.need("recording did not start", `document.querySelector('${button}')?.getAttribute("aria-label") === "Stop and keep the recording"`, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await trustedClick(window, button);
    let recorded: any;
    for (let tries = 0; tries < 40 && !recorded; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const take = (await k.stored(created)).slides[0].narration.cues[1].takes?.en;
      if (take?.voice === "recorded") recorded = take;
    }
    if (!recorded) {
      const said = await k.page<string>(`document.querySelector('[data-testid="narration-message"]')?.textContent ?? ""`);
      throw new Error(`narration: the microphone take never arrived in the store (${said})`);
    }
    // Measured from the file the browser made, so it is near what was held, not what was asked.
    if (!(recorded.durationMs > 1_000 && recorded.durationMs < 5_000)) throw new Error(`narration: the recording measured ${recorded.durationMs}ms`);
    record.microphoneTakeMs = recorded.durationMs;

    // Speech controls. A pause, pressed into the first line where the caret is:
    // stored as a marker in the script, hidden from the timeline's card.
    const firstCue = stored.slides[0].narration.cues[0].id as string;
    await trustedClick(window, `[data-cue-id="${firstCue}"] textarea`);
    await trustedClick(window, `[data-cue-id="${firstCue}"] [data-testid="narration-pause"]`);
    let pausedText = "";
    for (let tries = 0; tries < 20 && !pausedText.includes("[pause]"); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      pausedText = (await k.stored(created)).slides[0].narration.cues[0].text as string;
    }
    if (!pausedText.includes("[pause]")) throw new Error(`narration: the Pause button wrote nothing (${JSON.stringify(pausedText)})`);
    record.pausedScript = pausedText;
    const cardText = await k.page<string>(`[...document.querySelectorAll('[data-testid="narration-bar"]')].map((bar) => bar.textContent).join(" | ")`);
    if (cardText.includes("[pause")) throw new Error(`narration: the timeline shows the pause marker: ${cardText}`);

    // A faster rate makes the voiced lines due again — three of them: the second
    // line holds the microphone take, which no rate changes.
    await trustedClick(window, '[data-testid="narration-rate"]');
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('[data-testid="narration-rate"]'); input.select(); return true; })()`);
    await window.webContents.insertText("1.2");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" } as Electron.KeyboardInputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" } as Electron.KeyboardInputEvent);
    await k.need(
      "a faster rate did not make the voiced lines due",
      `/Voice 3 lines/.test(document.querySelector('[data-testid="narration-voice"]')?.textContent ?? "")`,
      10_000,
    );
    record.voiceAfterRate = await k.page<string>(`document.querySelector('[data-testid="narration-voice"]').textContent`);

    record.pptxBytes = await k.exportTo(created, "pptx", join(dir, "narration.pptx"));
  } finally {
    await k.cleanup(created, original);
  }
}
