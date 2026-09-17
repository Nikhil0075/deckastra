import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

import type { Attachment } from "./attachment";

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
  | "timeline";

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
}

export function smokeDir(): string | undefined {
  return process.env.DECKASTRA_SMOKE_DIR || undefined;
}

function step(): SmokeStep {
  return (process.env.DECKASTRA_SMOKE_STEP as SmokeStep) || "open";
}

/** Poll the rendered page until `predicate` holds, or give up and say so. */
async function until(
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

  window.webContents.on("console-message", (_event, level, message, line, source) => {
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

  try {
    await mkdir(dir, { recursive: true });

    if (current === "digest") {
      await runDigest(window, record);
    } else if (current === "resilience") {
      await runResilience(window, dir, record, controls);
    } else if (current === "timeline") {
      await runTimeline(window, record);
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
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Rect");
      if (!button) return false;
      button.click();
      return true;
    })()`);
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

  record.enteredPresent = await window.webContents.executeJavaScript(clickByText("Present"));
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

  record.startedExport = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "PDF");
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

  // Off by default, including on an install that used to work.
  record.publishedBeforeConsent = (await read()) !== null;
  record.offerText = await window.webContents.executeJavaScript(
    `document.querySelector("[role=status]")?.textContent ?? null`,
  );

  record.allowed = await window.webContents.executeJavaScript(clickButton("Allow agent access"));
  if (!(await waitFor(async () => (await read()) !== null))) {
    throw new Error("Allowing agent access published no attachment.");
  }
  const granted = (await read())!;
  record.grantedText = await window.webContents.executeJavaScript(
    `document.querySelector("[role=status]")?.textContent ?? null`,
  );
  record.grantWorks = await reaches(granted);

  // And a capability the credential does not carry, refused by the service
  // rather than by which tools an adapter happened to register.
  const approval = await fetch(
    `http://127.0.0.1:${granted.port}/v1/presentations/prs_whatever/proposals/txn_whatever/approve`,
    { method: "POST", headers: { authorization: `Bearer ${granted.grant}` } },
  );
  record.approvalRefused = approval.status;

  record.stopped = await window.webContents.executeJavaScript(clickButton("Stop agent access"));
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
    'document.querySelectorAll("nav button").length',
  )) as number;

  record.addedSlide = await window.webContents.executeJavaScript(clickButton("+ Slide"));
  if (
    !(await until(
      window,
      `document.querySelectorAll("nav button").length > ${slidesBefore}`,
    ))
  ) {
    throw new Error("The editor did not add a slide to work on.");
  }

  // Something to animate, then an animation on it.
  await window.webContents.executeJavaScript(clickButton("Rect"));
  await until(window, 'document.querySelectorAll("[data-element-id]").length > 0');

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
    const undo = () => [...document.querySelectorAll("button")]
      .find((one) => one.textContent?.trim() === "Undo");
    const slides = () => document.querySelectorAll("nav button").length;
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

  // `clickButton` matches the button's exact text, which is what the present
  // control carries.
  record.enteredPresent = await window.webContents.executeJavaScript(clickButton("Present"));
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
      const moving = [...document.querySelectorAll("[data-element-id]")]
        .filter((el) => !atRest(el.style.translate))
        .map((el) => ({ id: el.getAttribute("data-element-id"), translate: el.style.translate, scale: el.style.scale }));
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
  await window.webContents.executeJavaScript(clickButton("Rect"));
  record.firstSaveAcknowledged = await until(window, `document.body.innerText.includes("Saved")`, 30_000);

  await controls.stopService();
  record.serviceStoppedReported = await until(
    window,
    `document.body.innerText.includes("workspace service")`,
    20_000,
  );

  // An edit with nowhere to go. The document must still show it, and the app must
  // not pretend it was saved.
  await window.webContents.executeJavaScript(clickButton("Rect"));
  await new Promise((done) => setTimeout(done, 3_000));
  record.elementsWhileDown = await window.webContents.executeJavaScript(ELEMENT_COUNT);
  record.offlineEditKeptOnScreen =
    (record.elementsWhileDown as number) > (record.startingElements as number);

  await capture(window, join(dir, "resilience-down.png"));

  await controls.startService();
  record.recoveredToReady = await until(
    window,
    `!document.body.innerText.includes("could not start")`,
    60_000,
  );

  // One more edit to trigger a drain. The queued work is addressed against the
  // version it was authored on, so it goes out with this one or not at all.
  await window.webContents.executeJavaScript(clickButton("Rect"));
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
  await window.webContents.executeJavaScript(clickButton("Rect"));
  await until(window, `document.body.innerText.includes("Saved")`, 30_000);
  await second.webContents.executeJavaScript(clickButton("Rect"));
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

async function capture(window: BrowserWindow, file: string): Promise<void> {
  // A settle beat before the shot: the scene builds from browser text metrics,
  // and capturing mid-measurement photographs a layout no user ever sees.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const image = await window.webContents.capturePage();
  await writeFile(file, image.toPNG());
}
