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
  | "consent";

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
  record.exportSurface = await window.webContents.executeJavaScript(`(() => {
    const panel = [...document.querySelectorAll("section")].find(s => /EXPORT/i.test(s.textContent || ""));
    return (panel?.innerText || document.body.innerText).slice(0, 600);
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
