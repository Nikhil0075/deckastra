import { deflateSync } from "node:zlib";
import { runLanguages, runNarration } from "./smoke-languages";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ClipboardItem, Menu, clipboard } from "electron";

import { buildManifest } from "./build-manifest";

import { ATTACHMENT_VERSION, type Attachment } from "./attachment";
import { buildLargeDeck, type PerfAsset } from "./large-deck";
// From `/perf` rather than the package root: the root pulls in the scene
// builder and the schema, and the schema pulls in `ulid`, whose PRNG
// detection throws at import time in Electron's main process. That took the
// whole app down before it opened a window (2026-09-20). This module is
// budgets, a stopwatch and a frame sampler, and imports nothing.
import { FrameSampler, checkBudget, checkFrameBudget } from "@deckastra/renderer/perf";

/**
 * The D0 acceptance harness.
 *
 * D0's exit gate is a claim about an *installed application* — it opens the
 * fixture, edits it, saves, restarts with the edit intact, and presents in a
 * second window, all with no dev server. None of that can be asserted from a unit
 * test, and a gate nobody can run is a gate that is already off. So the shell can
 * drive itself: `DECKASTRA_SMOKE_DIR` makes it perform one named step, write down
 * what it found, capture the window, and quit.
 *
 * It is inert without that variable, it never runs in a packaged build's normal
 * path, and it grants the page nothing — every observation below is made *from
 * the main process* against the rendered DOM, exactly as an external driver
 * would. It is a test harness that happens to live inside the binary it tests,
 * because that is the only place with a handle on the window.
 */

export type SmokeStep =
  | "open"
  | "edit"
  | "verify"
  | "present"
  | "digest"
  | "export"
  | "resilience"
  | "windows"
  | "consent"
  | "morph"
  | "timeline"
  | "slides"
  | "presenter"
  | "decks"
  | "history"
  | "ai"
  | "motion"
  | "a11y"
  | "menu"
  | "close"
  | "close-verify"
  | "backup"
  | "grants"
  | "performance"
  | "intelligence"
  | "authoring"
  | "design"
  | "handoff"
  | "languages"
  | "narration";

/**
 * What the harness may do to the app, beyond driving its UI.
 *
 * Only two things, and both are about the *service*: a crash test cannot be
 * written from inside the page, because the page is the thing that has to survive
 * it. Supplied by `index.ts` rather than reached for, so the harness has no
 * handle on the child process itself.
 */
export interface SmokeControls {
  stopService: () => Promise<void>;
  startService: () => Promise<void>;
  openEditorWindow: () => BrowserWindow;
  /**
   * Start this same application again and wait for it to give up (item 25).
   *
   * The single-instance lock is a claim about a *second process*, so nothing
   * inside this one can check it. It used to sit at the bottom of `index.ts`,
   * which quit the second instance correctly and then let its startup run
   * anyway — withdrawing the first instance's attachment on the way out, so an
   * attached agent lost access because somebody double-clicked the icon.
   */
  launchSecondInstance: () => Promise<{ exitCode: number | null; ms: number }>;
  /**
   * Write the report Help > Export diagnostics writes, to a path the harness
   * chooses. The menu item itself opens a native save dialog, which nothing can
   * answer here; what is worth checking is the report, not the dialog.
   */
  writeDiagnostics: (file: string) => Promise<number>;
  /**
   * Back up to, and restore from, a folder the harness chooses (item 14). The
   * menu items open native folder pickers, which nothing can answer here; what
   * is worth checking is that the decks come back.
   */
  backUpTo: (destination: string) => Promise<{ counts?: Record<string, number>; missing_assets?: unknown[] }>;
  restoreFrom: (source: string) => Promise<{ restored: boolean; migrated?: boolean; error?: string; replaced?: string; counts?: Record<string, number> }>;
}

export function smokeDir(): string | undefined {
  return process.env.DECKASTRA_SMOKE_DIR || undefined;
}

function step(): SmokeStep {
  return (process.env.DECKASTRA_SMOKE_STEP as SmokeStep) || "open";
}

/** Poll the rendered page until `predicate` holds, or give up and say so. */
export async function until(
  window: BrowserWindow,
  expression: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const met = await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false);
    if (met) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * What the page can tell us about itself.
 *
 * The origin, storage and lock checks are here because they are the reason the
 * renderer is served from a custom scheme rather than `file://`. If any of them
 * regresses, the recovery journal stops working and nothing else looks wrong.
 */
const OBSERVE = `(async () => {
  const buttons = [...document.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(Boolean);
  let storage = "unavailable";
  try { localStorage.setItem("__smoke", "1"); localStorage.removeItem("__smoke"); storage = "ok"; }
  catch (error) { storage = "failed: " + error.message; }

  // The offline claim, tested rather than asserted. The CSP carries no
  // \`connect-src\`, so the page cannot reach the network at all — which is both
  // the reason this build works on a plane and the reason a malicious deck cannot
  // use the renderer as an SSRF primitive.
  let network = "reached the network";
  try { await fetch("https://example.com/", { mode: "no-cors" }); }
  catch (error) { network = "blocked: " + error.message; }
  return {
    title: document.title,
    origin: location.origin,
    secureContext: window.isSecureContext,
    storage,
    webLocks: typeof navigator.locks,
    broadcastChannel: typeof BroadcastChannel,
    bridge: typeof window.deckastra,
    elements: document.querySelectorAll("[data-element-id]").length,
    canvas: Boolean(document.querySelector("[data-editor-canvas]")),
    status: [...document.querySelectorAll("[role=status]")].map(n => n.textContent?.trim()),
    buttons: buttons.slice(0, 24),
    network,
    bodyText: document.body.innerText.slice(0, 400),
  };
})()`;

/**
 * Everything the renderer said, and how it died if it did.
 *
 * A blank window with a zero element count is the least diagnosable failure this
 * app can produce, and it happened once — the harness recorded "0 elements" and
 * nothing about why. Console output and `render-process-gone` are the two things
 * that would have named it immediately.
 */
function watchRenderer(window: BrowserWindow, record: Record<string, unknown>): void {
  const console: string[] = [];
  record.console = console;

  const violations: string[] = [];
  record.cspViolations = violations;

  // Electron 44's event object, not the positional arguments it deprecated.
  window.webContents.on("console-message", (event) => {
    const { level, message, lineNumber: line, sourceId: source } = event;
    if (console.length < 60) console.push(`[${level}] ${message} (${source}:${line})`);
    // Recorded separately and asserted on below. A malformed directive and a
    // blocked stylesheet both look like nothing until someone reads the console,
    // and the app ran unthemed for a whole milestone because nobody did.
    // The offline probe below deliberately trips `connect-src`, and that refusal
    // is the assertion passing rather than a defect. Everything else is a real
    // violation.
    const deliberate = message.includes("example.com");
    if (!deliberate && /Content Security Policy|Refused to (load|apply|execute)/i.test(message)) {
      violations.push(message.slice(0, 300));
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    record.rendererGone = details;
  });
  window.webContents.on("unresponsive", () => {
    record.rendererUnresponsive = true;
  });
}

export async function runSmoke(
  window: BrowserWindow,
  dir: string,
  controls: SmokeControls,
): Promise<void> {
  const current = step();
  const record: Record<string, unknown> = {
    step: current,
    startedAt: new Date().toISOString(),
    packaged: app.isPackaged,
    // Which build this result is about (item 06). A record that does not say is
    // evidence about nothing in particular.
    appVersion: app.getVersion(),
    // Which source and which payloads (item 07). A record that cannot be traced
    // back to a build is evidence about nothing in particular.
    build: await buildManifest().then((manifest) =>
      manifest
        ? {
            commit: manifest.source.commit,
            dirty: manifest.source.dirty,
            treeSha256: manifest.source.treeSha256,
            payloads: Object.fromEntries(
              Object.entries(manifest.payloads).map(([name, value]) => [name, value?.sha256 ?? null]),
            ),
            migrations: manifest.migrations?.sha256 ?? null,
          }
        : null,
    ),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    // Uptime rather than a wall clock: this is time since the process began, which
    // is what "cold start" means to someone double-clicking an icon.
    msToWindow: Math.round(process.uptime() * 1000),
  };

  watchRenderer(window, record);

  // The first-run notice is modal, and on a fresh profile every step meets it.
  // Wait for the notice *or* its durable seen flag. A fixed five-second wait
  // raced a delayed mount, after which programmatic clicks operated through the
  // modal and produced a green result with a visibly covered screenshot.
  await until(
    window,
    `document.querySelector('[data-testid="first-run-dismiss"]') || localStorage.getItem("deckastra.intro.v1")`,
    30_000,
  );
  record.firstRunNotice = await window.webContents.executeJavaScript(
    `Boolean(document.querySelector('[data-testid="first-run-dismiss"]'))`,
  );
  record.inputMode = "electron-sendInputEvent";
  if (record.firstRunNotice) {
    await trustedClick(window, '[data-testid="first-run-dismiss"]');
    if (!(await until(window, `!document.querySelector('[data-testid="first-run"]')`, 5_000))) {
      throw new Error("The first-run notice did not close after trusted pointer input.");
    }
  }

  // `close` ends the way a person ends a session — through the window or the
  // application quitting — so it must not reach the `app.exit()` below, which
  // skips every shutdown handler this step exists to exercise.
  if (current === "close") {
    await runClose(window, dir, record, controls);
    return;
  }

  try {
    await mkdir(dir, { recursive: true });

    if (current === "digest") {
      await runDigest(window, record);
    } else if (current === "resilience") {
      await runResilience(window, dir, record, controls);
    } else if (current === "timeline") {
      await runTimeline(window, record);
    } else if (current === "slides") {
      await runSlides(window, record);
    } else if (current === "presenter") {
      await runPresenter(window, dir, record);
    } else if (current === "decks") {
      await runDecks(window, dir, record);
    } else if (current === "history") {
      await runHistory(window, record);
    } else if (current === "ai") {
      await runAi(window, dir, record);
    } else if (current === "motion") {
      await runMotion(window, dir, record);
    } else if (current === "a11y") {
      await runA11y(window, dir, record);
    } else if (current === "performance") {
      await runPerformance(window, dir, record);
    } else if (current === "grants") {
      await runGrants(window, dir, record, controls);
    } else if (current === "backup") {
      await runBackup(window, dir, record, controls);
    } else if (current === "menu") {
      await runMenu(window, dir, record, controls);
    } else if (current === "handoff") {
      await runHandoff(window, dir, record);
    } else if (current === "authoring") {
      await runAuthoring(window, dir, record);
    } else if (current === "design") {
      await runDesign(window, dir, record);
    } else if (current === "languages") {
      await runLanguages(window, dir, record);
    } else if (current === "narration") {
      await runNarration(window, dir, record);
    } else if (current === "intelligence") {
      await runIntelligence(window, record);
    } else if (current === "close-verify") {
      await runCloseVerify(window, dir, record);
    } else if (current === "morph") {
      await runMorph(window, record);
    } else if (current === "consent") {
      await runConsent(window, record);
    } else if (current === "windows") {
      await runWindows(window, record, controls);
    } else if (current === "export") {
      await runExport(window, dir, record);
    } else if (current === "present") {
      await runPresent(window, dir, record);
    } else {
      await runEditor(window, dir, current, record);
    }
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }

  const violations = (record.cspViolations as string[]) ?? [];
  if (record.ok && violations.length > 0) {
    record.ok = false;
    record.error = `The page reported ${violations.length} content-security-policy problem(s): ${violations[0]}`;
  }

  record.memory = memoryReport();

  // **Stop the service before exiting, because `app.exit()` will not.** Electron
  // skips `before-quit` and `will-quit` entirely on `exit()`, and those are where
  // the sidecar is shut down — so every smoke step orphaned its Python child,
  // which then held the database file, the port and the single-instance lock. An
  // independent run (2026-09-17) hit exactly that: the verify step wrote its
  // record and closed its window, and the next step could not start because the
  // previous one's processes were still there.
  //
  // The window is written down rather than swallowed: a step that could not
  // release its service is a step whose result the next one should not trust.
  try {
    await controls.stopService();
    record.serviceStopped = true;
  } catch (error) {
    record.serviceStopped = false;
    record.serviceStopError = error instanceof Error ? error.message : String(error);
  }

  record.finishedAt = new Date().toISOString();
  await writeFile(join(dir, `${current}.json`), JSON.stringify(record, null, 2), "utf8");
  app.exit(record.ok ? 0 : 1);
}

async function runEditor(
  window: BrowserWindow,
  dir: string,
  current: SmokeStep,
  record: Record<string, unknown>,
): Promise<void> {
  record.canvasAppeared = await until(window, `document.querySelector("[data-editor-canvas]")`);
  // The number the D0 go/no-go actually turns on: process start to a deck the
  // user could edit. Not "window shown", which happens long before anything is
  // on it.
  record.msToEditableDeck = Math.round(process.uptime() * 1000);
  record.before = await window.webContents.executeJavaScript(OBSERVE);

  // Recorded first, then enforced. A run where the editor never appeared once
  // reported `ok: true` with an error banner on screen and zero elements — a
  // harness that passes when it saw nothing is worse than no harness.
  if (!record.canvasAppeared) {
    throw new Error(
      `The editor never appeared. On screen: ${String((record.before as { bodyText?: string }).bodyText ?? "").slice(0, 300)}`,
    );
  }

  if (current === "edit") {
    // Driven through the real toolbar rather than through the client, so the
    // whole path is under test: React → editor → patch → transaction → the IPC
    // bridge → the file on disk.
    const clicked = await window.webContents.executeJavaScript(ADD_RECTANGLE);
    record.clickedAddRect = clicked;

    // "Saved" is the editor's own acknowledgement, and the acknowledgement is the
    // only thing that means the bytes reached the disk.
    record.reportedSaved = await until(
      window,
      `document.body.innerText.includes("Saved")`,
      20_000,
    );
    record.after = await window.webContents.executeJavaScript(OBSERVE);
  }

  await capture(window, join(dir, `${current}.png`));
}

async function runPresent(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);

  const clickByText = (label: string) => `(() => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`;

  record.enteredPresent = await window.webContents.executeJavaScript(clickTestId("present"));
  await until(window, `document.body.innerText.includes("Second screen")`);

  const before = BrowserWindow.getAllWindows().length;
  record.openedSecondScreen = await window.webContents.executeJavaScript(clickByText("Second screen"));

  // The real assertion: the main process actually holds a second window. Asking
  // the page whether it opened one would only report what it tried to do.
  const opened = await waitFor(() => BrowserWindow.getAllWindows().length > before);
  record.windowCountBefore = before;
  record.windowCountAfter = BrowserWindow.getAllWindows().length;
  record.presenterWindowOpened = opened;

  await capture(window, join(dir, "present-audience.png"));

  const presenter = BrowserWindow.getAllWindows().find((w) => w.id !== window.id);
  if (presenter) {
    await until(presenter, `document.body.innerText.length > 0`, 15_000);
    record.presenter = await presenter.webContents.executeJavaScript(OBSERVE);
    await capture(presenter, join(dir, "present-presenter.png"));
  }
}

/**
 * The presenter window drives the projector (Phase 3).
 *
 * Two real windows, the real BroadcastChannel between them. The claims:
 *
 * - Next pressed **on the laptop** reveals the next bullet **on the projector**
 *   and does not change slide — the presenter window sends a command, the
 *   audience window (which plays the motion) carries it out.
 * - The laptop then shows the step the projector is on.
 * - Black screen on the laptop blacks the projector out, and says so on the
 *   laptop; pressing it again brings the slide back.
 *
 * Each is read from the window it is about: the projector's state from its
 * `data-present-*` attributes, the laptop's from its own text.
 */
async function runPresenter(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);

  // The fixture's click-reveal slide is the second one.
  await window.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="slide-thumb"]')[1].click()`);
  record.enteredPresent = await window.webContents.executeJavaScript(clickTestId("present"));
  if (!(await until(window, `Number(document.querySelector("[data-present-steps]")?.getAttribute("data-present-steps")) > 0`))) {
    throw new Error("Present mode did not open on a slide with click reveals.");
  }

  const audience = (expression: string) => window.webContents.executeJavaScript(expression);
  const attr = (name: string) => `document.querySelector("[data-present-slide-index]")?.getAttribute("${name}")`;
  const before = {
    index: await audience(attr("data-present-slide-index")),
    step: Number(await audience(attr("data-present-step"))),
    steps: Number(await audience(attr("data-present-steps"))),
  };
  record.before = before;

  const windowsBefore = BrowserWindow.getAllWindows().length;
  await audience(`[...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Second screen")?.click()`);
  if (!(await waitFor(() => BrowserWindow.getAllWindows().length > windowsBefore))) {
    throw new Error("The second screen did not open.");
  }
  const presenter = BrowserWindow.getAllWindows().find((w) => w.id !== window.id)!;
  if (!(await until(presenter, `document.querySelector('[data-testid="presenter-step"]')`, 20_000))) {
    throw new Error("The presenter window never showed a step line for a slide with reveals.");
  }
  record.presenterStepBefore = await presenter.webContents.executeJavaScript(
    `document.querySelector('[data-testid="presenter-step"]').textContent`,
  );

  // 1. Next on the laptop: one reveal on the projector, same slide.
  await presenter.webContents.executeJavaScript(`document.querySelector('[data-testid="presenter-next"]').click()`);
  const revealed = await until(window, `Number(${attr("data-present-step")}) === ${before.step + 1}`, 10_000);
  record.audienceAfterNext = {
    index: await audience(attr("data-present-slide-index")),
    step: Number(await audience(attr("data-present-step"))),
  };
  if (!revealed) throw new Error("Next on the presenter window did not reveal the next step on the projector.");
  if ((record.audienceAfterNext as { index: string }).index !== before.index) {
    throw new Error("Next on the presenter window changed slide instead of revealing the next step.");
  }
  const expectedLabel = `Step ${before.step + 2} of ${before.steps + 1}`;
  if (!(await until(presenter, `document.querySelector('[data-testid="presenter-step"]')?.textContent.includes(${JSON.stringify(expectedLabel)})`, 10_000))) {
    throw new Error(`The presenter window did not follow the projector to "${expectedLabel}".`);
  }
  record.presenterStepAfter = expectedLabel;

  // 2. Black screen from the laptop.
  await presenter.webContents.executeJavaScript(`document.querySelector('[data-testid="presenter-black"]').click()`);
  if (!(await until(window, `${attr("data-present-blacked")} === "true"`, 10_000))) {
    throw new Error("Black screen on the presenter window did not black out the projector.");
  }
  // textContent, not innerText: the label is styled uppercase, and innerText
  // applies text-transform.
  if (!(await until(presenter, `document.body.textContent.includes("Screen is black")`, 10_000))) {
    throw new Error("The presenter window did not say the projector is black.");
  }
  await capture(presenter, join(dir, "presenter-blacked.png"));
  await presenter.webContents.executeJavaScript(`document.querySelector('[data-testid="presenter-black"]').click()`);
  if (!(await until(window, `${attr("data-present-blacked")} === "false"`, 10_000))) {
    throw new Error("Pressing Black screen again did not bring the slide back.");
  }
  record.blackoutRoundTrip = true;

  // Wake the audience controls for the capture: they fade after 2.5s of a
  // still pointer, which is right for a room and useless for a record.
  await audience(`window.dispatchEvent(new MouseEvent("mousemove"))`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await capture(window, join(dir, "presenter-audience.png"));
  await capture(presenter, join(dir, "presenter.png"));
}

/**
 * The deck list (Phase 4), through the window a person uses.
 *
 * Leave the editor for the list, duplicate a deck from its card, open the copy,
 * and check the **main process** now calls the copy the open deck — the
 * presenter window and the agent attachment both read that, and a list that
 * opened a deck only in the renderer would leave both pointing at the old one.
 * Then delete the copy, Undo, and delete it again, reopening the original so
 * the profile ends as it began.
 */
async function runDecks(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const openId = async () => ((await page(`window.deckastra.currentPresentation()`)) as { presentationId: string }).presentationId;

  const original = await openId();
  record.original = original;

  // 1. To the list.
  await page(clickTestId("open-deck-list"));
  if (!(await until(window, `document.querySelectorAll('[data-testid="deck-card"]').length > 0`, 20_000))) {
    throw new Error("The deck list did not show any decks.");
  }
  const cards = () => page(`[...document.querySelectorAll('[data-testid="deck-card"]')].map((card) => card.getAttribute("data-deck-id"))`) as Promise<string[]>;
  const before = await cards();
  record.cardsBefore = before.length;
  if (!before.includes(original)) throw new Error("The open deck has no card in the list.");

  const menuOf = (id: string, item: string) => `(async () => {
    const card = document.querySelector('[data-deck-id="${id}"]');
    card.querySelector('[data-testid="deck-menu"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[role="menu"]'); i += 1) await new Promise((r) => setTimeout(r, 25));
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent.trim() === ${JSON.stringify("__ITEM__")});
    if (!entry) return false;
    entry.click();
    return true;
  })()`.replace("__ITEM__", item);

  // 2. Duplicate the open deck.
  await page(menuOf(original, "Duplicate"));
  if (!(await until(window, `document.querySelectorAll('[data-testid="deck-card"]').length === ${before.length + 1}`, 20_000))) {
    throw new Error("Duplicating did not add a card.");
  }
  const copy = (await cards()).find((id) => !before.includes(id));
  if (!copy) throw new Error("No new card appeared for the copy.");
  record.copy = copy;
  const copyTitle = await page(`document.querySelector('[data-deck-id="${copy}"] .dk-card__title').textContent`);
  record.copyTitle = copyTitle;
  if (!String(copyTitle).endsWith("(copy)")) throw new Error(`The copy is titled "${copyTitle}".`);
  await capture(window, join(dir, "decks.png"));

  // 3. Open it. The main process must agree about which deck is open.
  await page(`document.querySelector('[data-deck-id="${copy}"] .dk-card__thumb').click()`);
  if (!(await until(window, `document.querySelector("[data-editor-canvas]") && document.querySelector(".dk-appbar__deck")?.textContent.endsWith("(copy)")`, 20_000))) {
    throw new Error("Opening the copy did not show it in the editor.");
  }
  record.mainProcessOpen = await openId();
  if (record.mainProcessOpen !== copy) throw new Error("The main process still names another deck as open.");

  // 4. Back, delete the copy, Undo, delete again.
  await page(clickTestId("open-deck-list"));
  await until(window, `document.querySelector('[data-deck-id="${copy}"]')`, 20_000);
  await page(menuOf(copy, "Delete"));
  if (!(await until(window, `!document.querySelector('[data-deck-id="${copy}"]') && document.querySelector('[data-testid="undo-delete"]')`, 20_000))) {
    throw new Error("Deleting did not remove the card or offer Undo.");
  }
  await page(clickTestId("undo-delete"));
  if (!(await until(window, `document.querySelector('[data-deck-id="${copy}"]')`, 20_000))) {
    throw new Error("Undo did not bring the deck back.");
  }
  record.undoRestored = true;
  await page(menuOf(copy, "Delete"));
  await until(window, `!document.querySelector('[data-deck-id="${copy}"]')`, 20_000);

  // 5. Put things back: reopen the original.
  await page(`document.querySelector('[data-deck-id="${original}"] .dk-card__thumb').click()`);
  await until(window, `document.querySelector("[data-editor-canvas]")`, 20_000);
  record.restoredOpen = await openId();
  if (record.restoredOpen !== original) throw new Error("Could not reopen the original deck.");
  record.cardsAfter = before.length;
}

/**
 * The rendering-parity gate: does Electron's Chromium build the same scene Node does?
 *
 * The committed digests in `packages/renderer/baselines` are produced by Node with
 * the estimator and a pinned, empty font set. Rebuilding them inside the renderer
 * under exactly those conditions isolates the engine: any difference is V8, ICU or
 * floating point, which are the three named enemies of determinism here. A
 * mismatch would mean an export rendered on the desktop disagrees with one
 * rendered by the worker, and nothing else would have said so.
 *
 * Reads the fixtures and baselines from the repository, so it runs against a
 * development build rather than an installed one — parity is a property of the
 * build, not of the installer.
 */
async function runDigest(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  const fixturesDir = process.env.DECKASTRA_SMOKE_FIXTURES;
  const baselinesDir = process.env.DECKASTRA_SMOKE_BASELINES;
  if (!fixturesDir || !baselinesDir) {
    throw new Error("Set DECKASTRA_SMOKE_FIXTURES and DECKASTRA_SMOKE_BASELINES for the digest step.");
  }

  await until(window, `window.__deckastraScene`);

  const fixtures = [
    ["technical", "technical-deck.mydeck.json"],
    ["repository", "repository-context.mydeck.json"],
    ["animation", "animation-test.mydeck.json"],
  ] as const;

  const results: Record<string, unknown> = {};
  let allMatched = true;

  for (const [name, file] of fixtures) {
    const document = await readFile(join(fixturesDir, file), "utf8");
    const expected = (await readFile(join(baselinesDir, `${name}.digest.txt`), "utf8"))
      .replace(/\r\n/g, "\n")
      .trimEnd();

    // Fonts pinned rather than probed, exactly as the Node baseline does. Probing
    // here would make the digest depend on which faces this machine has installed
    // and the comparison would mean nothing.
    const actual = (await window.webContents.executeJavaScript(`(() => {
      const { buildDocumentScene, documentDigest } = window.__deckastraScene;
      const fonts = { available: new Set(), unknown: true };
      return documentDigest(buildDocumentScene(${document}, { fonts }));
    })()`)) as string;

    const matched = actual === expected;
    allMatched &&= matched;
    results[name] = matched
      ? { matched: true, lines: expected.split("\n").length }
      : { matched: false, firstDifference: firstDifference(expected, actual) };
  }

  record.baselines = results;
  record.allBaselinesMatched = allMatched;
  if (!allMatched) throw new Error("A scene digest differs from its committed baseline.");
}

/** The line that moved, because a hash tells you nothing about what changed. */
function firstDifference(expected: string, actual: string): unknown {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { line: i + 1, expected: a[i] ?? "(none)", actual: b[i] ?? "(none)" };
  }
  return null;
}

/**
 * Export a PDF, through every layer there is.
 *
 * The longest path in the product: the editor asks the service, the service
 * shells out to the bundled exporter, the exporter drives a real browser, and the
 * bytes come back through the proxy. It is also the path with the most ways to be
 * quietly wrong in a packaged app — no `npx`, no `node_modules`, no TypeScript —
 * so it is worth one end-to-end run rather than an assumption.
 */
async function runExport(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);

  // Export lives in a top-bar popover. Opened first so the panel is on screen
  // for the capture below — the panel stays mounted while closed, so a click
  // alone would work and prove less.
  // Audit UI-01: an edit still unsaved when PDF is pressed must be in the file.
  // The notes are typed and left in the field — not blurred, so the draft has
  // not even reached the save queue — and the button is pressed from script,
  // which moves no focus. Only the export's own barrier can get this right.
  const marker = `Export smoke ${Date.now()}`;
  await needDockTab(window, "notes");
  record.openedExport = await window.webContents.executeJavaScript(clickTestId("open-share"));
  record.startedExport = await window.webContents.executeJavaScript(`(() => {
    const notes = document.querySelector('[data-testid="speaker-notes"]');
    if (!notes) return false;
    notes.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, ${JSON.stringify(marker)});
    const button = [...document.querySelectorAll('[data-testid="export-popover"] button')].find(b => b.textContent?.trim() === "PDF");
    if (!button) return false;
    button.click();
    return true;
  })()`);

  // Scoped to the export panel, and matched exactly.
  //
  // A loose `/Download/` over the whole document passes immediately: the conflict
  // recovery dialog is always mounted and carries "Download local copy". That
  // false positive reported a successful export while the job was still sitting
  // at `queued`, which is exactly the bug this step exists to catch.
  const finished = await until(
    window,
    `(() => {
      const panel = [...document.querySelectorAll("section")].find(s => /^\s*EXPORT/.test(s.innerText || ""));
      if (!panel) return false;
      return [...panel.querySelectorAll("button")].some(b => /^Download /.test(b.textContent || ""));
    })()`,
    180_000,
  );
  record.exportFinished = finished;
  // Scoped the same way the assertion above is, and for a reason that only
  // showed up once the Share panel started saying "You can export a copy to
  // share" (2026-09-17): a loose `/EXPORT/i` over `textContent` matched *that*
  // section, so the record's evidence of an export was a screenshot of the share
  // panel. The check itself was never wrong — this is the diagnostic beside it,
  // and a diagnostic that reports the wrong panel is how a passing run comes to
  // be believed about something it never looked at.
  record.exportSurface = await window.webContents.executeJavaScript(`(() => {
    const panel = [...document.querySelectorAll("section")].find(s => /^\s*EXPORT/.test(s.innerText || ""));
    return (panel?.innerText || "(no export panel found)").slice(0, 600);
  })()`);

  await capture(window, join(dir, "export.png"));
  if (!finished) throw new Error("The export never produced a downloadable file.");

  // The file is of the deck that was on screen: the version it pinned is the
  // stored head, and the head holds the words typed a moment before pressing.
  const pinned = (await window.webContents.executeJavaScript(`(async () => {
    const { presentationId } = await window.deckastra.currentPresentation();
    const head = await (await fetch("/__api/v1/presentations/" + presentationId)).json();
    return {
      exported: document.querySelector("[data-export-version]")?.getAttribute("data-export-version") ?? null,
      head: head.version_id,
      notes: JSON.stringify(head.document.slides.map((slide) => slide.speakerNotes ?? null)),
    };
  })()`)) as { exported: string | null; head: string; notes: string };
  record.exportedVersion = pinned;
  if (!pinned.notes.includes(marker)) throw new Error("the notes typed before exporting never reached the store");
  if (pinned.exported !== pinned.head) {
    throw new Error(`the export is of ${pinned.exported}, not of the version holding the latest edit (${pinned.head})`);
  }

  // And a PowerPoint, because item 26's gate is that the saved artifacts open
  // in readers that are not ours — `python-pptx` for this one, `pypdf` for the
  // file above. Appended rather than folded into the checks above: those are
  // UI-01's, about the version an export pins, and PPTX takes the same path to
  // get there. What is new here is the second *format*, which exercises the
  // adapter that needs no browser to lay out a slide but still needs one to
  // measure the text.
  record.startedPptx = await window.webContents.executeJavaScript(`(() => {
    // Notes are an option and it is off by default, so an export that did not
    // tick it would carry none and prove nothing about them.
    const notes = document.querySelector('[data-testid="export-popover"] input[type="checkbox"]');
    if (notes && !notes.checked) notes.click();
    const button = [...document.querySelectorAll('[data-testid="export-popover"] button')]
      .find(b => b.textContent?.trim() === "PowerPoint" || b.textContent?.trim() === "PPTX");
    if (!button) return false;
    button.click();
    return { clicked: true, notesRequested: Boolean(notes && notes.checked) };
  })()`);
  if ((record.startedPptx as { clicked?: boolean } | false) && (record.startedPptx as { clicked: boolean }).clicked) {
    record.pptxFinished = await until(
      window,
      `(() => {
        const panel = [...document.querySelectorAll("section")].find(s => /^\s*EXPORT/.test(s.innerText || ""));
        if (!panel) return false;
        return [...panel.querySelectorAll("button")].some(b => /^Download .*pptx/i.test(b.textContent || ""));
      })()`,
      180_000,
    );
    if (!record.pptxFinished) throw new Error("the PowerPoint export never produced a downloadable file");
  }
}

/** Click a toolbar button by its exact label, from the main process. */
/**
 * The user-visible half of agent access (D2.3).
 *
 * The scoping and the refusals are covered by the API's own tests. What cannot be
 * asserted from there is the part a person actually performs: that nothing is
 * published until someone presses the button, that pressing it produces a working
 * credential, and — the one that matters most — that pressing *stop* reaches a
 * grant already handed out. Withdrawing the file only stops the next reader,
 * while whoever holds a twelve-hour grant would keep working for the rest of the
 * day after the user said no.
 *
 * So this drives the button in the rendered page and then uses the published
 * credential against the service directly, which is exactly what an attached
 * agent does with it.
 */
/**
 * What a published credential may do, on the build that ships (item 25).
 *
 * `runConsent` covers the decision: off until asked, on when asked, withdrawn
 * and revoked when stopped. This covers what the credential **is** once
 * published, and every case here is one the register named that a development
 * consent test cannot reach:
 *
 * - the scopes it carries, and the ones the *service* refuses regardless of
 *   which tools an adapter registered;
 * - the permissions on the file, which are the whole of "only this account can
 *   read it" on Windows, where the mode is ignored;
 * - a **second instance**, which cannot be checked from inside this one;
 * - a **service restart**, after which a grant from before must be worthless,
 *   because the launch secret it was signed with is gone.
 *
 * Deliberately not here: expiry by waiting. The window is twelve hours, and a
 * step that slept through it would not be a step. What is checked is that the
 * published `expiresAt` is that window — the arithmetic is unit-tested, and
 * `local_mode.scopes_for` refusing a lapsed claim is a Python test.
 */
async function runGrants(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
  controls: SmokeControls,
): Promise<void> {
  const file = join(app.getPath("userData"), "attachment.json");
  const read = async (): Promise<Attachment | null> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Attachment;
    } catch {
      return null;
    }
  };
  const asAgent = (attachment: Attachment, path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${attachment.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${attachment.grant}` },
    }).then((answer) => answer.status);

  await until(window, `document.querySelectorAll("[data-element-id]").length > 0`, 30_000);

  // Allowed the way a person allows it, through Settings › Agents.
  if ((await read()) !== null) throw new Error("an attachment existed before anyone allowed one");
  await openAgentSettings(window);
  await window.webContents.executeJavaScript(clickTestId("settings-agent-toggle"));
  await closeSettings(window);
  if (!(await waitFor(async () => (await read()) !== null))) {
    throw new Error("allowing agent access published no attachment");
  }
  const granted = (await read())!;

  // 1. What it says it is.
  const hours = (Date.parse(granted.expiresAt) - Date.now()) / 3_600_000;
  record.published = {
    version: granted.version,
    scopes: granted.scopes,
    hoursToExpiry: Math.round(hours * 10) / 10,
    presentation: !!granted.presentationId,
  };
  if (granted.version !== ATTACHMENT_VERSION) throw new Error(`attachment version ${granted.version}`);
  if ([...granted.scopes].sort().join(",") !== "export,read,write") {
    throw new Error(`published scopes were ${granted.scopes.join(",")}`);
  }
  if (hours < 11 || hours > 12.1) throw new Error(`the grant expires in ${hours} hours, not twelve`);

  // 2. What the *service* refuses it, whatever an adapter offers.
  record.refusals = {
    account: await asAgent(granted, "/v1/account"),
    approve: await asAgent(granted, "/v1/presentations/doc_x/proposals/txn_x/approve", "POST"),
    share: await asAgent(granted, "/v1/presentations/doc_x/shares", "POST"),
    deleteDeck: await asAgent(granted, "/v1/presentations/doc_x", "DELETE"),
    backup: await asAgent(granted, "/v1/local/backup", "POST"),
    revokeGrants: await asAgent(granted, "/v1/local/agent-access/revoke", "POST"),
  };
  const refusals = record.refusals as Record<string, number>;
  if (refusals.account !== 200) throw new Error(`an allowed agent could not read the account: ${refusals.account}`);
  for (const [what, status] of Object.entries(refusals)) {
    // Every one of these is a decision that belongs to the person: approving a
    // change, minting a link to a document, removing a deck, writing every deck
    // to a folder, and managing the leash itself.
    if (what !== "account" && status !== 403) throw new Error(`${what} answered ${status}, not 403`);
  }

  // 3. Who can read the file. On Windows the mode is ignored, so an explicit
  // ACL is the only thing standing between this credential and every other
  // account on the machine.
  if (process.platform === "win32") {
    const { execFile } = await import("node:child_process");
    const listing = await new Promise<string>((resolve) => {
      execFile("icacls", [file], (error, out) => resolve(error ? `icacls failed: ${error.message}` : out));
    });
    record.permissions = listing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6);
    const open = /\b(Everyone|BUILTIN\\Users|AUTHENTICATED USERS)\b/i.test(listing);
    if (open) throw new Error(`the attachment is readable beyond this account: ${listing.slice(0, 200)}`);
  }

  // 4. A second instance must not take the first one's access away.
  const second = await controls.launchSecondInstance();
  record.secondInstance = second;
  const afterSecond = await read();
  record.attachmentSurvivedSecondInstance = afterSecond !== null;
  if (!afterSecond) throw new Error("a second instance withdrew the running app's attachment");
  if ((await asAgent(afterSecond, "/v1/account")) !== 200) {
    throw new Error("a second instance left the published grant unusable");
  }

  // 5. A restart makes every grant from before it worthless, because the secret
  // they were signed with does not survive the process that made it.
  await controls.stopService();
  await controls.startService();
  if (!(await waitFor(async () => {
    const now = await read();
    return now !== null && now.port !== granted.port;
  }, 60_000))) {
    throw new Error("the service restarted but no new attachment was published");
  }
  const republished = (await read())!;
  record.afterRestart = {
    newPort: republished.port !== granted.port,
    oldGrantOnNewService: await fetch(`http://127.0.0.1:${republished.port}/v1/account`, {
      headers: { authorization: `Bearer ${granted.grant}` },
    }).then((answer) => answer.status),
    newGrantWorks: await asAgent(republished, "/v1/account"),
  };
  const restart = record.afterRestart as Record<string, unknown>;
  if (restart.oldGrantOnNewService !== 401) {
    throw new Error(`a grant from before the restart still works: ${restart.oldGrantOnNewService}`);
  }
  if (restart.newGrantWorks !== 200) throw new Error(`the republished grant does not work: ${restart.newGrantWorks}`);

  // Left as it was found: off. Unless this run is the first half of the MCP
  // check, which needs the *next* launch to republish — consent given through
  // the window in one run and honoured in the next is the product's own path,
  // and driving it is the only way to reach the shipped server with a
  // credential nobody forged.
  if (process.env.DECKASTRA_SMOKE_KEEP_ACCESS === "1") {
    record.accessLeftOn = true;
    return;
  }
  await openAgentSettings(window).catch(() => {});
  await window.webContents.executeJavaScript(clickTestId("settings-agent-toggle")).catch(() => false);
  await closeSettings(window).catch(() => {});
  record.stoppedAtEnd = await waitFor(async () => (await read()) === null);
}

/**
 * A deck big enough for the numbers to mean anything (item 30).
 *
 * Every performance figure this project has recorded came from a five-slide
 * fixture, and the register says so: "a small fixture's working-set sample is
 * not a memory qualification". So this builds sixty slides with real uploaded
 * photographs, groups and motion in them, opens it, and measures the four
 * things doc 04 §31.1 puts a number on plus the two the register adds — memory
 * across repeated navigation, and memory across repeated exports.
 *
 * **The budgets are judged by the product's own code**, not by numbers copied
 * into the harness: `checkBudget` and `checkFrameBudget` from
 * `@deckastra/renderer`. A harness with its own thresholds is a second place
 * for them to be wrong, and the frame one is subtle enough that a copy would
 * certainly drift — a drag is within budget when the work fits in frames the
 * compositor was going to paint anyway, which can only be judged against the
 * display's own cadence.
 */
async function runPerformance(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
): Promise<void> {
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const memory = async (label: string) => {
    const metrics = app.getAppMetrics();
    const total = metrics.reduce((sum, entry) => sum + (entry.memory?.workingSetSize ?? 0), 0);
    return { label, processes: metrics.length, mb: Math.round((total / 1024) * 10) / 10 };
  };

  await until(window, `document.querySelector("[data-editor-canvas]")`, 60_000);

  // What this ran on. Not decoration: a run on a machine with no memory left
  // measures the machine, and a number with no machine beside it is how a bad
  // figure gets quoted later as a budget. The register asks for it in as many
  // words — "attach hardware and workloads".
  const machine = async () => {
    const { totalmem, freemem, cpus, loadavg } = await import("node:os");
    return {
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(freemem() / 1024 / 1024),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model?.trim() ?? "unknown",
      loadAverage: loadavg()[0],
    };
  };
  record.machineBefore = await machine();

  // ---- 1. A real deck: photographs uploaded through the product's own path.
  const pictures = [pngOf(1600, 900, [64, 96, 160]), pngOf(1280, 720, [160, 72, 64]), pngOf(960, 540, [72, 140, 96])];
  const assets: PerfAsset[] = [];
  for (const [index, picture] of pictures.entries()) {
    const uploaded = (await page(`(async () => {
      const account = await (await fetch("/__api/v1/account")).json();
      const workspace = account.workspaces[0].id;
      const bytes = Uint8Array.from(atob(${JSON.stringify(picture.base64)}), (c) => c.charCodeAt(0));
      const begun = await (await fetch("/__api/v1/workspace/assets/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace,
          filename: ${JSON.stringify(`perf-${index + 1}.png`)},
          content_type: "image/png",
          size_bytes: bytes.byteLength,
          kind: "image",
          width: ${picture.width},
          height: ${picture.height},
        }),
      })).json();
      // Relative on purpose (see object_storage.blob_url), so it goes through
      // same proxy every other request does. An absolute one would be an object
      // store's presigned URL and must be left exactly as it is.
      const target = begun.upload_url.startsWith("http") ? begun.upload_url : "/__api" + begun.upload_url;
      const put = await fetch(target, { method: "PUT", headers: begun.headers, body: bytes });
      if (!put.ok) throw new Error("the upload was refused: " + put.status + " for " + target);
      const done = await (await fetch("/__api/v1/workspace/assets/uploads/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upload_token: begun.upload_token }),
      })).json();
      return { id: done.asset_id ?? done.id, storageKey: done.storage_key, bytes: bytes.byteLength };
    })()`)) as { id: string; storageKey: string; bytes: number };

    assets.push({
      id: uploaded.id,
      type: "image",
      storageKey: uploaded.storageKey,
      fileName: `perf-${index + 1}.png`,
      mimeType: "image/png",
      byteSize: uploaded.bytes,
      width: picture.width,
      height: picture.height,
      altText: `A measured photograph, ${picture.width} by ${picture.height}`,
    });
  }
  record.uploaded = assets.map((asset) => ({ id: asset.id, bytes: asset.byteSize }));

  const deck = buildLargeDeck(60, assets);
  record.deckShape = deck.shape;

  const created = (await page(`(async () => {
    const made = await (await fetch("/__api/v1/presentations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Performance deck" }),
    })).json();
    const applied = await fetch("/__api/v1/presentations/" + made.presentation_id + "/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [
          { op: "replace", path: "/theme", value: ${JSON.stringify(deck.theme)} },
          { op: "replace", path: "/assets", value: ${JSON.stringify(deck.assets)} },
          { op: "replace", path: "/slides", value: ${JSON.stringify(deck.slides)} },
        ],
        intent: "Build the performance deck",
        expected_version_id: made.version_id,
      }),
    });
    if (!applied.ok) throw new Error("the deck was refused: " + applied.status + " " + (await applied.text()).slice(0, 300));
    return made.presentation_id;
  })()`)) as string;
  record.performanceDeck = created;

  // ---- 2. Cold open: the deck this install opens, from a fresh window load.
  await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(created)} })`);
  const coldStart = Date.now();
  window.webContents.reload();
  if (!(await until(window, `document.querySelector("[data-editor-canvas]")`, 120_000))) {
    throw new Error("the sixty-slide deck never opened");
  }
  record.coldOpenMs = Date.now() - coldStart;

  // The thumbnail strip is the one budget that names this size directly, and it
  // is measured **from the navigation**, not from the canvas appearing. Timed
  // from the canvas it read 13ms against a 1000ms budget — which is not sixty
  // thumbnails rendering, it is sixty thumbnails already being there. How many
  // existed when the canvas did is recorded so that a suspiciously small number
  // can be recognised rather than believed.
  record.thumbsWhenCanvasAppeared = await page(
    `document.querySelectorAll('[data-testid="slide-thumb"]').length`,
  );
  const strip = await until(
    window,
    `document.querySelectorAll('[data-testid="slide-thumb"]').length >= 60`,
    120_000,
  );
  record.thumbnailStrip = {
    ...checkBudget("thumbnailStrip", Date.now() - coldStart),
    rendered: strip,
    measuredFrom: "the navigation that opened the deck",
  };
  record.afterOpen = await memory("after the deck opened");

  // ---- 3. Switching slides, warm.
  const switchMs: number[] = [];
  for (let index = 1; index < 12; index += 1) {
    const at = Date.now();
    await page(`document.querySelectorAll('[data-testid="slide-thumb"]')[${index}]?.click()`);
    await until(window, `document.querySelector("[data-editor-canvas]")`, 20_000);
    switchMs.push(Date.now() - at);
  }
  const median = [...switchMs].sort((a, b) => a - b)[Math.floor(switchMs.length / 2)]!;
  record.slideSwitchWarm = checkBudget("slideSwitchWarm", median);
  record.slideSwitchSamples = switchMs;

  // ---- 4. A drag, judged as dropped frames rather than milliseconds.
  const intervals = (await page(`(async () => {
    const canvas = document.querySelector("[data-editor-canvas]");
    const box = [...document.querySelectorAll("[data-element-id]")][0];
    if (!canvas || !box) return [];
    const rect = box.getBoundingClientRect();
    const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const seen = [];
    let previous;
    let sampling = true;
    const tick = (t) => {
      if (!sampling) return;
      if (previous !== undefined) seen.push(t - previous);
      previous = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const send = (type, x, y) => box.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: 1,
    }));
    send("pointerdown", start.x, start.y);
    for (let step = 1; step <= 60; step += 1) {
      send("pointermove", start.x + step * 4, start.y + step * 2);
      await new Promise((done) => requestAnimationFrame(() => done()));
    }
    send("pointerup", start.x + 240, start.y + 120);
    sampling = false;
    return seen;
  })()`)) as number[];

  const sampler = new FrameSampler();
  for (const interval of intervals) sampler.record(interval);
  const stats = sampler.stats();
  record.drag = stats ? { ...checkFrameBudget(stats), frames: stats.count, p95: stats.p95, p99: stats.p99 } : null;

  // ---- 5. Memory across repeated navigation, which is the register's real ask.
  const navigation: unknown[] = [];
  // Six rounds, not three. Three showed memory climbing about 13MB a round and
  // could not say whether that was a cache filling or a leak: both look like a
  // straight line early on, and only one of them flattens. The register asks
  // that resources "stabilize after repeated navigation", which is a question
  // about the shape of the curve rather than about any single sample.
  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < 20; index += 1) {
      await page(`document.querySelectorAll('[data-testid="slide-thumb"]')[${index * 3}]?.click()`);
    }
    navigation.push(await memory(`after navigation round ${round + 1}`));
  }
  record.navigationMemory = navigation;

  // ---- 6. And across exports, where a browser is started and thrown away.
  const exports: unknown[] = [];
  for (let round = 0; round < 2; round += 1) {
    const done = await page(`(async () => {
      const began = Date.now();
      const started = await (await fetch("/__api/v1/presentations/${created}/exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "pdf" }),
      })).json();
      // The route calls this field id, not export_id. Asking for the wrong
      // one polled a nonsense URL for five minutes and called that a timeout,
      // while the export had in fact finished in under one.
      const id = started.id;
      if (!id) throw new Error("the export was not created: " + JSON.stringify(started).slice(0, 200));
      for (let waited = 0; waited < 600; waited += 1) {
        const answer = await fetch("/__api/v1/exports/" + id);
        // Loudly, rather than looping into a timeout: a poll that cannot find
        // its job is a broken question, not a slow answer.
        if (!answer.ok) throw new Error("the export could not be read: " + answer.status);
        const job = await answer.json();
        if (job.status === "completed" || job.status === "failed") {
          return { status: job.status, bytes: job.bytes, ms: Date.now() - began, attempts: job.attempts, error: job.error ?? null };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { status: "timed out", ms: Date.now() - began };
    })()`);
    exports.push({ round: round + 1, result: done, memory: await memory(`after export ${round + 1}`) });
  }
  record.exportMemory = exports;

  record.machineAfter = await machine();
  await capture(window, join(dir, "performance.png"));

  // Judged, not just recorded. A measurement nobody compares to anything is a
  // number in a file.
  const strip2 = record.thumbnailStrip as { withinBudget: boolean };
  const switch2 = record.slideSwitchWarm as { withinBudget: boolean };
  const drag = record.drag as { withinBudget: boolean } | null;
  const failures: string[] = [];
  if (!strip2.withinBudget) failures.push("the sixty-slide thumbnail strip is over budget");
  if (!switch2.withinBudget) failures.push("switching slides is over budget");
  if (drag && !drag.withinBudget) failures.push("a drag drops too many frames");
  if (failures.length > 0) throw new Error(failures.join("; "));
}

/** A real PNG of one colour, big enough that decoding it costs something. */
function pngOf(width: number, height: number, rgb: [number, number, number]): {
  base64: string;
  width: number;
  height: number;
} {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      // A gradient rather than a flat fill: a single colour compresses to
      // almost nothing, and an image that is 200 bytes on disk measures
      // nothing about decoding one that is not.
      raw[at] = (rgb[0] + x) % 256;
      raw[at + 1] = (rgb[1] + y) % 256;
      raw[at + 2] = (rgb[2] + x + y) % 256;
    }
  }

  const chunk = (kind: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(kind, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { base64: png.toString("base64"), width, height };
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runConsent(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  const file = join(app.getPath("userData"), "attachment.json");
  const read = async (): Promise<Attachment | null> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Attachment;
    } catch {
      return null;
    }
  };
  const reaches = async (attachment: Attachment): Promise<number> => {
    const answer = await fetch(`http://127.0.0.1:${attachment.port}/v1/account`, {
      headers: { authorization: `Bearer ${attachment.grant}` },
    });
    return answer.status;
  };

  await until(window, `document.querySelectorAll("[data-element-id]").length > 0`);

  // Off by default, including on an install that used to work — and with no
  // chip on the bar while it is off (roadmap 08 §1.4).
  record.publishedBeforeConsent = (await read()) !== null;
  record.chipWhileOff = await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="agent-access-open"]'))`);
  if (record.chipWhileOff) throw new Error("The agent chip is on the bar while agents are off.");

  // The switch is in Settings › Agents, reached through the account menu the
  // way a person reaches it, then pressed. The label is asserted, not just the
  // test id, because the words are the consent.
  await openAgentSettings(window);
  record.openedAgentAccess = true;
  record.offerText = await window.webContents.executeJavaScript(AGENT_ACCESS_STATUS);
  record.allowLabel = await window.webContents.executeJavaScript(TEXT_OF("settings-agent-toggle"));
  if (record.allowLabel !== "Allow agent access") {
    throw new Error(`The agent-access switch read ${JSON.stringify(record.allowLabel)}, not "Allow agent access".`);
  }
  record.allowed = await window.webContents.executeJavaScript(clickTestId("settings-agent-toggle"));
  if (!(await waitFor(async () => (await read()) !== null))) {
    throw new Error("Allowing agent access published no attachment.");
  }
  const granted = (await read())!;
  record.grantedText = await window.webContents.executeJavaScript(AGENT_ACCESS_STATUS);
  // While a grant is live, the bar says so.
  await closeSettings(window);
  record.chipWhileOn = await until(window, `document.querySelector('[data-testid="agent-access-open"]')`, 10_000);
  if (!record.chipWhileOn) throw new Error("No agent chip on the bar while agents can reach the app.");
  await openAgentSettings(window);
  record.grantWorks = await reaches(granted);

  // And a capability the credential does not carry, refused by the service
  // rather than by which tools an adapter happened to register.
  const approval = await fetch(
    `http://127.0.0.1:${granted.port}/v1/presentations/prs_whatever/proposals/txn_whatever/approve`,
    { method: "POST", headers: { authorization: `Bearer ${granted.grant}` } },
  );
  record.approvalRefused = approval.status;

  record.stopLabel = await window.webContents.executeJavaScript(TEXT_OF("settings-agent-toggle"));
  if (record.stopLabel !== "Stop agent access") {
    throw new Error(`The agent-access switch read ${JSON.stringify(record.stopLabel)}, not "Stop agent access".`);
  }
  record.stopped = await window.webContents.executeJavaScript(clickTestId("settings-agent-toggle"));
  if (!(await waitFor(async () => (await read()) === null))) {
    throw new Error("Stopping agent access left the attachment published.");
  }

  // Revocation names a moment, and the claim inside a grant is whole seconds —
  // so a grant minted in the same second as the stop is not yet before it.
  await new Promise((done) => setTimeout(done, 1_200));
  record.grantAfterStop = await reaches(granted);

  await capture(window, join(smokeDir()!, "consent.png"));

  if (record.publishedBeforeConsent) throw new Error("An attachment existed before anyone allowed one.");
  if (record.allowed !== true || record.stopped !== true) throw new Error("The switch was not on screen.");
  if (record.grantWorks !== 200) throw new Error(`An allowed agent was refused: ${record.grantWorks}`);
  if (record.approvalRefused !== 403) throw new Error(`Approval was not refused: ${record.approvalRefused}`);
  if (record.grantAfterStop !== 401) {
    throw new Error(`A grant issued before the user stopped access still works: ${record.grantAfterStop}`);
  }
}

/**
 * Drag a clip on the timeline, in the app (D4.2).
 *
 * jsdom can say the handlers fire in the right order. It cannot say whether a
 * real pointer, with real capture, over a lane whose width comes from real
 * layout, moves a clip to where the author dropped it — and every number in that
 * sentence comes from somewhere a test double replaced.
 *
 * It reads the result out of the document rather than the DOM: the bar moving is
 * what the author sees, but the clip's stored startMs is what survives a reload,
 * and those are different claims.
 */
async function runTimeline(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  await until(window, 'document.querySelector("[data-editor-canvas]")');

  // A slide of its own to work on.
  // --------------------------------
  // This drives the editor against whatever deck the app has open — the user's.
  // It used to add a shape, an animation, a duplicate and a fix to that deck and
  // leave all four behind, so every run started from the last run's mess and the
  // checks began finding each other's leftovers. It now works on a slide it adds
  // and unwinds with the product's own undo, which also means every edit below
  // is exercised through the history rather than only through the document.
  const slidesBefore = (await window.webContents.executeJavaScript(
    SLIDE_COUNT,
  )) as number;

  record.addedSlide = await window.webContents.executeJavaScript(clickTestId("add-slide"));
  if (
    !(await until(
      window,
      `${SLIDE_COUNT} > ${slidesBefore}`,
    ))
  ) {
    throw new Error("The editor did not add a slide to work on.");
  }

  // Something to animate, then an animation on it.
  await window.webContents.executeJavaScript(ADD_RECTANGLE);
  await until(window, 'document.querySelectorAll("[data-element-id]").length > 0');
  // The timeline is a tab of the dock, closed while designing.
  await needDockTab(window, "timeline");

  record.addedAnimation = await window.webContents.executeJavaScript(`(() => {
    const select = [...document.querySelectorAll("select")].find((one) =>
      [...one.options].some((option) => option.value === "fade"));
    if (!select) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, "fade");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

  // The *last* bar, not the first. This step edits the deck the app has open and
  // that deck keeps its clips between runs, so "the first bar" is whatever an
  // earlier run left behind — and a check that operates on someone else's
  // leftovers is a check that fails for the wrong reason.
  const BAR = "[role=\"button\"][title*=\"ms\"]";
  const NEWEST = `[...document.querySelectorAll('${BAR}')].at(-1)`;
  if (!(await until(window, `document.querySelector('${BAR}') !== null`))) {
    throw new Error("No clip bar appeared after adding an animation.");
  }

  record.dragged = await window.webContents.executeJavaScript(`(async () => {
    const bar = ${NEWEST};
    const before = bar.title;
    const box = bar.getBoundingClientRect();

    const y = box.top + box.height / 2;
    const from = box.left + Math.min(12, box.width / 2);
    const send = (type, x, extra) => bar.dispatchEvent(new PointerEvent(type, Object.assign({
      pointerId: 1, bubbles: true, cancelable: true, clientX: x, clientY: y,
    }, extra || {})));

    send("pointerdown", from);
    // Two moves and a frame between them: the handler coalesces, so a single
    // move would not prove the frame loop runs at all.
    send("pointermove", from + 40);
    await new Promise((r) => requestAnimationFrame(r));
    send("pointermove", from + 80);
    await new Promise((r) => requestAnimationFrame(r));
    send("pointerup", from + 80);
    await new Promise((r) => requestAnimationFrame(r));

    const after = ${NEWEST};
    return { before, after: after ? after.title : null, laneWidth: Math.round(box.width) };
  })()`);

  const dragged = record.dragged as { before: string; after: string | null };
  if (!dragged.after || dragged.after === dragged.before) {
    throw new Error(
      "Dragging the clip changed nothing. Before: " + dragged.before + " After: " + String(dragged.after),
    );
  }

  // --- keyframe handles, which only exist once the preset is opened
  record.openedKeyframes = await window.webContents.executeJavaScript(clickButton("Open keyframes"));
  const HANDLE = "[role=\"slider\"]";
  if (!(await until(window, `document.querySelector('${HANDLE}') !== null`))) {
    throw new Error("Opening the preset produced no keyframe handles.");
  }

  record.keyframeDrag = await window.webContents.executeJavaScript(`(async () => {
    const handles = () => [...document.querySelectorAll('${HANDLE}')];
    const before = handles().map((one) => one.getAttribute("aria-valuenow"));
    const handle = handles()[0];
    const box = handle.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const send = (type, x) => handle.dispatchEvent(new PointerEvent(type, {
      pointerId: 2, bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));

    const barBefore = ${NEWEST}.title;
    send("pointerdown", box.left + box.width / 2);
    send("pointermove", box.left + box.width / 2 + 120);
    await new Promise((r) => requestAnimationFrame(r));
    // What the surface says it is doing. Empty here means the gesture never
    // started, which is a different bug from one that started and committed
    // nothing — and the two took a while to tell apart.
    const readout = [...document.querySelectorAll("p")]
      .map((one) => one.textContent)
      .filter((text) => text && text.indexOf("keyframe at") >= 0);
    send("pointerup", box.left + box.width / 2 + 120);

    // Polled, not read once. A commit goes through React state and a document
    // update, and neither has flushed by the next frame — reading immediately
    // reports "nothing changed" about a change that is on its way.
    const changed = async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((r) => setTimeout(r, 50));
        const now = handles().map((one) => one.getAttribute("aria-valuenow"));
        if (JSON.stringify(now) !== JSON.stringify(before)) return now;
      }
      return handles().map((one) => one.getAttribute("aria-valuenow"));
    };
    const settled = await changed();

    return {
      readout,
      before,
      after: settled,
      barBefore,
      barAfter: ${NEWEST}.title,
    };
  })()`);

  const keyframes = record.keyframeDrag as {
    before: string[];
    after: string[];
    barBefore: string;
    barAfter: string;
  };
  if (JSON.stringify(keyframes.before) === JSON.stringify(keyframes.after)) {
    throw new Error("Dragging a keyframe handle changed nothing: " + JSON.stringify(keyframes));
  }
  // The clip must not have moved with it. A keyframe drag that also slid the bar
  // would take the clip out from under the handle being aimed at.
  if (keyframes.barBefore !== keyframes.barAfter) {
    throw new Error("Dragging a keyframe moved the clip too: " + keyframes.barAfter);
  }

  // --- a conflict, and the fix it offers
  // Duplicating the selected clip puts a second one on the same property at the
  // same time, which is exactly the overlap D4.3 is about.
  record.duplicated = await window.webContents.executeJavaScript(clickButton("Duplicate clip"));

  record.conflict = await window.webContents.executeJavaScript(`(async () => {
    const find = () => [...document.querySelectorAll("button")]
      .filter((one) => /^(Start the later clip|Shorten the earlier clip)/.test(one.textContent || ""));

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      if (find().length > 0) break;
    }

    const offered = find().map((one) => one.textContent);
    if (offered.length === 0) return { offered, applied: false };
    const before = offered.length;

    const barsBefore = [...document.querySelectorAll('${BAR}')].map((one) => one.title);
    find()[0].click();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const now = [...document.querySelectorAll('${BAR}')].map((one) => one.title);
      if (JSON.stringify(now) !== JSON.stringify(barsBefore)) {
        return { offered, applied: true, barsBefore, barsAfter: now, before, remaining: find().length };
      }
    }
    return { offered, applied: false, barsBefore };
  })()`);

  const conflict = record.conflict as { offered: string[]; applied: boolean };
  if (conflict.offered.length === 0) {
    throw new Error("Two clips overlap and the panel offered no fix.");
  }
  if (!conflict.applied) {
    throw new Error("The offered fix changed nothing: " + JSON.stringify(record.conflict));
  }
  // Relative, not absolute. This step edits the deck the app has open and that
  // deck keeps its changes between runs, so "no conflicts left" only holds the
  // first time. What a fix must always do is leave fewer than it found.
  const counted = record.conflict as { before: number; remaining: number };
  if (!(counted.remaining < counted.before)) {
    throw new Error(
      "Applying a fix left as many conflicts as before: " + JSON.stringify(record.conflict),
    );
  }

  await capture(window, join(smokeDir()!, "timeline.png"));

  // --- put the deck back
  // Undo until the slide it added is gone. A loop rather than a count: the
  // number of edits above changes whenever this step grows, and a count that
  // drifted would leave exactly the mess this is here to avoid.
  record.unwound = await window.webContents.executeJavaScript(`(async () => {
    const undo = () => document.querySelector('[data-testid="undo"]');
    const slides = () => ${SLIDE_COUNT};
    const settled = () => {
      const text = document.body.innerText;
      return !text.includes("Saving") && !text.includes("Save changes");
    };

    // One undo at a time, each allowed to reach the store before the next.
    //
    // Clicking as fast as the loop can go is not a faster version of undoing —
    // it is a different gesture. Each edit carries the version it was authored
    // on, and a burst outruns the round trip until one carries a version the
    // server has already moved past. The editor then does exactly what it is
    // designed to do: keeps the work, refuses to re-send it against a refreshed
    // version, and waits for a human. That is last-write-wins being refused, and
    // it left this step reporting an undo the store never saw.
    let presses = 0;
    let refused = false;

    for (let attempt = 0; attempt < 120; attempt += 1) {
      for (let wait = 0; wait < 100 && !settled(); wait += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (document.body.innerText.includes("Save changes")) {
        refused = true;
        break;
      }
      if (slides() <= ${slidesBefore}) break;

      const button = undo();
      if (!button || button.disabled) break;
      button.click();
      presses += 1;
      await new Promise((r) => setTimeout(r, 120));
    }

    return { presses, refused, slides: slides(), target: ${slidesBefore} };
  })()`);

  // Undone in the window is not undone in the store. The edits go through the
  // autosave queue, and `app.exit()` a moment later takes whatever has not
  // drained with it — which is why the deck kept growing by a slide a run even
  // though every run reported it had put things back. "Saved" is the editor's
  // own acknowledgement, and an acknowledgement is the only thing that means a
  // change is durable.
  record.unwindSaved = await window.webContents.executeJavaScript(`(async () => {
    // Not "does the page say Saved": it says that most of the time, including
    // before this run's undos were queued, so waiting for the word matches text
    // that was already there. What means the queue drained is *leaving* the
    // saving state and staying out of it — the acknowledgement, not the attempt.
    const status = () => document.body.innerText;
    let quiet = 0;

    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const text = status();
      if (text.includes("Saving")) {
        quiet = 0;
        continue;
      }
      // A refused save is the one state that means the work is still in the
      // window and not in the store.
      if (text.includes("Save changes")) {
        return { drained: false, reason: "a save is waiting to be retried" };
      }
      quiet += 1;
      // A second with nothing in flight. Not "did a save happen" — the undo loop
      // above already waits for each one, so by here there is usually nothing
      // left to watch, and requiring a sighting fails on a step that did
      // everything right.
      if (quiet >= 10) return { drained: true };
    }
    return { drained: false, reason: "still saving after 30s" };
  })()`);

  const saved = record.unwindSaved as { drained: boolean; reason?: string };
  if (!saved.drained) {
    throw new Error(
      "The undo never reached the store (" + (saved.reason ?? "unknown") + "), so the deck keeps the changes.",
    );
  }

  const unwound = record.unwound as { slides: number; target: number; presses: number };
  if (unwound.slides !== unwound.target) {
    throw new Error(
      "The deck was left with " +
        unwound.slides +
        " slides instead of " +
        unwound.target +
        " after " +
        unwound.presses +
        " undos.",
    );
  }
}

/**
 * Slide management and speaker notes, through the strip a person uses (Phase 2).
 *
 * Every claim is checked against the **stored** document, read back through the
 * page's own proxy, not against the strip: a thumbnail that moved is what the
 * author sees, and the order in the store is what survives a reload — different
 * claims, and only the second one is the product.
 *
 * It works on slides it adds and deletes them through the menu afterwards, so
 * the deck ends as it began, and so the delete path is exercised too.
 */
async function runSlides(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  await until(window, 'document.querySelector("[data-editor-canvas]")');
  // Notes are a tab of the dock, closed while designing.
  await needDockTab(window, "notes");

  const result = (await window.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const byId = (id) => document.querySelectorAll('[data-testid="' + id + '"]');
    const thumbs = () => [...byId("slide-thumb")];
    const log = [];

    // The store, not the page.
    const { presentationId } = await window.deckastra.currentPresentation();
    const stored = async () => {
      const answer = await fetch("/__api/v1/presentations/" + presentationId);
      if (!answer.ok) throw new Error("reading the stored deck answered " + answer.status);
      return (await answer.json()).document;
    };
    // Settled means the queue drained: "saved", held for half a second.
    const settle = async () => {
      let quiet = 0;
      for (let i = 0; i < 300 && quiet < 5; i += 1) {
        await sleep(100);
        const status = document.querySelector("[data-save-status]")?.getAttribute("data-save-status");
        quiet = status === "saved" ? quiet + 1 : 0;
      }
      if (quiet < 5) throw new Error("the edits never finished saving");
    };
    const waitFor = async (predicate, what) => {
      for (let i = 0; i < 100; i += 1) {
        if (predicate()) return;
        await sleep(50);
      }
      throw new Error("timed out waiting for " + what);
    };
    const openMenuOf = async (index) => {
      byId("slide-menu")[index].click();
      await waitFor(() => document.querySelector('[role="menu"]'), "the slide menu");
    };
    const choose = (label) => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent.trim() === label);
      if (!item) throw new Error("no menu item " + label);
      item.click();
    };

    const original = (await stored()).slides.map((slide) => slide.id);
    log.push("start " + original.length);

    // 1. Add a slide, then duplicate it from its menu.
    byId("add-slide")[0].click();
    await waitFor(() => thumbs().length === original.length + 1, "the added slide");
    await openMenuOf(original.length);
    choose("Duplicate");
    await waitFor(() => thumbs().length === original.length + 2, "the duplicate");
    await settle();
    const afterDuplicate = (await stored()).slides.map((slide) => slide.id);
    const added = afterDuplicate.slice(original.length);
    if (afterDuplicate.length !== original.length + 2) throw new Error("the store has " + afterDuplicate.length + " slides after add + duplicate");
    if (new Set(afterDuplicate).size !== afterDuplicate.length) throw new Error("the duplicate reused an id");
    log.push("duplicated");

    // 2. Move the last slide up one with the keyboard.
    const last = thumbs().at(-1);
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
    await settle();
    const afterMove = (await stored()).slides.map((slide) => slide.id);
    const expected = [...original, added[1], added[0]];
    if (JSON.stringify(afterMove) !== JSON.stringify(expected)) throw new Error("Alt+Up did not swap the last two slides in the store");
    const focusedAfterMove = document.activeElement === thumbs()[original.length];
    log.push("moved");

    // 3. Speaker notes on the slide now on screen (the one that moved).
    // The field is rich text (a contenteditable), so this types through the
    // browser's own editing engine — insertText fires input the way typing does.
    const notes = document.querySelector('[data-testid="speaker-notes"]');
    const text = "Open with the cost of an unobserved migration.";
    notes.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    notes.blur();
    await settle();
    const withNotes = (await stored()).slides.find((slide) => slide.id === added[1]);
    const storedNotes = typeof withNotes?.speakerNotes === "string" ? withNotes.speakerNotes : JSON.stringify(withNotes?.speakerNotes);
    if (storedNotes !== text) throw new Error("the stored notes read " + JSON.stringify(storedNotes));
    log.push("notes");

    // 3b. Formatting, through the toolbar a person presses: select the notes,
    // make them bold and a numbered list, and the store must hold rich text
    // carrying both — the editing engine's markup read back, not kept.
    notes.focus();
    document.execCommand("selectAll");
    document.querySelector('[data-testid="notes-bold"]').click();
    document.querySelector('[data-testid="notes-insertOrderedList"]').click();
    notes.blur();
    await settle();
    const formatted = (await stored()).slides.find((slide) => slide.id === added[1])?.speakerNotes;
    const block = formatted?.blocks?.[0];
    if (!block || block.type !== "numbered" || !block.spans.every((span) => span.bold) || block.spans.map((span) => span.text).join("") !== text) {
      throw new Error("formatted notes were stored as " + JSON.stringify(formatted));
    }
    if (!notes.querySelector("ol li")) throw new Error("the field stopped showing the list after its own commit");
    log.push("formatted notes");

    // 4. Put the deck back: delete both added slides through the menu.
    for (let n = 0; n < 2; n += 1) {
      await openMenuOf(thumbs().length - 1);
      choose("Delete");
      await waitFor(() => thumbs().length === original.length + 1 - n, "a deletion");
    }
    await settle();
    const final = (await stored()).slides.map((slide) => slide.id);
    if (JSON.stringify(final) !== JSON.stringify(original)) throw new Error("the deck was not put back: " + final.length + " slides");
    log.push("restored");

    return { log, original: original.length, afterDuplicate: afterDuplicate.length, focusedAfterMove, storedNotes };
  })()`)) as Record<string, unknown>;

  Object.assign(record, result);
  await capture(window, join(smokeDir()!, "slides.png"));
}

/**
 * The editor chrome against WCAG 2.1 A and AA, in both themes (editor Phase 8).
 *
 * axe-core runs inside the real window, on the real DOM, with the real
 * stylesheet — which is the only place contrast can be measured honestly: the
 * token test checks the pairs the stylesheet declares, this checks what the
 * browser actually painted. Slides are excluded (`[data-deckastra-slide]`, the
 * canvas): a deck's own accessibility is the product's checker's job and is a
 * property of what someone authored, not of the editor.
 *
 * Needs a checkout: axe is a dev dependency, read from node_modules and handed
 * to the page, and is never bundled into the app.
 */
async function runA11y(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  let source: string;
  try {
    source = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    // Read from `node_modules` and deliberately never bundled, so a packaged
    // build has no axe to run and never will. Skipped by name rather than
    // failed: the audit is a checkout gate, and a packaged run failing here
    // would train everyone to ignore a red a11y step.
    if (app.isPackaged) {
      record.skipped = "axe-core is a development dependency and is not shipped; run this step from a checkout";
      return;
    }
    throw new Error("axe-core is not installed; the a11y step runs from a checkout (npm install).");
  }
  await page(source);

  const audit = async () =>
    (await page(`(async () => {
      const result = await axe.run(
        { include: [document], exclude: [["[data-deckastra-slide]"], ["[data-editor-canvas]"]] },
        { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] },
      );
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.length,
        targets: violation.nodes.slice(0, 4).map((node) => node.target.join(" ")),
        why: violation.nodes[0] ? violation.nodes[0].failureSummary : "",
      }));
    })()`)) as Array<{ id: string; impact: string; nodes: number; targets: string[]; why: string; help: string }>;

  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const click = async (id: string) => {
    const pressed = await page(clickTestId(id));
    if (!pressed) throw new Error(`cannot press ${id}`);
    await sleep(400);
  };
  const setTheme = async (name: "Light" | "Dark") => {
    await click("account-menu");
    await page(`[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.trim() === ${JSON.stringify(name)}).click()`);
    await sleep(300);
    const applied = await page(`document.documentElement.dataset.dkTheme`);
    if (applied !== name.toLowerCase()) throw new Error(`the theme did not change to ${name}`);
  };
  const escape = async () => {
    await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
  };

  // ---- The keyboard, with real key events. A synthetic KeyboardEvent never
  // moves focus, so only input the browser treats as a person's can show a
  // keyboard trap — or its absence.
  window.focus();
  window.webContents.focus();
  const key = async (keyCode: string, shift = false) => {
    const modifiers = shift ? ["shift"] : [];
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as Electron.KeyboardInputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as Electron.KeyboardInputEvent);
    await sleep(120);
  };
  const region = () => page(`document.activeElement?.closest("[data-region]")?.getAttribute("data-region") ?? null`) as Promise<string | null>;
  const nothingSelected = () => page(`document.querySelector(".dk-inspector__empty") !== null`) as Promise<boolean>;

  await click("mode-design");
  await page(`document.querySelector('[data-testid="mode-design"]').focus()`);
  const selectedBefore = await nothingSelected();
  await key("Tab");
  const tabFromButton = {
    moved: (await page(`document.activeElement?.getAttribute("data-testid")`)) !== "mode-design",
    selectedNothing: selectedBefore && (await nothingSelected()),
  };

  await page(`document.activeElement?.blur()`);
  const walk: Array<string | null> = [];
  for (let i = 0; i < 8; i += 1) {
    await key("F6");
    walk.push(await region());
  }

  // Into the canvas, then Tab through its objects until focus leaves.
  for (let i = 0; i < 10 && (await region()) !== "canvas"; i += 1) await key("F6");
  let selectedOnCanvas = false;
  let presses = 0;
  while (presses < 40 && (await region()) === "canvas") {
    await key("Tab");
    presses += 1;
    if (!(await nothingSelected())) selectedOnCanvas = true;
  }
  const canvasTab = { selectedOnCanvas, leftAfter: presses, leftTo: await region() };
  record.keyboard = { tabFromButton, walk, canvasTab };
  // Notes and the timeline are one region now, the dock, whichever tab shows.
  const expected = ["app bar", "tools", "slides", "canvas", "dock", "panel", "app bar", "tools"];
  if (!tabFromButton.moved || !tabFromButton.selectedNothing) {
    throw new Error("Tab on a button did not move focus, or selected an object: the keyboard trap is back.");
  }
  if (JSON.stringify(walk) !== JSON.stringify(expected)) throw new Error(`F6 walked ${JSON.stringify(walk)}.`);
  if (!canvasTab.selectedOnCanvas || canvasTab.leftAfter >= 40) {
    throw new Error(`Tab on the canvas ${canvasTab.selectedOnCanvas ? "never left it" : "selected nothing"}.`);
  }
  await page(`document.activeElement?.blur()`);

  const original = ((await page(`window.deckastra.currentPresentation()`)) as { presentationId: string }).presentationId;
  const findings: Record<string, unknown> = {};

  for (const theme of ["Light", "Dark"] as const) {
    await setTheme(theme);
    const toCanvas = async () => {
      for (let i = 0; i < 10 && (await region()) !== "canvas"; i += 1) await key("F6");
    };
    const views: Array<[string, () => Promise<void>]> = [
      [
        "design",
        async () => {
          await click("mode-design");
          await toCanvas();
          await key("Escape");
          await key("Escape");
        },
      ],
      [
        // An object selected: the element inspector, and the dock's controls
        // for animating it, are only on screen in this state.
        "selected",
        async () => {
          await toCanvas();
          await key("Tab");
          if (await nothingSelected()) throw new Error("Tab on the canvas selected nothing");
        },
      ],
      // The assistant beside Design (roadmap 08 §1.2 rule 2), then put away so
      // the next views audit their own panels.
      ["assistant", async () => click("open-assistant")],
      [
        "motion",
        async () => {
          await click("close-assistant");
          await click("mode-motion");
        },
      ],
      ["code", async () => click("mode-code")],
      [
        // Settings (roadmap 08 §1.3), at AI and privacy: the old Intelligence
        // drawer's content lives there now.
        "settings",
        async () => {
          if (!(await page(OPEN_SETTINGS))) throw new Error("cannot open Settings from the account menu");
          await click("settings-tab-ai");
          await until(window, `document.querySelector('[data-testid="intelligence-route"]')`, 20_000);
        },
      ],
      [
        "history",
        async () => {
          await escape();
          await click("mode-design");
          await click("open-history");
          await until(window, `document.querySelector('[data-testid="history-row"]')`, 20_000);
        },
      ],
      [
        "decks",
        async () => {
          await escape();
          await click("open-deck-list");
          await until(window, `document.querySelector('[data-testid="deck-card"]')`, 20_000);
        },
      ],
      [
        // The home's prompt bar (roadmap 08 §1.3), with its Options open so
        // the audit covers them too.
        "generate",
        async () => {
          await until(window, `document.querySelector('[data-testid="generate-instruction"]')`, 10_000);
          await page(`document.querySelector(".dk-home-prompt__options")?.setAttribute("open", "")`);
        },
      ],
    ];
    for (const [name, open] of views) {
      await open();
      findings[`${theme.toLowerCase()}/${name}`] = await audit();
      if (theme === "Dark") await capture(window, join(dir, `a11y-dark-${name}.png`));
    }
    // Back to the editor for the next theme.
    await escape();
    await page(`document.querySelector('[data-deck-id="${original}"] .dk-card__thumb').click()`);
    await until(window, `document.querySelector("[data-editor-canvas]")`, 20_000);
  }

  // Leave the profile as found.
  await setTheme("Light");
  await click("account-menu");
  await page(`[...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.trim() === "Match the system").click()`);

  record.findings = findings;
  const failing = Object.entries(findings).flatMap(([view, list]) =>
    (list as Array<{ id: string; nodes: number }>).map((violation) => `${view}: ${violation.id} ×${violation.nodes}`),
  );
  record.failing = failing;
  if (failing.length) throw new Error(`WCAG 2.1 A/AA violations in the editor chrome: ${failing.join("; ")}`);
}

/**
 * Desktop motion milestone, driven through what a person presses.
 *
 * Applies a deck style, previews without writing, authors a loop, makes an
 * explicit Magic Move copy, checks the established transition/planner controls,
 * measures motion on screen, pauses loops in present mode, then undoes the three
 * authored transactions and reloads the byte-identical saved deck.
 */
async function runMotion(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  if (!(await until(window, `document.querySelector("[data-editor-canvas]")`))) {
    throw new Error("The editor never opened for the motion smoke step.");
  }
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const helpers = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const one = (id) => document.querySelector('[data-testid="' + id + '"]');
    const exactButton = (label) => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label);
    const { presentationId } = await window.deckastra.currentPresentation();
    const stored = async () => (await (await fetch('/__api/v1/presentations/' + presentationId)).json()).document;
    const content = (doc) => JSON.stringify({ ...doc, updatedAt: undefined });
    const settle = async () => {
      let quiet = 0;
      for (let i = 0; i < 300 && quiet < 5; i += 1) {
        await sleep(100);
        quiet = one('save-status')?.getAttribute('data-save-status') === 'saved' ? quiet + 1 : 0;
      }
      if (quiet < 5) throw new Error('the editor never settled on saved');
    };
    const waitFor = async (predicate, what) => {
      for (let i = 0; i < 200; i += 1) {
        if (predicate()) return;
        await sleep(50);
      }
      throw new Error('timed out waiting for ' + what);
    };
    const click = (id) => {
      const target = one(id);
      if (!target || target.disabled) throw new Error('cannot press ' + id);
      target.click();
    };
  `;

  const styled = await page(`(async () => {
    ${helpers}
    const original = await stored();
    window.__motionSmoke = { original: content(original), slideCount: original.slides.length };
    click('mode-motion');
    await waitFor(() => one('desktop-motion-studio'), 'the desktop motion studio');
    const legacyControls = {
      panel: Boolean(one('motion-panel')),
      planner: Boolean(one('plan-submit')),
      transitionPreview: [...document.querySelectorAll('h2,h3,summary,button')].some((node) => /Preview transition/i.test(node.textContent || '')),
    };
    click('motion-style-playful');
    await settle();
    const after = await stored();
    return {
      original: window.__motionSmoke.original,
      changed: content(after) !== window.__motionSmoke.original,
      animatedSlides: after.slides.filter((slide) => slide.animations?.length).length,
      legacyControls,
    };
  })()`);
  const styledResult = styled as { original: string; changed: boolean; animatedSlides: number; legacyControls: { panel: boolean; planner: boolean; transitionPreview: boolean } };
  record.style = { changed: styledResult.changed, animatedSlides: styledResult.animatedSlides, legacyControls: styledResult.legacyControls };
  if (!Object.values(styledResult.legacyControls).every(Boolean)) {
    throw new Error("The desktop studio did not retain the transition preview and Plan by roles controls.");
  }

  await trustedClick(window, "[data-editor-canvas] [data-element-id]");
  const preview = await page(`(async () => {
    ${helpers}
    await waitFor(() => one('effect-tile-byWord') || one('effect-tile-fade'), 'an entrance effect tile');
    const before = content(await stored());
    const tile = one('effect-tile-byWord') || one('effect-tile-fade');
    tile.focus();
    await sleep(250);
    const active = Boolean(one('motion-preview-banner'));
    tile.blur();
    await sleep(50);
    return { active, documentUnchanged: content(await stored()) === before };
  })()`);
  record.preview = preview;
  if (!(preview as { active: boolean; documentUnchanged: boolean }).active || !(preview as { documentUnchanged: boolean }).documentUnchanged) {
    throw new Error("Hover/focus preview either did not run or wrote into the deck.");
  }

  const authored = await page(`(async () => {
    ${helpers}
    const loopTab = exactButton('Loop');
    if (!loopTab) throw new Error('the Loop gallery tab is missing');
    loopTab.click();
    await waitFor(() => one('effect-tile-shimmer'), 'the shimmer loop tile');
    click('effect-tile-shimmer');
    click('duplicate-magic-move');
    await waitFor(() => document.querySelectorAll('[data-testid="pair-row"]').length > 0, 'the explicit Magic Move pair list');
    await settle();
    const after = await stored();
    const copy = after.slides.find((slide) => slide.transition?.type === 'morph');
    const loops = after.slides.flatMap((slide) => slide.animations ?? []).flatMap((track) => track.clips).filter((clip) => clip.repeat === -1).length;
    const loopSlideIndex = after.slides.findIndex((slide) =>
      (slide.animations ?? []).some((track) => track.clips.some((clip) => clip.repeat === -1))
    );
    const shimmerSlideIndex = after.slides.findIndex((slide) =>
      (slide.animations ?? []).some((track) => track.clips.some((clip) => clip.preset === 'shimmer'))
    );
    return {
      loops,
      loopSlideIndex,
      shimmerSlideIndex,
      slideCount: after.slides.length,
      transition: copy?.transition?.type,
      pairs: copy?.transition?.sharedElements?.length ?? 0,
      pairRows: document.querySelectorAll('[data-testid="pair-row"]').length,
    };
  })()`);
  record.authored = authored;
  const authoredResult = authored as { loops: number; loopSlideIndex: number; shimmerSlideIndex: number; slideCount: number; transition?: string; pairs: number; pairRows: number };
  if (!authoredResult.loops || authoredResult.transition !== "morph" || !authoredResult.pairs || !authoredResult.pairRows) {
    throw new Error("The loop or explicit Magic Move was not saved.");
  }

  await page(`document.querySelectorAll('[data-testid="slide-thumb"]')[${authoredResult.shimmerSlideIndex}]?.click()`);
  await page(clickTestId("present"));
  if (!(await until(window, `document.querySelector('[data-present-stage]')`))) throw new Error("Present mode did not open.");
  await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', bubbles: true }))`);
  if (!(await until(window, `document.querySelector('.dk-present__panel')`, 5_000))) {
    throw new Error("P did not restore the presenter view shortcut.");
  }
  await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', bubbles: true }))`);
  const movement = await page(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await sleep(900);
    const nodes = [...document.querySelectorAll('[data-present-stage] [data-element-id], [data-present-stage] [data-sub-target="effect/shimmer"]')];
    const frame = () => new Map(nodes.map((node) => {
      const style = getComputedStyle(node);
      const owner = node.closest('[data-element-id]')?.getAttribute('data-element-id');
      const key = node.getAttribute('data-element-id') || ('sub:' + owner + ':' + node.getAttribute('data-sub-target'));
      return [key, [style.translate, style.scale, style.rotate, style.opacity].join('|')];
    }));
    const before = frame();
    await sleep(350);
    const after = frame();
    return [...before].filter(([id, value]) => after.get(id) !== value).map(([id]) => id);
  })()`);
  record.screenMovement = movement;
  if (!(movement as string[]).length) throw new Error("No presented element changed between measured frames.");
  if (!(movement as string[]).some((key) => key.endsWith(":effect/shimmer"))) throw new Error("The shimmer sheen did not move on screen.");
  await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', bubbles: true }))`);
  if (!(await until(window, `document.querySelector('[data-present-motion-paused="true"]')`, 5_000))) {
    throw new Error("L did not pause ambient motion.");
  }
  record.paused = true;
  await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(window, `document.querySelector('[data-editor-canvas]')`);

  const restored = await page(`(async () => {
    ${helpers}
    for (let i = 0; i < 3; i += 1) click('undo');
    await settle();
    const final = await stored();
    return { byteIdentical: content(final) === window.__motionSmoke.original, slides: final.slides.length };
  })()`);
  record.restored = restored;
  if (!(restored as { byteIdentical: boolean }).byteIdentical) {
    throw new Error("Undo did not return the deck to its byte-identical starting document.");
  }

  await window.webContents.reload();
  if (!(await until(window, `document.querySelector('[data-editor-canvas]')`, 30_000))) throw new Error("The saved deck did not reopen.");
  const reopened = await page(`(async () => {
    const { presentationId } = await window.deckastra.currentPresentation();
    const document = (await (await fetch('/__api/v1/presentations/' + presentationId)).json()).document;
    return JSON.stringify({ ...document, updatedAt: undefined });
  })()`);
  record.reopened = reopened === styledResult.original;
  if (!record.reopened) throw new Error("The reopened deck differs from the byte-identical saved document.");
  await capture(window, join(dir, "motion.png"));
}

/**
 * AI mode and the story checkpoint, driven through what a person presses
 * (editor Phase 6).
 *
 * 1. A pending change reaches the AI panel as a card with Before and After
 *    pictures drawn in this window, and Reject clears it in the store without
 *    touching the deck.
 * 2. Generate stops at an outline; Revise sends a note and stops again; Approve
 *    builds the deck and the main process opens it.
 *
 * It leaves the profile as it found it: the generated deck is deleted and the
 * original reopened. Run it on its own profile (`DECKASTRA_SMOKE_PROFILE`).
 */
async function runAi(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const openId = async () => ((await page(`window.deckastra.currentPresentation()`)) as { presentationId: string }).presentationId;
  const original = await openId();
  record.original = original;

  // ---- 1. A pending change, previewed and rejected.
  const proposal = (await page(`(async () => {
    const id = ${JSON.stringify(original)};
    const read = await (await fetch("/__api/v1/presentations/" + id)).json();
    const slide = read.document.slides[Math.min(1, read.document.slides.length - 1)];
    const targets = slide.elements.slice(0, 2).map((element) => element.id);
    if (targets.length < 2) throw new Error("the slide has too few elements to propose removing two");
    const answer = await fetch("/__api/v1/presentations/" + id + "/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: targets.map((target) => ({ op: "remove", path: "/slides/id:" + slide.id + "/elements/id:" + target })),
        intent: "Smoke: clear two objects",
        expected_version_id: read.version_id,
      }),
    });
    const body = await answer.json();
    return { status: answer.status, outcome: body.outcome, id: body.transaction_id, version: read.version_id, slideId: slide.id };
  })()`)) as { status: number; outcome: string; id: string; version: string; slideId: string };
  record.proposal = proposal;
  if (proposal.outcome !== "pending") throw new Error(`The proposal was ${proposal.outcome}, not pending (HTTP ${proposal.status}).`);

  // Pending changes live in the assistant now, under "Waiting for you".
  await page(clickTestId("open-assistant"));
  const card = `document.querySelector('[data-testid="proposal-card"][data-proposal-id="${proposal.id}"]')`;
  if (!(await until(window, `${card}?.querySelector('[data-testid="proposal-after"] [data-slide-id], [data-testid="proposal-after"] .dk-final-frame, [data-testid="proposal-after"] div')`, 30_000))) {
    throw new Error("The pending change never appeared as a card with an After picture.");
  }
  record.cardText = await page(`${card}.textContent`);
  record.pictures = await page(`(() => {
    const figure = (id) => ${card}.querySelector('[data-testid="' + id + '"]');
    const size = (node) => { const box = node?.getBoundingClientRect(); return box ? [Math.round(box.width), Math.round(box.height)] : null; };
    return { before: size(figure("proposal-before")), after: size(figure("proposal-after")), slideLine: ${card}.querySelector(".dk-proposal__meta")?.textContent ?? null };
  })()`);
  await capture(window, join(dir, "ai-proposal.png"));

  await page(`${card}.querySelector('[data-testid="proposal-reject"]').click()`);
  if (!(await until(window, `!${card}`, 20_000))) throw new Error("Reject did not clear the card.");
  const after = (await page(`(async () => {
    const id = ${JSON.stringify(original)};
    const head = await (await fetch("/__api/v1/presentations/" + id + "/head")).json();
    const pending = await (await fetch("/__api/v1/presentations/" + id + "/proposals")).json();
    return { version: head.version_id, pending: pending.length };
  })()`)) as { version: string; pending: number };
  record.afterReject = after;
  if (after.pending !== 0) throw new Error("The store still has a pending proposal after Reject.");
  if (after.version !== proposal.version) throw new Error("Rejecting changed the deck.");

  // ---- 2. Generate through the story checkpoint.
  //
  // Only where this build can generate at all. A packaged build refuses the
  // stub on purpose (item 20) and disables Generate with a reason beside it
  // (item 19), so on one of those there is no journey to drive — and reporting
  // that as a failure would have every clean-environment run go red for the
  // product working exactly as designed. Asked of the service rather than read
  // off the button, because a skip that depends on what the deck list has
  // finished rendering is a skip that fires intermittently.
  const generation = (await page(
    `fetch("/__api/v1/account").then((r) => r.json()).then((a) => a.capabilities?.generation ?? null)`,
  )) as { provider?: string; available?: boolean; reason?: string } | null;
  record.generationCapability = generation;
  // Since track 2 every desktop build routes AI through the signed-in account
  // (`sidecar.ts` sets the hosted route), so a checkout that is not signed in
  // cannot generate either. The home then says so and disables Create, which
  // the step checks before it records the skip by name.
  if (generation && generation.available === false) {
    await page(clickTestId("open-deck-list"));
    if (!(await until(window, `document.querySelector('[data-testid="generation-route"][data-available="false"]') && document.querySelector('[data-testid="generate-submit"]')?.disabled`, 20_000))) {
      throw new Error("Generation is unavailable, and the home did not say so or still offered Create.");
    }
    record.generationSkipped =
      `generation is not available here (${generation.reason ?? generation.provider ?? "no provider"}); ` +
      "the home said so and Create was disabled (items 19 and 20, roadmap 08 track 2)";
    // Put things back: the original deck open again, as the full journey ends.
    // The home lists its decks a moment after it appears; wait for the card.
    if (!(await until(window, `document.querySelector('[data-deck-id="${original}"] .dk-card__thumb')`, 20_000))) {
      throw new Error("The home never listed the deck the step started on.");
    }
    await page(`document.querySelector('[data-deck-id="${original}"] .dk-card__thumb').click()`);
    await until(window, `document.querySelector("[data-editor-canvas]")`, 20_000);
    return;
  }

  await page(clickTestId("open-deck-list"));
  // Generation lives in the home's prompt bar now (roadmap 08 §1.3).
  if (!(await until(window, `document.querySelector('[data-testid="generate-instruction"]') && !document.querySelector('[data-testid="generate-instruction"]').disabled`, 20_000))) {
    throw new Error("The home offers no prompt to describe a deck.");
  }
  // What the prompt bar tells someone before they write a brief (item 19).
  record.generationRoute = await page(
    `document.querySelector('[data-testid="generation-route"]')?.innerText ?? null`,
  );
    record.reviewOffered = await page(`!!document.querySelector('[data-testid="generate-review"]')?.checked`);
  if (!record.reviewOffered) throw new Error("This server says it cannot pause, so the outline-first option is missing.");
  await page(`(() => {
    const field = document.querySelector('[data-testid="generate-instruction"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "Why a migration needs a control tower");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page(clickTestId("generate-submit"));
  // Stop at whichever comes first — the outline, or the drawer saying why there
  // is none — and put the drawer's own words in the record.
  await until(
    window,
    `document.querySelector('[data-testid="story-checkpoint"]') || document.querySelector('[data-testid="generate-drawer"] [role="alert"], [data-testid="home-prompt"] [role="alert"]')`,
    180_000,
  );
  const refusal = (await page(
    `document.querySelector('[data-testid="generate-drawer"] [role="alert"], [data-testid="home-prompt"] [role="alert"]')?.textContent ?? null`,
  )) as string | null;
  record.generationRefusal = refusal;
  if (!(await page(`Boolean(document.querySelector('[data-testid="story-checkpoint"]'))`))) {
    // A packaged build refuses stub generation on purpose (item 20), and says
    // so in the drawer (item 19). There is then no outline to stop at, and
    // calling that a failure would have this step reporting the product
    // working as designed as though it were broken — on every clean-environment
    // run, which is the run this step most needs to be believed on. The
    // proposal journey above has already passed by here.
    // A packaged build refuses stub generation on purpose (item 20) and says so
    // in the route panel (item 19) — which is where the words are, not in an
    // alert. Keying this on an alert is why the first version of the skip never
    // fired and this step went on reporting the product working as designed as
    // a failure.
    const route = String(record.generationRoute ?? "");
    const notSetUp = /not set up|GENERATION IS NOT SET UP/i.test(route) || Boolean(refusal);
    if (app.isPackaged && notSetUp) {
      record.generationSkipped =
        "generation is not configured on this build, which is what a packaged build does (items 19 and 20)";
      return;
    }
    throw new Error(`Generation did not stop at an outline.${refusal ? ` The drawer said: ${refusal}` : ""}`);
  }
  record.outline = await page(`[...document.querySelectorAll(".dk-checkpoint__headline")].map((node) => node.textContent)`);
  await capture(window, join(dir, "ai-checkpoint.png"));

  // Revise: disabled until there is a note, then back at an outline.
  record.reviseDisabledWithoutNote = await page(`document.querySelector('[data-testid="checkpoint-revise"]').disabled`);
  await page(`(() => {
    const field = document.querySelector('[data-testid="checkpoint-note"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "Open with the cost of doing nothing.");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page(clickTestId("checkpoint-revise"));
  const ready = `document.querySelector('[data-testid="story-checkpoint"]') && !document.querySelector('[data-testid="checkpoint-approve"]').disabled && !document.querySelector(".dk-generate__working")`;
  if (!(await until(window, ready, 180_000))) throw new Error("Revising did not come back to an outline.");
  record.revised = true;

  await page(clickTestId("checkpoint-approve"));
  if (!(await until(window, `document.querySelector("[data-editor-canvas]")`, 180_000))) {
    throw new Error("Approving did not open the generated deck.");
  }
  const generated = await openId();
  record.generated = generated;
  if (generated === original) throw new Error("The main process still names the original deck as open.");
  const stored = (await page(`(async () => (await (await fetch("/__api/v1/presentations/${generated}")).json()).document.slides.length)()`)) as number;
  record.generatedSlides = stored;
  if (!stored) throw new Error("The generated deck has no slides in the store.");

  // ---- Put things back: delete the generated deck, reopen the original.
  await page(`fetch("/__api/v1/presentations/${generated}", { method: "DELETE" }).then((r) => r.status)`);
  await page(clickTestId("open-deck-list"));
  await until(window, `document.querySelector('[data-deck-id="${original}"]')`, 20_000);
  await page(`document.querySelector('[data-deck-id="${original}"] .dk-card__thumb').click()`);
  await until(window, `document.querySelector("[data-editor-canvas]")`, 20_000);
  record.restoredOpen = await openId();
  if (record.restoredOpen !== original) throw new Error("Could not reopen the original deck.");
}

/**
 * The version history drawer, driven through the buttons a person presses
 * (editor Phase 5).
 *
 * Edit the notes, open the drawer, pick the version from before the edit,
 * compare, restore — then check the **store**, not the page: the restore must be
 * a new version whose content is the old one, with the edit's version still in
 * the history. Then Undo restore, and finally restore the original once more,
 * which is also what leaves the deck exactly as the step found it.
 */
async function runHistory(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  await until(window, 'document.querySelector("[data-editor-canvas]")');
  // Notes are a tab of the dock, closed while designing.
  await needDockTab(window, "notes");

  await window.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const one = (id) => document.querySelector('[data-testid="' + id + '"]');
    const log = [];
    const { presentationId } = await window.deckastra.currentPresentation();
    const api = async (path) => {
      const answer = await fetch("/__api/v1/presentations/" + presentationId + path);
      if (!answer.ok) throw new Error("GET " + path + " answered " + answer.status);
      return answer.json();
    };
    // Everything a restore brings back; updatedAt moves with every save.
    const content = (doc) => JSON.stringify({ ...doc, updatedAt: undefined });
    const settle = async () => {
      let quiet = 0;
      for (let i = 0; i < 300 && quiet < 5; i += 1) {
        await sleep(100);
        quiet = one("save-status")?.getAttribute("data-save-status") === "saved" ? quiet + 1 : 0;
      }
      if (quiet < 5) throw new Error("the editor never settled on saved");
    };
    const waitFor = async (predicate, what) => {
      for (let i = 0; i < 200; i += 1) {
        if (predicate()) return;
        await sleep(50);
      }
      throw new Error("timed out waiting for " + what);
    };
    const click = (id) => {
      const target = one(id);
      if (!target || target.disabled) throw new Error("cannot press " + id);
      target.click();
    };
    const restoreTo = async (versionId) => {
      click("open-history");
      await waitFor(() => document.querySelector('[data-testid="history-row"][data-version-id="' + versionId + '"]'), "the row for " + versionId);
      document.querySelector('[data-testid="history-row"][data-version-id="' + versionId + '"]').click();
      await waitFor(() => one("history-preview") && !one("history-restore")?.disabled, "the preview of " + versionId);
      click("history-restore");
      await waitFor(() => !one("history-drawer") && one("restore-banner"), "the restore to land");
      await settle();
    };

    const before = await api("");
    const originalHead = before.version_id;
    const slideId = before.document.slides[0].id;

    // 1. An ordinary edit: the notes of the first slide.
    document.querySelector('[data-testid="slide-thumb"]').click();
    const notes = one("speaker-notes");
    const text = "History smoke " + Date.now();
    notes.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    notes.blur();
    await settle();
    const edited = await api("");
    if (edited.version_id === originalHead) throw new Error("the notes edit made no version");
    log.push("edited");

    // 2. Compare the version before the edit with the current deck.
    click("open-history");
    await waitFor(() => document.querySelectorAll('[data-testid="history-row"]').length >= 2, "the version rows");
    const rows = document.querySelectorAll('[data-testid="history-row"]').length;
    const drawerTitle = one("history-drawer").querySelector("h2")?.textContent;
    document.querySelector('[data-testid="history-row"][data-version-id="' + originalHead + '"]').click();
    await waitFor(() => one("history-preview"), "the preview");
    click("history-compare");
    await waitFor(() => one("history-comparison"), "the comparison");
    const marked = [...one("history-comparison").querySelectorAll("[data-change]")].map((node) => node.getAttribute("data-change"));
    if (marked[0] !== "changed") throw new Error("the first slide is not marked changed: " + marked.join(","));
    if (marked.slice(1).some((change) => change !== "same")) throw new Error("slides nobody edited are marked: " + marked.join(","));
    log.push("compared");
    window.__historySmoke = { log, rows, drawerTitle, marked, originalHead, editedHead: edited.version_id, before, slideId, text };
    return true;
  })()`);
  // The drawer open on a past version, compared with the current deck: the
  // screen the Figma frame draws.
  await capture(window, join(smokeDir()!, "history-drawer.png"));

  const result = (await window.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const one = (id) => document.querySelector('[data-testid="' + id + '"]');
    const { presentationId } = await window.deckastra.currentPresentation();
    const api = async (path) => {
      const answer = await fetch("/__api/v1/presentations/" + presentationId + path);
      if (!answer.ok) throw new Error("GET " + path + " answered " + answer.status);
      return answer.json();
    };
    // Everything a restore brings back; updatedAt moves with every save.
    const content = (doc) => JSON.stringify({ ...doc, updatedAt: undefined });
    const settle = async () => {
      let quiet = 0;
      for (let i = 0; i < 300 && quiet < 5; i += 1) {
        await sleep(100);
        quiet = one("save-status")?.getAttribute("data-save-status") === "saved" ? quiet + 1 : 0;
      }
      if (quiet < 5) throw new Error("the editor never settled on saved");
    };
    const waitFor = async (predicate, what) => {
      for (let i = 0; i < 200; i += 1) {
        if (predicate()) return;
        await sleep(50);
      }
      throw new Error("timed out waiting for " + what);
    };
    const click = (id) => {
      const target = one(id);
      if (!target || target.disabled) throw new Error("cannot press " + id);
      target.click();
    };
    const restoreTo = async (versionId) => {
      click("open-history");
      await waitFor(() => document.querySelector('[data-testid="history-row"][data-version-id="' + versionId + '"]'), "the row for " + versionId);
      document.querySelector('[data-testid="history-row"][data-version-id="' + versionId + '"]').click();
      await waitFor(() => one("history-preview") && !one("history-restore")?.disabled, "the preview of " + versionId);
      click("history-restore");
      await waitFor(() => !one("history-drawer") && one("restore-banner"), "the restore to land");
      await settle();
    };

    const { log, rows, drawerTitle, marked, originalHead, editedHead, before, slideId, text } = window.__historySmoke;
    const edited = { version_id: editedHead };

    // 3. Restore it.
    click("history-restore");
    await waitFor(() => !one("history-drawer") && one("restore-banner"), "the restore to land");
    await settle();
    const restored = await api("");
    if (content(restored.document) !== content(before.document)) throw new Error("the stored deck is not the version that was restored");
    if ([originalHead, edited.version_id].includes(restored.version_id)) throw new Error("the restore did not make a new version");
    const history = (await api("/versions")).map((version) => version.id);
    if (!history.includes(edited.version_id)) throw new Error("the edit's version left the history");
    const onScreen = one("speaker-notes").innerText.trim();
    log.push("restored");

    // 4. Undo the restore: the edit comes back.
    click("undo-restore");
    await waitFor(() => !one("restore-banner"), "the undo");
    await settle();
    const undone = await api("");
    const undoneNotes = undone.document.slides.find((slide) => slide.id === slideId)?.speakerNotes;
    if (undoneNotes !== text) throw new Error("undo restore left the notes as " + JSON.stringify(undoneNotes));
    log.push("undone");

    // 5. Leave the deck as it was found, the same way.
    await restoreTo(originalHead);
    const final = await api("");
    if (content(final.document) !== content(before.document)) throw new Error("the deck was not put back");
    log.push("put back");

    return { log, rows, drawerTitle, marked, notesOnScreenAfterRestore: onScreen, versionCount: history.length };
  })()`)) as Record<string, unknown>;

  Object.assign(record, result);
  await capture(window, join(smokeDir()!, "history.png"));
}

/**
 * Watch a shared-element morph actually move something (D4.1).
 *
 * Every other check of this is a compiled object or a mounted component. What
 * none of them can answer is whether the element *on screen* travels, because
 * that needs two slides mounted at once, a real frame loop and a real style
 * being written — and the bug it guards against is the whole reason the previous
 * implementation could not draw a morph at all.
 *
 * It samples during the transition rather than after it. A morph that ended in
 * the right place having never moved would pass any check made at the end, and
 * that is exactly what a broken delta looks like.
 */
async function runMorph(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);

  // The editor's Present button, by its test id (the toolbar is icons now).
  record.enteredPresent = await window.webContents.executeJavaScript(clickTestId("present"));
  if (!(await until(window, `document.querySelector("[data-present-stage]") !== null`))) {
    throw new Error("Present mode did not open.");
  }

  // **Walk to the boundary rather than assuming two presses reach it.** This
  // used to fire ArrowRight twice and start sampling, on the reasoning that the
  // morph is the last slide of the fixture. An independent run (2026-09-17)
  // found it standing on slide 2 — "Revealed on click" — because in present mode
  // ArrowRight advances a *click segment* first, so both presses were spent on
  // that slide's reveals and the morph gate then ran against a slide with no
  // morph on it. It failed rather than passing falsely, which is the one good
  // thing about it, and it still verified nothing.
  //
  // So: press until the index actually moves to the slide before the last one,
  // and read where we are from the DOM instead of counting keystrokes.
  const here = `(() => {
    const root = document.querySelector("[data-present-slide-id]");
    if (!root) return null;
    return {
      id: root.getAttribute("data-present-slide-id"),
      index: Number(root.getAttribute("data-present-slide-index")),
      count: Number(root.getAttribute("data-present-slide-count")),
      transition: root.getAttribute("data-present-slide-transition"),
    };
  })()`;

  type Where = { id: string; index: number; count: number; transition: string };
  const at = async (): Promise<Where> => {
    const where = (await window.webContents.executeJavaScript(here)) as Where | null;
    if (!where) throw new Error("Present mode exposes no slide id; the harness cannot say where it is.");
    return where;
  };

  const press = `(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return true;
  })()`;

  let where = await at();
  const source = where.count - 2;
  if (source < 0) throw new Error("This deck has too few slides to have a transition to watch.");

  // Bounded: a deck whose reveals never run out would otherwise loop forever,
  // and "we pressed forty times and went nowhere" is a better report than a
  // hung harness.
  for (let press_ = 0; press_ < 60 && where.index < source; press_ += 1) {
    await window.webContents.executeJavaScript(press);
    await new Promise((done) => setTimeout(done, 250));
    where = await at();
  }
  record.walkedToSlide = where;
  if (where.index !== source) {
    throw new Error(
      `Could not reach slide ${source + 1}: still on ${where.index + 1} of ${where.count} (${where.id}).`,
    );
  }

  // Settle whatever the arriving transition was doing before the one under test.
  await new Promise((done) => setTimeout(done, 900));

  // Sampling starts in the same tick as the keypress: the transition is 600ms,
  // and a first look taken after it has finished proves nothing.
  const samples = await window.webContents.executeJavaScript(`(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    const started = performance.now();
    // A settled element does not necessarily read "0px 0px": the browser
    // serialises the translate longhand with equal components as a single
    // value, so a finished morph reports "0px". Comparing against the
    // two-component string reports a bug that is not there. It did, once.
    const atRest = (value) =>
      !value || value.split(/\s+/).every((part) => parseFloat(part) === 0);
    const seen = [];
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      // The morph draws two travelling copies of each pair above both slides
      // (\`[data-morph-target]\`) and hides the originals, so the originals'
      // own boxes never move; the copies do. Watching only element boxes
      // measured the implementation this replaced (2026-09-26).
      const moving = [...document.querySelectorAll("[data-element-id], [data-morph-target]")]
        .filter((el) => !atRest(el.style.translate))
        .map((el) => ({ id: el.getAttribute("data-element-id") ?? el.getAttribute("data-morph-target"), translate: el.style.translate, scale: el.style.scale }));
      seen.push({
        at: i,
        t: Math.round(performance.now() - started),
        stages: document.querySelectorAll("[data-present-stage]").length,
        moving,
      });
    }
    return seen;
  })()`);

  // Where the press actually took us. A morph gate that never crossed into the
  // morph is the failure this whole rewrite exists to make impossible.
  const destination = await at();
  record.morphInto = destination;
  if (destination.index !== source + 1) {
    throw new Error(
      `The press did not advance the deck: still on slide ${destination.index + 1} (${destination.id}).`,
    );
  }
  if (destination.transition !== "morph") {
    throw new Error(
      `Slide ${destination.index + 1} is entered by a "${destination.transition}" transition, not a morph. ` +
        "This gate was watching the wrong boundary.",
    );
  }

  const frames = samples as { at: number; t: number; moving: unknown[] }[];
  const movedAt = frames.filter((s) => s.moving.length > 0);
  record.framesWithMovement = movedAt.length;
  record.firstMovement = movedAt[0] ?? null;
  record.lastMovement = movedAt[movedAt.length - 1] ?? null;
  record.sampledForMs = frames[frames.length - 1]?.t ?? 0;
  // Whether the loop ever wrote a settled frame at all, which is the difference
  // between "it stopped early" and "it finished and something re-displaced it".
  record.settledDuringSampling = frames.some((frame, index) => index > 2 && frame.moving.length === 0);

  await new Promise((done) => setTimeout(done, 1200));
  record.afterwards = await window.webContents.executeJavaScript(`(() => {
    const atRest = (value) => !value || value.split(/\s+/).every((part) => parseFloat(part) === 0);
    const displaced = [...document.querySelectorAll("[data-element-id]")]
      .filter((el) => !atRest(el.style.translate))
      .map((el) => ({ id: el.getAttribute("data-element-id"), translate: el.style.translate }));
    return { stillMoving: displaced.length, displaced, stages: document.querySelectorAll("[data-present-stage]").length };
  })()`);

  await capture(window, join(smokeDir()!, "morph.png"));

  if (movedAt.length === 0) {
    throw new Error(
      "No element was translated during the morph. The pair was compiled but nothing moved on screen.",
    );
  }
  const afterwards = record.afterwards as { stillMoving: number };
  if (afterwards.stillMoving !== 0) {
    throw new Error("An element was left displaced after the morph finished.");
  }
}

function clickButton(label: string): string {
  return `(() => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

/**
 * Click the element carrying `data-testid`. The editor's toolbar is icons since
 * the Bauhaus rewrite, so an exact-text match on "Rect" or "Undo" finds nothing;
 * test ids are the contract now, and they survive a relabel that text does not.
 */
/**
 * The application menu, pressed item by item (editor Phase 8).
 *
 * Each item is found by its id — the command it sends — and clicked, which runs
 * the same handler a person's click does: main picks the editor window, the
 * preload lets the name through, and the page acts. Every claim is read back from
 * the page, and the last one from the main process, which owns the open deck.
 *
 * New deck from inside a deck is the one with a handoff in it: the editor drains
 * its save queue, leaves, and the list creates and opens the deck. The deck it
 * makes is deleted again and the original reopened, so the profile ends as found.
 */
/**
 * Back up this install and put it back (final package review, item 14).
 *
 * The gate the register names is "restore into a fresh profile and recover a
 * saved deck, historical version, pending outline, image asset and unsaved
 * journal". The data half of that is asserted against the store in
 * `apps/api/tests/test_backup_round_trip.py`; what only the real app can show is
 * this: that the backup is taken **while the app is running and has unsaved
 * work on screen**, that the service can be stopped and restarted around a
 * restore, and that the editor comes back with the deck it had.
 *
 * So the step types a note and does **not** blur the field, takes the backup,
 * then changes the deck, restores, and asks the store what it holds.
 */
async function runBackup(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
  controls: SmokeControls,
): Promise<void> {
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const expect = async (what: string, expression: string, timeoutMs = 20_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`backup: ${what}`);
  };

  await expect("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
  const deck = ((await page(`window.deckastra.currentPresentation()`)) as { presentationId: string }).presentationId;

  // A note typed a moment ago and **left in its field**: it is not in the
  // document, not in the save queue and not in a journal. A backup taken now
  // used to carry every saved deck and not the sentence on screen.
  const note = `backed up at ${Date.now()}`;
  await needDockTab(window, "notes");
  const typed = (await page(`(() => {
    const notes = document.querySelector('[data-testid="speaker-notes"]');
    if (!notes) throw new Error("no speaker notes field");
    notes.focus();
    document.execCommand("insertText", false, ${JSON.stringify(note)});
    // Read it back. A harness that drives a UI has to be able to say **where it
    // arrived**: without this, a field that was present but not editable — a
    // collapsed panel, an overlay holding focus — looks exactly like a backup
    // that lost the note, and the step blames the wrong thing.
    return {
      inField: (notes.textContent || "").includes(${JSON.stringify(note)}),
      focused: document.activeElement === notes || notes.contains(document.activeElement),
      visible: notes.getClientRects().length > 0,
      mode: document.querySelector("[data-editor-mode]")?.getAttribute("data-editor-mode") ?? null,
    };
  })()`)) as { inField: boolean; focused: boolean; visible: boolean; mode: string | null };
  record.note = note;
  record.typed = typed;
  if (!typed.inField) {
    throw new Error(
      `the note never reached the notes field (focused=${typed.focused}, visible=${typed.visible}, mode=${typed.mode})`,
    );
  }

  // And a journal record for work that never reached the service, which is the
  // part of a backup the service cannot see. Written directly rather than
  // provoked: making a save genuinely fail while the same service is taking the
  // snapshot is not a state this app can be in.
  const journalKey = `deckastra.editor-recovery.v1:${deck}:acceptance`;
  await page(`localStorage.setItem(${JSON.stringify(journalKey)}, ${JSON.stringify(
    JSON.stringify({ format: 1, versionId: "ver_unsent", operations: [], labels: ["unsent"] }),
  )})`);

  const destination = join(dir, "backup");
  const manifest = await controls.backUpTo(destination);
  // Was the note in the *live* deck by the time the snapshot was asked for?
  // This separates "the drafts never settled" from "the snapshot raced the
  // save that settling started".
  record.noteLiveAfterBackup = (await page(
    `fetch("/__api/v1/presentations/${deck}").then((r) => r.json()).then((d) => JSON.stringify(d.document).includes(${JSON.stringify(
      note,
    )}))`,
  )) as boolean;
  record.backup = { decks: manifest.counts?.presentations ?? 0, assets: manifest.counts?.assets ?? 0 };

  const journals = JSON.parse(await readFile(join(destination, "journals.json"), "utf8")) as {
    key: string;
    value: string;
  }[];
  record.journalsBackedUp = journals.length;

  // The unsent journal travelled.
  if (!journals.some((entry) => entry.key === journalKey)) {
    throw new Error("the backup did not carry this window's recovery journal");
  }

  // And so did the words that were still in a field.
  //
  // **Which half of the backup holds them is recorded, not asserted**, because
  // both are correct and which one it is depends on timing. Settling the
  // drafts takes the note into the document and the recovery journal; whether
  // the save has also been acknowledged by the time the snapshot is asked for
  // is a race, and `journalled` is a legitimate answer — it is the answer item
  // 01's barrier exists to make honest. What must never happen is the note
  // being in neither, which is what this checks.
  const inDatabase = record.noteLiveAfterBackup === true;
  const inJournal = journals.some((entry) => entry.value.includes(note));
  record.noteCarriedBy = inDatabase ? (inJournal ? "database and journal" : "database") : inJournal ? "journal" : "nothing";
  if (!inDatabase && !inJournal) {
    throw new Error("the backup did not carry the note that was still in its field");
  }

  // The install moves on, the way it would between a backup and a restore.
  const titleAfter = `Renamed after the backup ${Date.now()}`;
  await page(`(async () => {
    const read = await fetch("/__api/v1/presentations/${deck}").then((r) => r.json());
    const answer = await fetch("/__api/v1/presentations/${deck}/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [{ op: "replace", path: "/metadata/title", value: ${JSON.stringify(titleAfter)} }],
        intent: "Rename after the backup",
        expected_version_id: read.version_id,
      }),
    });
    if (!answer.ok) throw new Error("could not change the deck: " + answer.status);
  })()`);

  const result = await controls.restoreFrom(destination);
  if (!result.restored || result.migrated === false) {
    throw new Error(`the restore refused: ${result.error ?? "no reason given"}`);
  }
  record.restore = { decks: result.counts?.presentations ?? 0, replaced: !!result.replaced };

  // The editor is reloaded by the restore; wait for it to come back before
  // asking the store anything through its proxy.
  await expect("the editor did not come back after the restore", `document.querySelector("[data-editor-canvas]")`, 40_000);
  const restoredDoc = (await page(
    `fetch("/__api/v1/presentations/${deck}").then((r) => r.json()).then((d) => d.document)`,
  )) as Record<string, any>;
  if (restoredDoc.metadata?.title === titleAfter) {
    throw new Error("the restore did not put the earlier deck back");
  }
  record.titleAfterRestore = restoredDoc.metadata?.title;

  // Whether the note is back in the *stored deck* is recorded and not asserted:
  // when it travelled as a journal, putting it back into the document is the
  // reopened editor replaying its recovery journal, which is item 01's
  // mechanism and its timing — not a claim this item gets to make.
  record.noteInRestoredDeck = JSON.stringify(restoredDoc.slides ?? []).includes(note);

  // And the journal is back in this window's own storage, which is the half the
  // service could never have done by itself.
  const recovered = (await page(
    `localStorage.getItem(${JSON.stringify(journalKey)}) !== null`,
  )) as boolean;
  record.journalRestored = recovered;
  if (!recovered) throw new Error("the restore did not put the recovery journal back");
}

async function runMenu(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
  controls: SmokeControls,
): Promise<void> {
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const press = (id: string) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`the application menu has no item "${id}"`);
    item.click();
  };
  const expect = async (what: string, expression: string, timeoutMs = 10_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`after the menu: ${what}`);
  };
  const current = async () =>
    ((await page(`window.deckastra.currentPresentation()`)) as { presentationId: string }).presentationId;

  await expect("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
  const original = await current();
  const checks: string[] = [];

  press("mode-code");
  await expect("View > Code did not switch mode", `document.querySelector('[data-editor-mode="code"]')`);
  press("mode-motion");
  await expect("View > Motion did not switch mode", `document.querySelector('[data-editor-mode="motion"]')`);
  press("mode-design");
  await expect("View > Design did not switch mode", `document.querySelector('[data-editor-mode="design"]')`);
  checks.push("modes");
  // The assistant is beside a mode, not one of them (roadmap 08 §1.2 rule 2).
  press("assistant");
  await expect("View > Assistant did not open it", `document.querySelector('[data-testid="assistant-panel"]')`);
  await expect("the assistant opened in another mode", `document.querySelector('[data-editor-mode="design"]')`);
  checks.push("assistant");
  // View > Command palette (Ctrl+K): it opens, and choosing a command by name
  // runs it through the same dispatcher as the menu.
  press("command-palette");
  await expect("View > Command palette did not open it", `document.querySelector('[data-testid="command-palette-input"]')`);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-testid="command-palette-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "motion");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await expect("the palette did not find Motion", `document.querySelector('[data-testid="command-mode-motion"]')`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid="command-mode-motion"]').click()`);
  await expect("choosing Motion in the palette did not switch mode", `document.querySelector('[data-editor-mode="motion"]') && !document.querySelector('[data-testid="command-palette"]')`);
  press("mode-design");
  await expect("View > Design did not switch back", `document.querySelector('[data-editor-mode="design"]')`);
  checks.push("command palette");

  press("theme-dark");
  await expect("View > Theme > Dark did not apply", `document.documentElement.dataset.dkTheme === "dark"`);
  press("theme-system");
  await expect(
    "View > Theme > Match the system did not follow the system",
    `document.documentElement.dataset.dkTheme === (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      && localStorage.getItem("deckastra.chrome-theme") === null`,
  );
  checks.push("theme");

  // View > Settings…: where decks are written, and what leaves the machine.
  // Help > Export diagnostics…: written by the main process, so the harness
  // saves it to its own directory rather than driving a native dialog (item 18).
  const reportFile = join(dir, "diagnostics.json");
  const bytes = await controls.writeDiagnostics(reportFile);
  const report = JSON.parse(await readFile(reportFile, "utf8")) as Record<string, any>;
  record.diagnostics = {
    bytes,
    version: report.app?.version,
    service: report.service?.state,
    generation: report.generation?.provider ?? report.generation?.error,
    appLogLines: report.logs?.app?.length ?? 0,
    serviceLogLines: report.logs?.service?.length ?? 0,
    signedIn: report.account?.signedIn,
  };
  if (!report.build || !report.logs || report.app?.version !== app.getVersion()) {
    throw new Error("the diagnostics report does not describe this build");
  }
  checks.push("diagnostics");

  press("open-settings");
  await expect("View > Settings did not open", `document.querySelector('[data-testid="settings"]')`);
  await page(`document.querySelector('[data-testid="settings-tab-ai"]')?.click()`);
  // It reads the account when it opens, so the route arrives a moment later.
  await expect("Settings never named the route", `document.querySelector('[data-testid="intelligence-route"]')`);
  record.intelligence = await page(`document.querySelector('[data-testid="intelligence-route"]').innerText`);
  await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  checks.push("intelligence");

  // Help > Third-party notices (item 33): a window of its own, showing the
  // file this build wrote, and nothing the menu-command path would treat as an
  // editor.
  const before = new Set(BrowserWindow.getAllWindows());
  press("third-party-notices");
  let notices: BrowserWindow | undefined;
  for (let i = 0; i < 40 && !notices; i += 1) {
    await new Promise((done) => setTimeout(done, 250));
    notices = BrowserWindow.getAllWindows().find((candidate) => !before.has(candidate));
  }
  if (!notices) throw new Error("Help > Third-party notices opened no window");
  // The window exists before its file has loaded; wait for the navigation
  // rather than a fixed half second, which a busy machine does not honour.
  for (let i = 0; i < 40 && !notices.webContents.getURL(); i += 1) await new Promise((done) => setTimeout(done, 250));
  const noticesUrl = notices.webContents.getURL();
  record.noticesUrl = noticesUrl;
  if (!/THIRD_PARTY_NOTICES\.txt$/.test(noticesUrl)) throw new Error(`the notices window shows ${noticesUrl}`);
  notices.close();
  checks.push("notices");

  press("version-history");
  await expect("Edit > Version history did not open the drawer", `document.querySelector('[data-testid="history-drawer"]')`);
  await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  checks.push("history");

  press("all-decks");
  await expect("File > All decks did not reach the deck list", `document.querySelector('[data-testid="deck-card"]')`, 20_000);
  press("undo"); // Nothing to undo on the list; it must simply do nothing.
  checks.push("all decks");

  // Back into the deck, then File > New deck from inside it.
  await page(`document.querySelector('[data-deck-id="${original}"] .dk-card__thumb').click()`);
  await expect("the original deck did not reopen", `document.querySelector("[data-editor-canvas]")`, 20_000);
  press("new-deck");
  const deadline = Date.now() + 30_000;
  let created = original;
  while (Date.now() < deadline && created === original) {
    await new Promise((done) => setTimeout(done, 250));
    created = await current();
  }
  if (created === original) throw new Error("File > New deck from inside a deck did not open a new one");
  await expect("the new deck did not open in the editor", `document.querySelector("[data-editor-canvas]")`, 20_000);
  checks.push("new deck");
  record.created = created;

  // Leave as found: delete the new deck and reopen the original.
  press("all-decks");
  await expect("could not return to the list", `document.querySelector('[data-testid="deck-card"]')`, 20_000);
  const deleted = await page(`fetch("/__api/v1/presentations/${created}", { method: "DELETE" }).then((r) => r.status)`);
  record.deleted = deleted;
  if (deleted >= 300) throw new Error(`the deck the menu created could not be deleted (${deleted})`);
  await page(`document.querySelector('[data-deck-id="${original}"] .dk-card__thumb').click()`);
  await expect("the original deck did not reopen at the end", `document.querySelector("[data-editor-canvas]")`, 20_000);
  if ((await current()) !== original) throw new Error("the main process does not name the original deck at the end");
  record.checks = checks;
}

/**
 * A note typed and the app closed at once (final package review, item 01).
 *
 * The note is left in the field — not blurred, so it has not reached the save
 * queue — and the session ends through a real path: the window's own close, or
 * `app.quit()` with `DECKASTRA_SMOKE_CLOSE=quit`. `DECKASTRA_SMOKE_CLOSE_KILL=1`
 * stops the service first, so the only way the note can survive is the
 * recovery journal. The record is written before closing, and amended as the
 * close progresses; `close-verify` relaunches on the same profile and looks.
 */
async function runClose(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
  controls: SmokeControls,
): Promise<void> {
  const file = join(dir, "close.json");
  const save = () => writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  const mode = process.env.DECKASTRA_SMOKE_CLOSE === "quit" ? "quit" : "window";
  const kill = process.env.DECKASTRA_SMOKE_CLOSE_KILL === "1";
  // The double failure the recheck found: nothing can be saved and nothing can
  // be journalled either, so the window must stay open rather than take the
  // only copy of the work with it.
  const block = process.env.DECKASTRA_SMOKE_CLOSE_BLOCK === "1";
  record.mode = mode;
  record.killedService = kill;
  record.blocked = block;
  try {
    if (!(await until(window, `document.querySelector("[data-editor-canvas]")`))) {
      throw new Error("the editor never appeared");
    }
    await needDockTab(window, "notes");
    if (!(await until(window, `document.querySelector('[data-testid="speaker-notes"]')`))) {
      throw new Error("the notes field never appeared");
    }
    if (kill || block) {
      await controls.stopService();
      await new Promise((done) => setTimeout(done, 500));
    }
    if (block) {
      record.storageBroken = await window.webContents.executeJavaScript(`(() => {
        Storage.prototype.setItem = function () { throw new DOMException("full", "QuotaExceededError"); };
        return true;
      })()`);
    }
    const marker = `Last words ${Date.now()}`;
    record.marker = marker;
    // `DECKASTRA_SMOKE_CLOSE_FIELD=canvas` types into a text box on the slide
    // instead of the notes (MA-11): opened by a real double-click, typed with
    // real input, never blurred. `DECKASTRA_SMOKE_CLOSE_IME=1` then leaves a
    // composition open through Chromium's own IME input, so the close lands
    // mid-word; the partial word must not be what is kept.
    const field = process.env.DECKASTRA_SMOKE_CLOSE_FIELD === "canvas" ? "canvas" : "notes";
    record.field = field;
    if (field === "canvas") {
      await trustedClick(window, '[data-testid="slide-thumb"]');
      const point = (await window.webContents.executeJavaScript(`(() => {
        const text = [...document.querySelectorAll("[data-editor-canvas] [data-element-id]")]
          .find((node) => node.querySelector("p, li, span") && node.getBoundingClientRect().width > 40);
        if (!text) return null;
        const r = text.getBoundingClientRect();
        text.setAttribute("data-smoke-close-target", "");
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: text.getAttribute("data-element-id") };
      })()`)) as { x: number; y: number; id: string } | null;
      if (!point) throw new Error("no text box on the first slide to type into");
      record.elementId = point.id;
      window.focus();
      window.webContents.focus();
      const send = (type: "mouseDown" | "mouseUp", clickCount: number) =>
        window.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount } as Electron.MouseInputEvent);
      window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
      send("mouseDown", 1);
      send("mouseUp", 1);
      send("mouseDown", 2);
      send("mouseUp", 2);
      if (!(await until(window, `document.querySelector('[aria-label="Edit text"]')`, 5_000))) {
        throw new Error("a real double-click did not open the text box");
      }
      await window.webContents.insertText(marker);
      if (process.env.DECKASTRA_SMOKE_CLOSE_IME === "1") {
        const partial = "かな";
        record.partial = partial;
        window.webContents.debugger.attach("1.3");
        await window.webContents.debugger.sendCommand("Input.imeSetComposition", {
          text: partial,
          selectionStart: partial.length,
          selectionEnd: partial.length,
        });
        record.composing = true;
      }
      record.typed = await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Edit text"]')?.innerText ?? null`);
    } else {
      record.typed = await window.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-testid="slide-thumb"]')?.click();
        const notes = document.querySelector('[data-testid="speaker-notes"]');
        notes.focus();
        document.execCommand("selectAll");
        document.execCommand("insertText", false, ${JSON.stringify(marker)});
        return notes.innerText;
      })()`);
    }
  } catch (error) {
    record.ok = false;
    record.error = error instanceof Error ? error.message : String(error);
    save();
    app.exit(1);
    return;
  }

  record.ok = "pending";
  record.closeRequestedAt = new Date().toISOString();
  save();
  // Stop recording once the harness has decided: the exit below destroys the
  // window itself, and an appended "closed" would make a record that refused a
  // close look as though it had allowed one.
  let decided = false;
  window.once("closed", () => {
    if (decided) return;
    record.windowClosedAt = new Date().toISOString();
    save();
  });
  app.once("will-quit", () => {
    if (decided) return;
    record.willQuitAt = new Date().toISOString();
    save();
  });
  if (mode === "quit") app.quit();
  else window.close();

  if (block) {
    // Nothing should happen: no window closed, no quit. (The harness answers
    // "keep the window open" for the modal, because nobody is there to.)
    await new Promise((done) => setTimeout(done, 8_000));
    record.windowStillOpen = !window.isDestroyed();
    record.ok = record.windowStillOpen === true && !record.willQuitAt && !record.windowClosedAt;
    if (!record.ok) record.error = "a close that could save nothing and journal nothing went ahead anyway";
    decided = true;
    save();
    await controls.stopService().catch(() => {});
    app.exit(record.ok ? 0 : 1);
    return;
  }

  // A close that was silently refused leaves the app running with nothing to
  // end it. Say so, and end it.
  setTimeout(() => {
    if (record.willQuitAt) return;
    decided = true;
    record.ok = false;
    record.error = `the ${mode} close did not finish within 20s`;
    record.windowStillOpen = !window.isDestroyed();
    save();
    void controls.stopService().finally(() => app.exit(1));
  }, 20_000);
}

/** Relaunch after `close`: the note must be in the stored deck. */
async function runCloseVerify(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const before = JSON.parse(await readFile(join(dir, "close.json"), "utf8")) as {
    marker?: string;
    mode?: string;
    field?: string;
    partial?: string;
  };
  if (!before.marker) throw new Error("close.json names no marker; run the close step first");
  record.marker = before.marker;
  record.closedBy = before.mode;
  record.field = before.field ?? "notes";
  await until(window, `document.querySelector("[data-editor-canvas]")`);
  // A journal recovered on the same base is re-sent on load, so allow a moment
  // for that save to land before reading the store.
  const deadline = Date.now() + 20_000;
  let found = false;
  while (!found && Date.now() < deadline) {
    found = (await window.webContents.executeJavaScript(`(async () => {
      const { presentationId } = await window.deckastra.currentPresentation();
      const read = await (await fetch("/__api/v1/presentations/" + presentationId)).json();
      const where = ${JSON.stringify(before.field === "canvas")}
        ? read.document.slides.map((slide) => slide.elements)
        : read.document.slides.map((slide) => slide.speakerNotes ?? null);
      return JSON.stringify(where).includes(${JSON.stringify(before.marker)});
    })()`)) as boolean;
    if (!found) await new Promise((done) => setTimeout(done, 500));
  }
  await window.webContents.executeJavaScript(openDockTab("notes"));
  record.onScreen = await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid="speaker-notes"]')?.innerText ?? null`,
  );
  if (!found) throw new Error(`the words typed before closing (${before.marker}) are not in the stored deck`);
  if (before.partial) {
    // The composition was still open when the window closed: the words before
    // it are kept, and the half-composed word is not (MA-10, MA-11).
    const stored = (await window.webContents.executeJavaScript(`(async () => {
      const { presentationId } = await window.deckastra.currentPresentation();
      const read = await (await fetch("/__api/v1/presentations/" + presentationId)).json();
      return JSON.stringify(read.document.slides.map((slide) => slide.elements));
    })()`)) as string;
    record.partialKept = stored.includes(before.partial);
    if (record.partialKept) throw new Error("the half-composed word was saved as though it were finished");
  }
}

/**
 * Choosing where decks are written, through the screen a person uses (items 19
 * and 23).
 *
 * The key is a plausible-looking test value and is never sent anywhere: saving
 * it stores it and restarts the service, which is the part worth checking —
 * that the route the app reports changes because the service was restarted with
 * the key, and changes back when it is removed. Its own profile, so nothing
 * here touches a real key.
 */
async function runIntelligence(window: BrowserWindow, record: Record<string, unknown>): Promise<void> {
  const page = (expression: string) => window.webContents.executeJavaScript(expression);
  const wait = async (what: string, expression: string, timeoutMs = 30_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(what);
  };
  const route = () => page(`document.querySelector('[data-testid="intelligence-route"]')?.innerText ?? null`);

  await wait("the editor never opened", `document.querySelector("[data-editor-canvas]")`);
  if (!(await page(OPEN_SETTINGS))) throw new Error("Settings did not open from the account menu");
  await page(`document.querySelector('[data-testid="settings-tab-ai"]')?.click()`);
  await wait("the drawer never named a route", `document.querySelector('[data-testid="intelligence-route"]')`);
  record.before = await route();

  record.account = await page(`window.deckastraAccount.state()`);
  record.credentialReadable = await page(`(async () => {
    const state = await window.deckastraAccount.state();
    return ["idToken", "refreshToken", "accessToken", "secret"].some((key) => key in state);
  })()`);
  if (record.credentialReadable) throw new Error("Account state exposed a credential to the renderer");

}

/**
 * Add a rectangle the way a person now does (design review, 2026-09-26): the
 * rail's Shapes opens the Add library, the Rectangle tile inserts one, and the
 * library is closed again so the steps after this see the layout they expect.
 * Each press goes through `clickTestId`'s hit test, so a covered control fails.
 */
const ADD_RECTANGLE = `(async () => {
  const settle = () => new Promise((done) => setTimeout(done, 150));
  if (!document.querySelector('[data-testid="library-shape-rectangle"]')) {
    if (!${clickTestId("tool-shapes")}) return false;
    await settle();
  }
  const added = ${clickTestId("library-shape-rectangle")};
  await settle();
  document.querySelector('[aria-label="Close the library"]')?.click();
  await settle();
  return added;
})()`;

/**
 * Show one tab of the dock under the canvas (roadmap 08 §1.2). Notes and the
 * timeline are closed in Design by default, so a step that types a note or
 * drags a clip opens its tab first, through the tab a person presses. Resolves
 * true once the tab's body is on screen.
 */
function openDockTab(tab: "notes" | "timeline"): string {
  return `(async () => {
    const shown = () => document.querySelector('[data-dock-panel="${tab}"]');
    if (shown()) return true;
    if (!${clickTestId(`dock-tab-${tab}`)}) return false;
    for (let i = 0; i < 40 && !shown(); i += 1) await new Promise((done) => setTimeout(done, 50));
    return Boolean(shown());
  })()`;
}

async function needDockTab(window: BrowserWindow, tab: "notes" | "timeline"): Promise<void> {
  if (!(await window.webContents.executeJavaScript(openDockTab(tab)))) {
    throw new Error(`the dock's ${tab} tab could not be opened`);
  }
}

function clickTestId(id: string): string {
  return `(() => {
    const target = document.querySelector('[data-testid="${id}"]');
    if (!target || target.disabled) return false;
    // Scrolled to, as a person would; still hit-tested below, so a control
    // under a modal or an overlay is still refused.
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === target || target.contains(hit))) return false;
    const modal = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')]
      .find((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (modal && !modal.contains(target)) return false;
    target.click();
    return true;
  })()`;
}

/**
 * Press a visible, hit-testable control through Electron's input pipeline.
 * Unlike HTMLElement.click(), this cannot activate a button hidden beneath a
 * modal or overlay and therefore provides evidence about the installed UI.
 */
export async function trustedClick(window: BrowserWindow, selector: string): Promise<void> {
  // A background launcher may hide/minimize the initial window. Trusted UI
  // acceptance requires a visible foreground page, including its head watcher.
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  window.webContents.focus();
  const point = (await window.webContents.executeJavaScript(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target || target.disabled) return { error: "missing or disabled" };
    // Scrolled into view, then measured once layout has settled — and again
    // if it had not. Content above a control can finish loading after the
    // scroll (a panel's list arriving), which pushes the control back out of
    // the window between the scroll and the press; that is a timing, not the
    // product, and a press must land where the control actually is.
    const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    let rect = target.getBoundingClientRect();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      await frames();
      const before = rect;
      rect = target.getBoundingClientRect();
      const inView = rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
      if (inView && attempt > 0 && Math.abs(rect.top - before.top) < 1) break;
      if (inView && attempt === 0) { await frames(); const again = target.getBoundingClientRect(); if (Math.abs(again.top - rect.top) < 1) break; rect = again; }
    }
    const style = getComputedStyle(target);
    if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") {
      return { error: "not visible" };
    }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === target || target.contains(hit))) {
      // Name what is in the way: "not hit-testable" alone sent a debugging
      // session looking at the wrong panel.
      const what = (node) => node ? node.tagName.toLowerCase() + (node.getAttribute("data-testid") ? "[" + node.getAttribute("data-testid") + "]" : "") + (typeof node.className === "string" && node.className ? "." + node.className.split(" ").join(".") : "") : "nothing";
      const owner = hit?.closest?.("[data-testid]");
      // And where the target sits: every ancestor that is taller than it shows,
      // with its scroll position, so "below the window" says which box failed
      // to scroll it into view.
      const boxes = [];
      for (let node = target.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const r = node.getBoundingClientRect();
          boxes.push(what(node).slice(0, 60) + " top=" + Math.round(r.top) + " h=" + Math.round(r.height) + " sh=" + node.scrollHeight + " st=" + Math.round(node.scrollTop) + " oy=" + getComputedStyle(node).overflowY);
        }
      }
      return { error: "not hit-testable: at " + x + "," + y + " of " + innerWidth + "x" + innerHeight + " is " + what(hit) + (owner ? " inside " + what(owner) : "") + "; overflowing ancestors: " + (boxes.join(" | ") || "none") };
    }
    const modal = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')]
      .find((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (modal && !modal.contains(target)) return { error: "blocked by a modal" };
    return { x, y };
  })()`)) as { x?: number; y?: number; error?: string };
  if (point.error || point.x === undefined || point.y === undefined) {
    throw new Error(`Cannot press ${selector}: ${point.error ?? "no hit point"}.`);
  }
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await new Promise((done) => setTimeout(done, 120));
}

/** The trimmed text of the element carrying `data-testid`, or null. */
function TEXT_OF(id: string): string {
  return `document.querySelector('[data-testid="${id}"]')?.textContent?.trim() ?? null`;
}

/** Slides in the strip — one thumbnail per slide, and nothing else. */
const SLIDE_COUNT = `document.querySelectorAll('[data-testid="slide-thumb"]').length`;

/** The agent-access status sentence, scoped so another status line cannot answer for it. */
const AGENT_ACCESS_STATUS = `document.querySelector('[data-testid="settings-agent-status"]')?.textContent ?? null`;

/**
 * Open Settings the way a person does since roadmap 08 §1.4 took the gear off
 * the bar: the avatar menu, then "Settings…". Resolves whether it opened.
 */
const OPEN_SETTINGS = `(async () => {
  const wait = () => new Promise((done) => setTimeout(done, 50));
  const trigger = document.querySelector('[data-testid="account-menu"]');
  if (!trigger) return false;
  trigger.click();
  for (let i = 0; i < 40; i += 1) {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => /^Settings/.test(node.textContent.trim()));
    if (item) { item.click(); break; }
    await wait();
  }
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('[data-testid="settings"]')) return true;
    await wait();
  }
  return false;
})()`;

/** Settings › Agents, open and showing its switch. The switch is where consent is given now. */
async function openAgentSettings(window: BrowserWindow): Promise<void> {
  if (!(await window.webContents.executeJavaScript(OPEN_SETTINGS))) throw new Error("Settings did not open from the account menu");
  await window.webContents.executeJavaScript(clickTestId("settings-tab-agents"));
  if (!(await until(window, `document.querySelector('[data-testid="settings-agent-toggle"]')`, 10_000))) {
    throw new Error("Settings › Agents showed no switch");
  }
}

async function closeSettings(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
}

const ELEMENT_COUNT = `document.querySelectorAll("[data-element-id]").length`;

/**
 * Kill the workspace service mid-session and see whether any work is lost.
 *
 * The claim under test is the one the whole persistence design turns on: **the
 * autosave queue is emptied by an acknowledgement, never by an attempt.** A
 * failed save must leave the edit in the queue and the document on screen, and
 * the next successful drain must carry it. Every other test of that runs against
 * a stubbed `fetch`; this one runs against a real service that really goes away.
 *
 * It is also the D1 exit gate for a crash being *visible*. A packaged app whose
 * backend died with no explanation is the worst outcome, and it is only checkable
 * by causing one.
 */
async function runResilience(
  window: BrowserWindow,
  dir: string,
  record: Record<string, unknown>,
  controls: SmokeControls,
): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);
  record.startingElements = await window.webContents.executeJavaScript(ELEMENT_COUNT);

  // A baseline edit that succeeds, so a later failure is attributable.
  await window.webContents.executeJavaScript(ADD_RECTANGLE);
  record.firstSaveAcknowledged = await until(window, `document.body.innerText.includes("Saved")`, 30_000);

  await controls.stopService();
  record.serviceStoppedReported = await until(
    window,
    `document.body.innerText.includes("workspace service")`,
    20_000,
  );

  // An edit with nowhere to go. The document must still show it, and the app must
  // not pretend it was saved.
  await window.webContents.executeJavaScript(ADD_RECTANGLE);
  await new Promise((done) => setTimeout(done, 3_000));
  record.elementsWhileDown = await window.webContents.executeJavaScript(ELEMENT_COUNT);
  record.offlineEditKeptOnScreen =
    (record.elementsWhileDown as number) > (record.startingElements as number);

  await capture(window, join(dir, "resilience-down.png"));

  // Recovered through the button a person presses, not through the harness's own
  // control (item 17): the banner offers Try again while the editor stays
  // mounted, and pressing it must actually bring the service back.
  record.retryOffered = await until(window, `document.querySelector('[data-testid="service-retry"]')`, 20_000);
  if (record.retryOffered) {
    record.retryPressed = await window.webContents.executeJavaScript(clickTestId("service-retry"));
  } else {
    // Still exercise recovery, and say the button was missing.
    await controls.startService();
  }
  // The banner itself, not a phrase: "workspace service" appears in other
  // copy, so its absence from the page says nothing about the service.
  record.recoveredToReady = await until(
    window,
    `!document.querySelector('[data-testid="service-banner"]')`,
    90_000,
  );

  // One more edit to trigger a drain. The queued work is addressed against the
  // version it was authored on, so it goes out with this one or not at all.
  await window.webContents.executeJavaScript(ADD_RECTANGLE);
  record.savedAfterRecovery = await until(window, `document.body.innerText.includes("Saved")`, 60_000);
  record.elementsAfterRecovery = await window.webContents.executeJavaScript(ELEMENT_COUNT);

  // The real assertion: reload from the service and count what it actually kept.
  // Anything the queue dropped disappears here and nowhere earlier.
  window.webContents.reload();
  await until(window, `document.querySelector("[data-editor-canvas]")`, 60_000);
  record.elementsAfterReload = await window.webContents.executeJavaScript(ELEMENT_COUNT);
  await capture(window, join(dir, "resilience-recovered.png"));

  const expected = (record.startingElements as number) + 3 * 2; // strip thumbnail + canvas
  record.expectedElements = expected;
  if (record.elementsAfterReload !== expected) {
    throw new Error(
      `Work was lost across the outage: expected ${expected} elements after reload, found ${record.elementsAfterReload}.`,
    );
  }
}

/**
 * Two editor windows on one deck.
 *
 * Electron has windows where a browser has tabs, and the recovery journal decides
 * ownership with an exclusive Web Lock — so the thing to check is that the second
 * window takes its own journal rather than the first one's. A shared writable
 * journal is how two editors overwrite each other's unsaved work.
 */
async function runWindows(
  window: BrowserWindow,
  record: Record<string, unknown>,
  controls: SmokeControls,
): Promise<void> {
  await until(window, `document.querySelector("[data-editor-canvas]")`);

  const second = controls.openEditorWindow();
  await until(second, `document.querySelector("[data-editor-canvas]")`, 60_000);
  record.bothWindowsRendered = true;

  const journals = `(() => {
    const keys = Object.keys(localStorage).filter(k => k.includes("recovery") || k.includes("deckastra"));
    return { keys, session: Object.keys(sessionStorage) };
  })()`;

  const first = (await window.webContents.executeJavaScript(journals)) as { keys: string[]; session: string[] };
  const other = (await second.webContents.executeJavaScript(journals)) as { keys: string[]; session: string[] };
  record.firstWindowStorage = first;
  record.secondWindowStorage = other;

  // Both windows edit; neither may lose the other's work.
  await window.webContents.executeJavaScript(ADD_RECTANGLE);
  await until(window, `document.body.innerText.includes("Saved")`, 30_000);
  await second.webContents.executeJavaScript(ADD_RECTANGLE);
  const secondSaved = await until(second, `document.body.innerText.includes("Saved")`, 30_000);
  record.secondWindowSaved = secondSaved;

  // A second writer against a stale version is exactly the 409 the store exists
  // to produce. Either outcome is correct; silently losing an edit is not.
  record.secondWindowSurface = await second.webContents.executeJavaScript(
    `document.body.innerText.slice(0, 400)`,
  );

  second.destroy();
}

async function waitFor(
  // Awaited, because a predicate that reads a file returns a promise — and an
  // unawaited promise is truthy, so the wait would pass instantly and every
  // assertion after it would be about a state that had not arrived yet.
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Memory across every process this app runs.
 *
 * An Electron app is not one process, so a single RSS number is not an answer —
 * the browser process, each renderer, the GPU process and the utility processes
 * all count against the machine. Reported per type and totalled, because the
 * footprint question the D0 gate asks is "what does this cost a user", and that
 * is the sum.
 */
function memoryReport(): unknown {
  const metrics = app.getAppMetrics();
  const byType: Record<string, number> = {};
  let totalKb = 0;
  for (const entry of metrics) {
    const kb = entry.memory?.workingSetSize ?? 0;
    byType[entry.type] = (byType[entry.type] ?? 0) + kb;
    totalKb += kb;
  }
  return {
    processes: metrics.length,
    totalMb: Math.round((totalKb / 1024) * 10) / 10,
    byTypeMb: Object.fromEntries(
      Object.entries(byType).map(([type, kb]) => [type, Math.round((kb / 1024) * 10) / 10]),
    ),
  };
}

export async function capture(window: BrowserWindow, file: string): Promise<void> {
  // A settle beat before the shot: the scene builds from browser text metrics,
  // and capturing mid-measurement photographs a layout no user ever sees.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const image = await window.webContents.capturePage();
  await writeFile(file, image.toPNG());
}

/**
 * The no-AI journey, with a person's input (manual-authoring review MA-29, and
 * the trusted-input half of MA-01, MA-02, MA-05 and MA-31).
 *
 * Every press, double-click, drag and keystroke here goes through Electron's
 * input pipeline (`sendInputEvent`, `insertText`), so it is hit-tested, can be
 * blocked by a modal, and meets native drag and pointer capture exactly as a
 * mouse does. `element.click()` and `dispatchEvent` cannot show the bugs this
 * step is for: the PNG that would not drag and the text that would not open on
 * a double-click both passed every synthetic-event test.
 *
 * From a blank deck: a title, a picture pasted from the system clipboard with a
 * caption, a chart whose numbers are typed in, a diagram relabelled, a summary;
 * a fade into slide 2; a reorder and its undo; the deck reopened from the list;
 * presented; exported to PDF. The page's own requests are recorded and none may
 * reach a generation or agent route. Elapsed time and every step are recorded,
 * so a target time can be agreed against a number rather than an impression.
 * The deck it made is deleted and the original reopened at the end.
 */
async function runAuthoring(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const page = <T = unknown>(js: string) => window.webContents.executeJavaScript(js) as Promise<T>;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const steps: { step: string; ms: number }[] = [];
  const started = Date.now();
  const mark = (step: string) => steps.push({ step, ms: Date.now() - started });
  const need = async (what: string, expression: string, timeoutMs = 15_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`authoring: ${what}`);
  };
  const current = async () => (await page<{ presentationId: string }>(`window.deckastra.currentPresentation()`)).presentationId;
  const stored = async (id: string) =>
    page<{ slides: Array<Record<string, any>>; assets: Array<{ id: string }> }>(
      `fetch("/__api/v1/presentations/${id}").then((r) => r.json()).then((j) => j.document)`,
    );
  const settle = async () => {
    // Saved, and still saved half a second later.
    for (let quiet = 0, i = 0; quiet < 3; i += 1) {
      if (i > 150) throw new Error("authoring: the edits never finished saving");
      await sleep(200);
      const status = await page<string | null>(`document.querySelector("[data-save-status]")?.getAttribute("data-save-status") ?? null`);
      quiet = status === "saved" ? quiet + 1 : 0;
    }
  };
  const focus = () => {
    window.focus();
    window.webContents.focus();
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as Electron.KeyboardInputEvent);
    if (keyCode.length === 1) window.webContents.sendInputEvent({ type: "char", keyCode, modifiers } as Electron.KeyboardInputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as Electron.KeyboardInputEvent);
    await sleep(150);
  };
  const type = async (text: string) => {
    focus();
    await window.webContents.insertText(text);
    await sleep(150);
  };
  const centreOf = async (selector: string) => {
    const point = await page<{ x: number; y: number } | null>(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!point) throw new Error(`authoring: nothing matches ${selector}`);
    return point;
  };
  const mouse = (type: "mouseDown" | "mouseUp" | "mouseMove", x: number, y: number, clickCount = 1) =>
    window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount } as Electron.MouseInputEvent);
  const doubleClick = async (x: number, y: number) => {
    focus();
    mouse("mouseMove", x, y);
    mouse("mouseDown", x, y, 1);
    mouse("mouseUp", x, y, 1);
    mouse("mouseDown", x, y, 2);
    mouse("mouseUp", x, y, 2);
    await sleep(300);
  };
  const drag = async (from: { x: number; y: number }, by: { x: number; y: number }) => {
    focus();
    mouse("mouseMove", from.x, from.y);
    mouse("mouseDown", from.x, from.y);
    for (let i = 1; i <= 12; i += 1) {
      mouse("mouseMove", Math.round(from.x + (by.x * i) / 12), Math.round(from.y + (by.y * i) / 12));
      await sleep(20);
    }
    mouse("mouseUp", from.x + by.x, from.y + by.y);
    await sleep(300);
  };
  /** Press the first element matching `selector` whose text is `text`, through the input pipeline. */
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
    if (!found) throw new Error(`authoring: no ${selector} reading ${String(text)}`);
    await trustedClick(window, `[data-smoke-target="${tag}"]`);
  };
  const press = (testId: string) => trustedClick(window, `[data-testid="${testId}"]`);
  /** Type into a field: click it, select what is there, replace it, Enter. */
  const fill = async (selector: string, text: string) => {
    await trustedClick(window, selector);
    await key("A", ["control"]);
    await type(text);
    await key("Enter");
  };
  /** A text box through the rail, opened with Enter and written with real typing. */
  const addText = async (words: string) => {
    const before = await page<number>(`document.querySelectorAll("[data-editor-canvas] [data-element-id]").length`);
    await press("tool-text");
    await need("the text box never appeared", `document.querySelectorAll("[data-editor-canvas] [data-element-id]").length > ${before}`);
    await key("Enter");
    await need("Enter did not open the new text box for editing (MA-05)", `document.querySelector('[aria-label="Edit text"]')`);
    await type(words);
    await key("Enter", ["control"]);
    await need("the text box did not close after Ctrl+Enter", `!document.querySelector('[aria-label="Edit text"]')`);
  };
  const addSlide = async () => {
    const count = await page<number>(SLIDE_COUNT);
    await press("add-slide");
    await need("the new slide never appeared", `${SLIDE_COUNT} === ${count + 1}`);
    await page(`document.querySelectorAll('[data-testid="slide-thumb"]')[${count}].setAttribute("data-smoke-slide", "new")`);
    await trustedClick(window, `[data-smoke-slide="new"]`);
    await page(`document.querySelector('[data-smoke-slide="new"]')?.removeAttribute("data-smoke-slide")`);
  };

  await need("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
  const original = await current();
  record.generationRoute = await page(`fetch("/__api/v1/account").then((r) => r.json()).then((a) => a.capabilities?.generation ?? null).catch(() => null)`);
  // Every request the page makes from here, so "no model request" is a record.
  await page(`(() => {
    if (window.__smokeRequests) return;
    window.__smokeRequests = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      window.__smokeRequests.push(typeof input === "string" ? input : input.url);
      return original(input, init);
    };
  })()`);

  // ---- a blank deck, from the list
  await press("open-deck-list");
  await need("the deck list never offered New deck", `document.querySelector('[data-testid="new-deck"]') && !document.querySelector('[data-testid="new-deck"]').disabled`, 20_000);
  await press("new-deck");
  let created = original;
  for (let i = 0; i < 120 && created === original; i += 1) {
    await sleep(250);
    created = await current();
  }
  if (created === original) throw new Error("authoring: New deck did not open a deck");
  await need("the new deck never opened in the editor", `document.querySelector("[data-editor-canvas]")`, 20_000);
  record.created = created;
  mark("blank deck");

  try {
    // ---- slide 1: a title, styled from the inspector
    await addText("Quarterly review");
    // The style gallery is a row of tiles, each drawn in its style (Design tab
    // review, 2026-09-26); a person presses the one that looks like a title.
    await pressText('[data-testid="text-style"] button', "Title");
    await settle();
    let deck = await stored(created);
    const title = deck.slides[0]!.elements.find((e: any) => e.type === "text");
    if (!title || title.content.blocks[0].spans.map((s: any) => s.text).join("") !== "Quarterly review") {
      throw new Error("authoring: the typed title is not what the store holds");
    }
    if (title.typography.fontFamily !== "token:typography.h1.fontFamily") throw new Error("authoring: the Title style did not apply");
    mark("title");

    // MA-01: a real double-click on the title opens it; Escape leaves it unchanged.
    const titlePoint = await centreOf(`[data-editor-canvas] [data-element-id="${title.id}"]`);
    await key("Escape");
    await doubleClick(titlePoint.x, titlePoint.y);
    record.doubleClickOpensText = await until(window, `document.querySelector('[aria-label="Edit text"]')`, 3_000);
    if (!record.doubleClickOpensText) throw new Error("authoring: a real double-click did not open the text (MA-01)");
    await key("Escape");
    mark("double-click");

    // ---- slide 2: a picture from the system clipboard, dragged, and a caption
    await addSlide();
    const png = pngOf(800, 1200, [40, 90, 200]);
    // The system clipboard, as a screenshot would leave it.
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([Buffer.from(png.base64, "base64")], { type: "image/png" }) }),
    ]);
    await trustedClick(window, "[data-editor-canvas]");
    await key("V", ["control"]);
    await need(
      "a picture pasted from the system clipboard never appeared (MA-23)",
      `document.querySelector("[data-editor-canvas] img, [data-editor-canvas] [data-asset-id]")`,
      30_000,
    );
    await settle();
    deck = await stored(created);
    const image = deck.slides[1]!.elements.find((e: any) => e.type === "image");
    if (!image) throw new Error("authoring: the store holds no picture on slide 2");
    if (image.transform.y < 0 || image.transform.y + image.transform.height > 1080) {
      throw new Error(`authoring: the portrait picture was placed off the slide at y=${image.transform.y} (MA-13)`);
    }
    // Placed at its own shape (800×1200 is 2:3), which needs the upload to have
    // recorded the picture's size. The 16:9 fallback box would mean it did not.
    const ratio = image.transform.width / image.transform.height;
    record.imagePlaced = { ...image.transform, ratio: Math.round(ratio * 1000) / 1000 };
    if (Math.abs(ratio - 800 / 1200) > 0.02) {
      throw new Error(`authoring: the portrait was placed at ${image.transform.width}×${image.transform.height}, not at its own 2:3 shape`);
    }
    const manifest = deck.assets.find((asset: any) => asset.id === image.assetId) as { width?: number; height?: number } | undefined;
    if (manifest?.width !== 800 || manifest?.height !== 1200) throw new Error("authoring: the asset manifest does not record the picture's size");
    const before = { ...image.transform };
    const imagePoint = await centreOf(`[data-editor-canvas] [data-element-id="${image.id}"]`);
    await drag(imagePoint, { x: 90, y: 40 });
    await settle();
    deck = await stored(created);
    const moved = deck.slides[1]!.elements.find((e: any) => e.id === image.id)!.transform;
    record.imageDrag = { before: { x: before.x, y: before.y }, after: { x: moved.x, y: moved.y } };
    if (moved.x === before.x && moved.y === before.y) throw new Error("authoring: dragging the picture did not move it (MA-02)");
    await key("Z", ["control"]);
    await settle();
    deck = await stored(created);
    const undone = deck.slides[1]!.elements.find((e: any) => e.id === image.id)!.transform;
    if (undone.x !== before.x || undone.y !== before.y) throw new Error("authoring: one Undo did not put the picture back");
    await key("Escape");
    await addText("Figure 1: the new office");
    mark("picture and caption");

    // ---- slide 3: a chart with typed numbers
    await addSlide();
    await press("tool-chart");
    await need("the chart grid never appeared", `document.querySelector('[data-testid="chart-grid"]')`);
    await fill(`[data-testid="chart-grid"] [aria-label="Q1, value"]`, "99");
    await settle();
    deck = await stored(created);
    const chart = deck.slides[2]!.elements.find((e: any) => e.type === "chart");
    if (chart?.data?.rows?.[0]?.value !== 99) throw new Error("authoring: the typed chart value is not in the store (MA-17)");
    mark("chart");

    // ---- slide 4: a diagram relabelled
    await addSlide();
    await press("tool-diagram");
    await need("the diagram editor never appeared", `document.querySelector('[data-testid="diagram-nodes"]')`);
    await fill(`[data-testid="diagram-nodes"] [aria-label="Box 1 label"]`, "Request");
    await settle();
    deck = await stored(created);
    const diagram = deck.slides[3]!.elements.find((e: any) => e.type === "diagram");
    if (diagram?.nodes?.[0]?.label !== "Request") throw new Error("authoring: the diagram label is not in the store (MA-19)");
    mark("diagram");

    // ---- slide 5: a summary
    await addSlide();
    await addText("Next steps: sign off the budget");
    await settle();
    mark("summary");

    // ---- a fade into slide 2, reached from the slide itself
    await page(`document.querySelectorAll('[data-testid="slide-menu"]')[1].setAttribute("data-smoke-menu", "2")`);
    await trustedClick(window, `[data-smoke-menu="2"]`);
    await pressText('[role="menuitem"]', /^Transition in:/);
    await need("the slide's menu did not open its transition", `document.querySelector('[data-testid="motion-panel"]')`);
    await press("transition-kind-fade");
    await settle();
    deck = await stored(created);
    if (deck.slides[1]!.transition?.type !== "fade") throw new Error("authoring: the fade into slide 2 is not in the store");
    await press("mode-design");
    mark("transition");

    // ---- reorder, and Undo
    const order = deck.slides.map((slide: any) => slide.id);
    await page(`document.querySelectorAll('[data-testid="slide-menu"]')[4].setAttribute("data-smoke-menu", "5")`);
    await trustedClick(window, `[data-smoke-menu="5"]`);
    await pressText('[role="menuitem"]', "Move up");
    await settle();
    deck = await stored(created);
    if (deck.slides[3]!.id !== order[4]) throw new Error("authoring: Move up did not reorder the stored deck");
    await press("undo");
    await settle();
    deck = await stored(created);
    if (JSON.stringify(deck.slides.map((slide: any) => slide.id)) !== JSON.stringify(order)) {
      throw new Error("authoring: Undo did not restore the slide order");
    }
    mark("reorder and undo");

    // ---- reopen from the list
    await press("open-deck-list");
    await need("could not return to the list", `document.querySelector('[data-deck-id="${created}"]')`, 20_000);
    await trustedClick(window, `[data-deck-id="${created}"] .dk-card__thumb`);
    await need("the deck did not reopen", `document.querySelector("[data-editor-canvas]") && ${SLIDE_COUNT} === 5`, 20_000);
    mark("reopen");

    // ---- present
    await press("present");
    await need("present mode never opened", `document.querySelector("[data-present-slide-count]")`, 15_000);
    record.presentedSlides = await page(`document.querySelector("[data-present-slide-count]").getAttribute("data-present-slide-count")`);
    if (record.presentedSlides !== "5") throw new Error(`authoring: present mode shows ${record.presentedSlides} slides`);
    await key("Escape");
    await need("present mode did not close", `document.querySelector("[data-editor-canvas]")`, 10_000);
    mark("present");

    // ---- export
    await press("open-share");
    await pressText('[data-testid="export-popover"] button', "PDF");
    record.exportFinished = await until(
      window,
      `(() => {
        const panel = [...document.querySelectorAll("section")].find(s => /^\\s*EXPORT/.test(s.innerText || ""));
        return Boolean(panel && [...panel.querySelectorAll("button")].some(b => /^Download /.test(b.textContent || "")));
      })()`,
      180_000,
    );
    if (!record.exportFinished) throw new Error("authoring: the PDF export never finished");
    mark("export");
    await capture(window, join(dir, "authoring.png"));

    const requests = (await page<string[]>(`window.__smokeRequests || []`)) ?? [];
    const model = requests.filter((url) => /\/(generate|runs|agent|proposals)(\/|\?|$)/.test(url));
    record.requestCount = requests.length;
    record.modelRequests = model;
    if (model.length > 0) throw new Error(`authoring: the journey reached a model route: ${model[0]}`);
  } finally {
    record.steps = steps;
    record.elapsedMs = Date.now() - started;
    // Leave as found.
    await page(`fetch("/__api/v1/presentations/${created}", { method: "DELETE" }).then((r) => r.status)`).catch(() => undefined);
    await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(original)} })`).catch(() => undefined);
  }
}

/**
 * The Design tab (Design tab review, 2026-09-26), in the real window.
 *
 * On a deck of its own: every panel hidden and shown again, and focus mode;
 * a gradient slide background; the Glassmorphism preset applied with its
 * cards restyled and then undone; a font uploaded and used on the title; an
 * equation inserted from the rail and its LaTeX retyped. Each result is read
 * from the store. Then the deck is exported to PDF and PowerPoint through the
 * service, and both files are written beside the record so readers that are
 * not us (`pypdf`, `python-pptx`) can be run over them. The deck is deleted
 * and the original reopened at the end.
 *
 * The font is one of the app's own bundled files, taken from beside the
 * exporter, because a packaged build carries nothing else to upload. It is
 * handed to the upload field as a real `File`, which is the one step here that
 * cannot go through the input pipeline: a native file dialog is outside the
 * page.
 */
async function runDesign(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const page = <T = unknown>(js: string) => window.webContents.executeJavaScript(js) as Promise<T>;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const need = async (what: string, expression: string, timeoutMs = 15_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`design: ${what}`);
  };
  const current = async () => (await page<{ presentationId: string }>(`window.deckastra.currentPresentation()`)).presentationId;
  const stored = async (id: string) =>
    page<{ slides: Array<Record<string, any>>; assets: Array<Record<string, any>>; theme: Record<string, any> }>(
      `fetch("/__api/v1/presentations/${id}").then((r) => r.json()).then((j) => j.document)`,
    );
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 3; i += 1) {
      if (i > 150) throw new Error("design: the edits never finished saving");
      await sleep(200);
      const status = await page<string | null>(`document.querySelector("[data-save-status]")?.getAttribute("data-save-status") ?? null`);
      quiet = status === "saved" ? quiet + 1 : 0;
    }
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as Electron.KeyboardInputEvent);
    if (keyCode.length === 1) window.webContents.sendInputEvent({ type: "char", keyCode, modifiers } as Electron.KeyboardInputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as Electron.KeyboardInputEvent);
    await sleep(150);
  };
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
    if (!found) throw new Error(`design: no ${selector} reading ${String(text)}`);
    await trustedClick(window, `[data-smoke-target="${tag}"]`);
  };
  const press = (testId: string) => trustedClick(window, `[data-testid="${testId}"]`);
  const region = (name: string) => `Boolean(document.querySelector('[data-region="${name}"]'))`;
  const openSection = async (title: RegExp) => {
    const open = await page<boolean>(`(() => {
      const toggle = [...document.querySelectorAll(".dk-section__toggle")].find((b) => ${title.toString()}.test((b.textContent || "").trim()));
      return toggle ? toggle.getAttribute("aria-expanded") === "true" : false;
    })()`);
    if (!open) await pressText(".dk-section__toggle", title);
  };

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
  if (created === original) throw new Error("design: New deck did not open a deck");
  await need("the new deck never opened in the editor", `document.querySelector("[data-editor-canvas]")`, 20_000);
  record.created = created;

  try {
    // ---- panels: each one away and back through the menu, then focus mode
    // The dock's tabs start put away in Design (roadmap 08 §1.2) unless an
    // earlier step on this profile opened them, so each panel is toggled from
    // wherever it starts and must end there again.
    const shown: Record<string, string> = {
      "Insert tools": region("tools"),
      Slides: region("slides"),
      "Side panel": region("panel"),
      "Speaker notes": `Boolean(document.querySelector('[data-dock-panel="notes"]'))`,
      Timeline: `Boolean(document.querySelector('[data-dock-panel="timeline"]'))`,
    };
    // Through the View menu: the bar's panels button is gone (roadmap 08 §1.4).
    const menuItem: Record<string, string> = {
      "Insert tools": "panel-tools",
      Slides: "panel-slides",
      "Side panel": "panel-inspector",
      "Speaker notes": "panel-notes",
      Timeline: "panel-dock",
    };
    const viewMenu = (label: string) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(menuItem[label]!);
      if (!item) throw new Error(`design: the View menu has no ${label} item`);
      item.click();
    };
    const toggled: Array<{ panel: string; startedShown: boolean }> = [];
    for (const [label, expression] of Object.entries(shown)) {
      const before = await page<boolean>(expression);
      viewMenu(label);
      await need(`toggling ${label} did not ${before ? "hide" : "show"} it`, before ? `!(${expression})` : expression, 5_000);
      viewMenu(label);
      await need(`toggling ${label} again did not put it back`, before ? expression : `!(${expression})`, 5_000);
      toggled.push({ panel: label, startedShown: before });
    }
    record.panelsToggled = toggled;
    await trustedClick(window, "[data-editor-canvas]");
    await key(".", ["control"]);
    await need("focus mode left a side panel on screen", `!${region("tools")} && !${region("slides")} && !${region("panel")}`, 5_000);
    record.focusModeCanvasOnly = true;
    await key(".", ["control"]);
    await need("leaving focus mode did not bring the panels back", `${region("tools")} && ${region("slides")} && ${region("panel")}`, 5_000);

    // ---- a gradient background on the slide
    await key("Escape");
    await openSection(/^Slide background/i);
    await pressText('[role="radiogroup"][aria-label="Background type"] [role="radio"]', "Colour");
    await pressText('[data-testid="background-paint"] [role="radio"]', "Gradient");
    await settle();
    let deck = await stored(created);
    const paint = deck.slides[0]!.background?.paint;
    if (paint?.type !== "linearGradient" && paint?.type !== "radialGradient") {
      throw new Error(`design: the stored background is ${JSON.stringify(deck.slides[0]!.background)}, not a gradient`);
    }
    record.background = paint.type;

    // ---- the Glassmorphism preset, with a card to restyle, applied and undone
    if (!(await page<boolean>(ADD_RECTANGLE))) throw new Error("design: the Add library did not add a rectangle");
    await settle();
    const themeBefore = JSON.stringify((await stored(created)).theme);
    await key("Escape");
    await openSection(/^Theme/);
    await press("preset-glassmorphism");
    await page(`(() => { const box = document.querySelector('[data-testid="theme-restyle"]'); if (box && !box.checked) box.click(); })()`);
    await press("theme-apply-preset");
    await settle();
    deck = await stored(created);
    const card = deck.slides[0]!.elements.find((element: any) => element.type === "shape");
    record.glassApplied = { theme: deck.theme.name, cardBlur: card?.style?.backdropFilters?.[0]?.radius ?? null };
    if (!/glass/i.test(String(deck.theme.name))) throw new Error(`design: the theme is ${deck.theme.name} after applying Glassmorphism`);
    if (!card?.style?.backdropFilters?.length) throw new Error("design: the card was not restyled with a glass blur");
    await press("undo");
    await settle();
    if (JSON.stringify((await stored(created)).theme) !== themeBefore) throw new Error("design: one Undo did not put the previous theme back");
    record.glassUndone = true;

    // ---- a font, uploaded and used on a title
    await press("tool-text");
    await key("Enter");
    await need("Enter did not open the new text box", `document.querySelector('[aria-label="Edit text"]')`);
    await window.webContents.insertText("Designed by hand");
    await key("Enter", ["control"]);
    const fontsDir = app.isPackaged ? join(process.resourcesPath, "worker", "fonts") : join(import.meta.dirname, "..", "worker", "fonts");
    const fontBytes = await readFile(join(fontsDir, "@fontsource", "archivo-black", "files", "archivo-black-latin-400-normal.woff2"));
    await press("font-family");
    await need("the font picker did not open", `document.querySelector('[data-testid="font-upload-input"]')`, 5_000);
    await page(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(fontBytes.toString("base64"))}), (c) => c.charCodeAt(0));
      const file = new File([bytes], "Smoke-Display-Regular.woff2", { type: "font/woff2" });
      const input = document.querySelector('[data-testid="font-upload-input"]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await need("the font upload never finished", `/^Using /.test(document.querySelector('[data-testid="font-upload-status"]')?.textContent || "")`, 30_000);
    await settle();
    deck = await stored(created);
    const face = deck.assets.find((asset: any) => asset.type === "font");
    const title = deck.slides[0]!.elements.find((element: any) => element.type === "text");
    if (!face?.fontFamily) throw new Error("design: the deck does not declare the uploaded font");
    if (title?.typography?.fontFamily !== face.fontFamily) {
      throw new Error(`design: the title uses ${title?.typography?.fontFamily}, not ${face.fontFamily}`);
    }
    record.uploadedFont = face.fontFamily;
    // Drawn in it on the canvas, not only named: the face actually loaded.
    await need(
      "the uploaded face never loaded in the editor",
      `[...document.fonts].some((f) => f.family.replace(/"/g, "") === ${JSON.stringify(face.fontFamily)} && f.status === "loaded")`,
      15_000,
    );

    // ---- a named colour: made in the Colours panel, used on the title, changed once
    await openSection(/^Colours/);
    await press("open-color-studio");
    await need("the Colours panel did not open", `document.querySelector('[data-testid="color-studio"]')`, 5_000);
    await pressText('[data-testid="color-studio"] [role="tab"]', /^Named/);
    await trustedClick(window, '[data-testid="named-color-name"]');
    await window.webContents.insertText("Smoke red");
    await trustedClick(window, '[data-testid="named-color-value"]');
    await key("A", ["control"]);
    await window.webContents.insertText("#C0142B");
    await press("named-color-add");
    await settle();
    deck = await stored(created);
    if ((deck.theme.colors as { custom?: Record<string, string> }).custom?.["Smoke red"] !== "#C0142B") {
      throw new Error("design: the named colour is not in the stored theme");
    }
    // The panel sits over the inspector; close it, and the title (still
    // selected) offers the new name in its colour picker.
    await trustedClick(window, '[data-testid="color-studio"] button[aria-label="Close colours"]');
    await need("the Colours panel did not close", `!document.querySelector('[data-testid="color-studio"]')`, 5_000);
    await trustedClick(window, '[data-testid="text-color"] .dk-colorfield__trigger');
    await trustedClick(window, '[role="option"][aria-label="Smoke red"]');
    await settle();
    deck = await stored(created);
    const coloured = deck.slides[0]!.elements.find((element: any) => element.type === "text");
    if (coloured?.typography?.color !== "token:colors.custom.Smoke red") {
      throw new Error(`design: the title's colour is ${coloured?.typography?.color}, not the named colour`);
    }
    // Change the colour once, in the panel: the title follows without being touched.
    await press("open-color-studio");
    await need("the Colours panel did not reopen", `document.querySelector('[data-testid="color-studio"]')`, 5_000);
    await pressText('[data-testid="color-studio"] [role="tab"]', /^Named/);
    await trustedClick(window, '[data-testid="color-editor-hex"]');
    await key("A", ["control"]);
    await window.webContents.insertText("#1F7A3D");
    await key("Enter");
    await settle();
    deck = await stored(created);
    const custom = (deck.theme.colors as { custom?: Record<string, string> }).custom ?? {};
    const still = deck.slides[0]!.elements.find((element: any) => element.type === "text");
    if (custom["Smoke red"] !== "#1F7A3D" || still?.typography?.color !== "token:colors.custom.Smoke red") {
      throw new Error("design: changing the named colour did not carry to the title by reference");
    }
    record.namedColor = { name: "Smoke red", value: custom["Smoke red"], titleColor: still.typography.color };
    await trustedClick(window, '[data-testid="color-studio"] button[aria-label="Close colours"]');

    // ---- design review, 2026-09-27: pop-ups over the slide, Design Check,
    // object styles and a row that keeps its spacing, each through the window.

    // A pop-up opened from the right panel lies over everything, inside the
    // window, rather than clipped by the panel it was opened from.
    await trustedClick(window, '[data-testid="text-color"] .dk-colorfield__trigger');
    const popup = await page<{ body: boolean; inside: boolean; onTop: boolean } | null>(`(() => {
      const panel = [...document.querySelectorAll(".dk-popover")].find((p) => !p.hidden);
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      const corners = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]];
      return {
        body: panel.parentElement === document.body,
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        onTop: corners.every(([x, y]) => panel.contains(document.elementFromPoint(x, y))),
      };
    })()`);
    if (!popup?.body || !popup.inside || !popup.onTop) throw new Error(`design: the colour pop-up is not over everything: ${JSON.stringify(popup)}`);
    record.popupOverlays = popup;
    await key("Escape");

    // Two more rectangles land where the first one is. Design Check finds the
    // collisions and Fix all moves them apart, in one patch.
    await key("Escape");
    for (let i = 0; i < 2; i += 1) {
      if (!(await page<boolean>(ADD_RECTANGLE))) throw new Error("design: the Add library did not add a rectangle");
      await settle();
    }
    await press("tool-check");
    await need("Design Check did not open", `document.querySelector('[data-testid="design-check"]')`, 5_000);
    await need("Design Check did not find the overlapping rectangles", `document.querySelectorAll('[data-testid="design-check"] li[data-code="W110"]').length > 0`, 10_000);
    const overlaps = await page<number>(`document.querySelectorAll('[data-testid="design-check"] li[data-code="W110"]').length`);
    await press("check-fix-all");
    await settle();
    await need("Fix all left an overlap", `document.querySelectorAll('[data-testid="design-check"] li[data-code="W110"]').length === 0`, 10_000);
    record.designCheck = { overlapsFound: overlaps, afterFixAll: 0 };
    await trustedClick(window, 'button[aria-label="Close check"]');

    // A style saved from one rectangle, applied to another, then updated from
    // the first: the second follows, in the stored deck.
    deck = await stored(created);
    const rects = deck.slides[0]!.elements.filter((element: any) => element.type === "shape");
    if (rects.length < 3) throw new Error(`design: expected three rectangles, found ${rects.length}`);
    const [first, second] = [rects[0]!.id as string, rects[1]!.id as string];
    // Chosen from the Layers panel: after Fix all the boxes are wherever the
    // fixes put them, and a list is how a keyboard user picks one anyway.
    await press("tool-layers");
    await need("the Layers panel did not open", `document.querySelector('[data-testid="layers-panel"]')`, 5_000);
    const pick = (id: string) => trustedClick(window, `[data-layer-id="${id}"]`);
    await pick(first);
    await openSection(/^Object style/);
    await press("style-save-open");
    await trustedClick(window, '[data-testid="style-name"]');
    await window.webContents.insertText("Smoke card");
    await press("style-save");
    await settle();
    await pick(second);
    await openSection(/^Object style/);
    await press("style-apply");
    await pressText('[role="option"]', /^Smoke card/);
    await settle();
    await pick(first);
    await openSection(/^Fill & outline/);
    await trustedClick(window, '[data-testid="fill-paint"] .dk-colorfield__trigger');
    await trustedClick(window, '.dk-popover [role="option"].dk-swatch:not(.dk-swatch--none):not([aria-selected="true"])');
    await settle();
    await openSection(/^Object style/);
    await need("changing the fill did not show the style as changed", `document.querySelector('[data-testid="style-update"]')`, 5_000);
    await press("style-update");
    await settle();
    deck = await stored(created);
    const byId = (id: string) => deck.slides[0]!.elements.find((element: any) => element.id === id);
    if (byId(first)?.styleRef !== "Smoke card" || byId(second)?.styleRef !== "Smoke card") throw new Error("design: the style is not named on both rectangles");
    if (JSON.stringify(byId(first)?.style?.fill) !== JSON.stringify(byId(second)?.style?.fill)) {
      throw new Error("design: updating the style did not carry the new fill to the other rectangle");
    }
    record.objectStyle = { name: "Smoke card", fill: byId(second)?.style?.fill };

    // Everything on the slide as a row that keeps its spacing, then undone.
    await key("Escape");
    await trustedClick(window, "[data-editor-canvas]");
    await key("A", ["control"]);
    await openSection(/^Layout/);
    await press("layout-horizontal");
    await settle();
    deck = await stored(created);
    const row = deck.slides[0]!.elements.find((element: any) => element.type === "group" && element.containerLayout?.type === "horizontal");
    if (!row) throw new Error("design: Row did not make a laid-out group");
    record.row = { children: row.children.length, gap: row.containerLayout.gap };
    await press("undo");
    await settle();
    if ((await stored(created)).slides[0]!.elements.some((element: any) => element.type === "group")) throw new Error("design: one Undo did not take the row apart");
    const heading = (await stored(created)).slides[0]!.elements.find((element: any) => element.type === "text");
    if (heading) await pick(heading.id);
    await trustedClick(window, 'button[aria-label="Close layers"]');

    // ---- an equation, from the rail, retyped in the inspector
    await key("Escape");
    await press("tool-equation");
    await need("the equation section did not open", `document.querySelector('[data-testid="equation-latex"]')`, 5_000);
    await trustedClick(window, '[data-testid="equation-latex"]');
    await key("A", ["control"]);
    await window.webContents.insertText("e^{i\\pi} + 1 = 0");
    await key("Enter", ["control"]);
    await settle();
    deck = await stored(created);
    const equation = deck.slides[0]!.elements.find((element: any) => element.type === "equation");
    if (equation?.latex !== "e^{i\\pi} + 1 = 0") throw new Error(`design: the stored equation is ${JSON.stringify(equation?.latex)}`);
    await need("the equation is not typeset on the canvas", `document.querySelector('[data-editor-canvas] .deckastra-equation .katex')`, 5_000);
    record.equation = equation.latex;
    await capture(window, join(dir, "design.png"));

    // ---- both exports, kept for readers that are not us
    for (const kind of ["pdf", "pptx"] as const) {
      const started = await page<{ id?: string }>(
        `fetch("/__api/v1/presentations/${created}/exports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "${kind}" }) }).then((r) => r.json())`,
      );
      if (!started.id) throw new Error(`design: the ${kind} export was refused: ${JSON.stringify(started)}`);
      let status = "";
      for (let i = 0; i < 360 && !["completed", "failed", "cancelled"].includes(status); i += 1) {
        await sleep(500);
        status = (await page<{ status: string }>(`fetch("/__api/v1/exports/${started.id}").then((r) => r.json())`)).status;
      }
      if (status !== "completed") throw new Error(`design: the ${kind} export ended ${status || "never"}`);
      const base64 = await page<string>(
        `fetch("/__api/v1/exports/${started.id}/download").then((r) => r.arrayBuffer()).then((b) => { let s = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 1) s += String.fromCharCode(u[i]); return btoa(s); })`,
      );
      const bytes = Buffer.from(base64, "base64");
      await writeFile(join(dir, `design.${kind}`), bytes);
      record[`${kind}Bytes`] = bytes.length;
    }
  } finally {
    await page(`fetch("/__api/v1/presentations/${created}", { method: "DELETE" }).then((r) => r.status)`).catch(() => undefined);
    await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(original)} })`).catch(() => undefined);
  }
}

/**
 * An agent builds, a person takes over (manual-authoring plan MA-28).
 *
 * Agent access is allowed through the window's own control; the agent half
 * (`apps/mcp-server/scripts/handoff.mjs`) then runs the real stdio MCP server
 * against this app and builds a deck of the shapes generated decks are made of:
 * a card that is a group holding a rotated group, a labelled shape, a chart, a
 * table, planned motion, and one destructive change left pending. Then the
 * person, with real input on the same deck: retypes the agent's headline,
 * ungroups the card, steps into the inner group and relabels the shape, pastes
 * a picture and undoes it, types a chart value and a table cell, finds the
 * agent's pending change refused because the deck moved under it, reopens the
 * deck, and exports it to PDF and PowerPoint.
 *
 * A checkout only: the agent half runs this repository's server through tsx.
 * On an installed candidate point `DECKASTRA_MCP_COMMAND` / `DECKASTRA_MCP_ARGS`
 * at the bundled server, as `acceptance.mjs` documents.
 */
async function runHandoff(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const { spawn } = await import("node:child_process");
  const page = <T = unknown>(js: string) => window.webContents.executeJavaScript(js) as Promise<T>;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const need = async (what: string, expression: string, timeoutMs = 15_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`handoff: ${what}`);
  };
  const current = async () => (await page<{ presentationId: string }>(`window.deckastra.currentPresentation()`)).presentationId;
  const stored = async (id: string) =>
    page<{ slides: Array<Record<string, any>> }>(`fetch("/__api/v1/presentations/${id}").then((r) => r.json()).then((j) => j.document)`);
  const find = (deck: { slides: Array<Record<string, any>> }, id: string): any => {
    const walk = (elements: any[]): any => {
      for (const element of elements ?? []) {
        if (element.id === id) return element;
        const inner = walk(element.children);
        if (inner) return inner;
      }
      return undefined;
    };
    for (const slide of deck.slides) {
      const hit = walk(slide.elements);
      if (hit) return hit;
    }
    return undefined;
  };
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 3; i += 1) {
      if (i > 150) throw new Error("handoff: the edits never finished saving");
      await sleep(200);
      const status = await page<string | null>(`document.querySelector("[data-save-status]")?.getAttribute("data-save-status") ?? null`);
      quiet = status === "saved" ? quiet + 1 : 0;
    }
  };
  const focus = () => {
    window.focus();
    window.webContents.focus();
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as Electron.KeyboardInputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as Electron.KeyboardInputEvent);
    await sleep(200);
  };
  const type = async (text: string) => {
    focus();
    await window.webContents.insertText(text);
    await sleep(150);
  };
  const centre = async (id: string) => {
    const point = await page<{ x: number; y: number } | null>(`(() => {
      const node = document.querySelector('[data-editor-canvas] [data-element-id="${id}"]');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!point) throw new Error(`handoff: ${id} is not on the canvas`);
    return point;
  };
  const clickAt = async (point: { x: number; y: number }, clickCount = 1) => {
    focus();
    window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    for (let n = 1; n <= clickCount; n += 1) {
      window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: n } as Electron.MouseInputEvent);
      window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: n } as Electron.MouseInputEvent);
    }
    await sleep(300);
  };
  const fill = async (selector: string, text: string) => {
    await trustedClick(window, selector);
    await key("A", ["control"]);
    await type(text);
    await key("Enter");
  };
  const exportAs = async (label: string, extension: string) => {
    await trustedClick(window, '[data-testid="open-share"]');
    const tag = `export-${extension}`;
    const found = await page<boolean>(`(() => {
      const button = [...document.querySelectorAll('[data-testid="export-popover"] button')].find((b) => b.textContent.trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())});
      if (!button) return false;
      button.setAttribute("data-smoke-target", ${JSON.stringify(tag)});
      return true;
    })()`);
    if (!found) throw new Error(`handoff: no ${label} export button`);
    await trustedClick(window, `[data-smoke-target="${tag}"]`);
    return until(
      window,
      `[...document.querySelectorAll('[data-testid="export-popover"] button')].some((b) => /^Download .*\\.${extension}$/i.test(b.textContent.trim()))`,
      180_000,
    );
  };

  await need("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
  const original = await current();

  // ---- the person allows agent access, through the window
  const attachment = join(app.getPath("userData"), "attachment.json");
  await openAgentSettings(window);
  await trustedClick(window, '[data-testid="settings-agent-toggle"]');
  for (let i = 0; i < 60 && !(await readFile(attachment, "utf8").then(() => true, () => false)); i += 1) await sleep(250);
  await key("Escape");

  // ---- the agent half, over the real MCP server
  const script = join(app.getAppPath(), "..", "mcp-server", "scripts", "handoff.mjs");
  const agent = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DECKASTRA_ATTACHMENT: attachment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => done({ code, out, err }));
  });
  if (agent.code !== 0) throw new Error(`handoff: the agent half failed: ${agent.err.slice(-600)}`);
  const made = JSON.parse(agent.out.trim().split("\n").at(-1)!) as Record<string, any>;
  record.agent = made;
  const outcomes = (made.calls as Array<{ outcome: string }>).map((call) => call.outcome);
  if (outcomes.slice(0, 3).some((outcome) => outcome !== "applied")) throw new Error(`handoff: agent changes did not apply: ${outcomes}`);
  if (outcomes[3] !== "pending" || !made.pendingProposalId) throw new Error("handoff: the destructive change was not held for a person");
  const deckId = made.presentationId as string;

  try {
    // ---- the person takes over
    await trustedClick(window, '[data-testid="open-deck-list"]');
    await need("the agent's deck is not in the list", `document.querySelector('[data-deck-id="${deckId}"]')`, 20_000);
    await trustedClick(window, `[data-deck-id="${deckId}"] .dk-card__thumb`);
    await need("the agent's deck did not open", `document.querySelector('[data-editor-canvas] [data-element-id="${made.headline}"]')`, 20_000);

    // Retype the agent's headline, opened by a real double-click.
    await clickAt(await centre(made.headline), 2);
    await need("a double-click did not open the agent's headline", `document.querySelector('[aria-label="Edit text"]')`, 5_000);
    await key("A", ["control"]);
    await type("Person-edited headline");
    await key("Enter", ["control"]);
    await settle();
    let deck = await stored(deckId);
    if (find(deck, made.headline)?.content.blocks[0].spans[0].text !== "Person-edited headline") {
      throw new Error("handoff: the headline edit is not in the store");
    }

    // Ungroup the agent's card; the inner group survives, as does its paint.
    await clickAt(await centre(made.cardText));
    await key("G", ["control", "shift"]);
    await settle();
    deck = await stored(deckId);
    if (find(deck, made.card)) throw new Error("handoff: the card is still a group after Ctrl+Shift+G");
    if (!deck.slides[0]!.elements.some((element: any) => element.id === made.inner)) throw new Error("handoff: the inner group did not come out");
    record.ungroupedBackground = deck.slides[0]!.elements.some((element: any) => element.name === "Card background");

    // Into the rotated inner group, and edit the shape's label.
    await clickAt(await centre(made.cardBox));
    await key("Enter");
    await key("Enter");
    await need("Enter did not open the shape's label", `document.querySelector('[aria-label="Edit text"]')`, 5_000);
    await key("A", ["control"]);
    await type("Person label");
    await key("Enter", ["control"]);
    await settle();
    deck = await stored(deckId);
    if (find(deck, made.cardBox)?.text?.blocks[0].spans[0].text !== "Person label") throw new Error("handoff: the shape label edit is not in the store");
    await key("Escape");
    await key("Escape");

    // A picture pasted, then undone.
    const png = pngOf(640, 360, [200, 80, 40]);
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([Buffer.from(png.base64, "base64")], { type: "image/png" }) })]);
    await trustedClick(window, "[data-editor-canvas]");
    await key("V", ["control"]);
    await need("the pasted picture never appeared", `document.querySelector("[data-editor-canvas] img, [data-editor-canvas] [data-asset-id]")`, 30_000);
    await settle();
    await key("Z", ["control"]);
    await settle();
    deck = await stored(deckId);
    if (deck.slides[0]!.elements.some((element: any) => element.type === "image")) throw new Error("handoff: Undo did not remove the pasted picture");

    // The data slide: a chart value and a table cell, typed.
    await page(`document.querySelectorAll('[data-testid="slide-thumb"]')[1].setAttribute("data-smoke-slide", "2")`);
    await trustedClick(window, '[data-smoke-slide="2"]');
    await need("the data slide did not show", `document.querySelector('[data-editor-canvas] [data-element-id="${made.chart}"]')`);
    await clickAt(await centre(made.chart));
    await need("the chart grid did not appear", `document.querySelector('[data-testid="chart-grid"]')`);
    await fill(`[data-testid="chart-grid"] [aria-label="Q1, revenue"]`, "25");
    await clickAt(await centre(made.table));
    await need("the table grid did not appear", `document.querySelector('[data-testid="table-grid"]')`);
    await fill(`[data-testid="table-grid"] [aria-label="Row 1, Share"]`, "45%");
    await settle();
    deck = await stored(deckId);
    if (find(deck, made.chart)?.data.rows[0].revenue !== 25) throw new Error("handoff: the chart value is not in the store");
    if (find(deck, made.table)?.rows[0].cells[1].content !== "45%") throw new Error("handoff: the table cell is not in the store");

    // The agent's pending change was proposed against a deck that has moved.
    record.staleApproval = await page(`fetch("/__api/v1/presentations/${deckId}/proposals/${made.pendingProposalId}/approve", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status)`);
    if (record.staleApproval !== 409) throw new Error(`handoff: approving the stale agent change answered ${record.staleApproval}, not 409`);
    deck = await stored(deckId);
    if (deck.slides.length !== 2) throw new Error("handoff: the refused removal changed the deck anyway");

    // Reopen from the list; everything the person did is there.
    await trustedClick(window, '[data-testid="open-deck-list"]');
    await need("could not return to the list", `document.querySelector('[data-deck-id="${deckId}"]')`, 20_000);
    await trustedClick(window, `[data-deck-id="${deckId}"] .dk-card__thumb`);
    await need("the deck did not reopen", `document.querySelector('[data-editor-canvas] [data-element-id="${made.headline}"]')`, 20_000);
    await need("the reopened canvas lost the person's headline", `document.querySelector("[data-editor-canvas]").textContent.includes("Person-edited headline")`);

    record.pdf = await exportAs("PDF", "pdf");
    await key("Escape");
    record.pptx = await exportAs("PowerPoint", "pptx");
    if (!record.pdf || !record.pptx) throw new Error(`handoff: exports finished pdf=${record.pdf} pptx=${record.pptx}`);
    await capture(window, join(dir, "handoff.png"));
  } finally {
    await page(`fetch("/__api/v1/presentations/${deckId}", { method: "DELETE" })`).catch(() => undefined);
    await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(original)} })`).catch(() => undefined);
  }
}
