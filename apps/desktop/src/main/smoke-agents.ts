import { join } from "node:path";
import type { BrowserWindow } from "electron";

import { capture, trustedClick, until } from "./smoke";

/**
 * The acceptance step for plan 10 (docs/integrations/10_AGENT_SUGGESTIONS_AND_MEDIA_INTENT.md):
 * the select-and-say loop, the draft board and Match the deck, driven through
 * the window a person uses. It works on a deck of its own, made from a
 * template, and deletes it afterwards, so a run never changes anyone's work.
 *
 * `agents`:
 *  1. Try another: select the headline in Motion mode, preview another
 *     entrance and Keep it. Exactly one change reaches the store.
 *  2. Ask agent: type a request about the headline and send it. The service
 *     then plays the agent (the page's own proxy, as a connected agent's
 *     operations would arrive): two replies, answered against the request.
 *     Review groups them; approving one closes the request and withdraws the
 *     other, and only the chosen change is in the deck.
 *  3. Draft changes: seed a board from the deck, rewrite one card's headline,
 *     build only that card, and approve it in Review. Only that slide changes;
 *     every other slide is byte for byte what it was, and no slide id moves.
 *  4. Match the deck: the composed prompt for a slide carries the deck's
 *     palette, and Follow my prompt does not. The panel's own preview needs
 *     generation, which a checkout without sign-in does not have, so the
 *     step asks the service for the same prompt the panel shows and says so.
 */

export async function runAgents(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  try {
    await runAgentsInner(window, dir, record);
  } catch (error) {
    await capture(window, join(dir, "agents-failure.png")).catch(() => undefined);
    throw error;
  }
}

async function runAgentsInner(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const page = <T = unknown>(js: string) => window.webContents.executeJavaScript(js) as Promise<T>;
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const need = async (what: string, expression: string, timeoutMs = 15_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`agents: ${what}`);
  };
  const press = (testId: string) => trustedClick(window, `[data-testid="${testId}"]`);
  const api = <T = any>(path: string, method = "GET", body?: unknown) =>
    page<{ status: number; json: T }>(`fetch("/__api${path}", {
      method: ${JSON.stringify(method)},
      headers: { "Content-Type": "application/json" },
      ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`);
  const stored = async (id: string) => {
    const answer = await api<{ document: Record<string, any>; version_id: string }>(`/v1/presentations/${id}`);
    return { ...answer.json.document, __version: answer.json.version_id } as Record<string, any>;
  };
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 3; i += 1) {
      if (i > 150) throw new Error("agents: the edits never finished saving");
      await sleep(200);
      const status = await page<string | null>(`document.querySelector("[data-save-status]")?.getAttribute("data-save-status") ?? null`);
      quiet = status === "saved" || status === "updated" || status === "idle" ? quiet + 1 : 0;
    }
  };
  /** Type into a field the way a keyboard does: focus it, select what is there, insert. */
  const typeInto = async (selector: string, text: string) => {
    await trustedClick(window, selector);
    await page(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await window.webContents.insertText(text);
    const value = await page<string>(`document.querySelector(${JSON.stringify(selector)}).value`);
    if (value !== text) throw new Error(`agents: typing into ${selector} left "${value}"`);
  };
  const words = (element: any): string =>
    (element?.content?.blocks ?? []).flatMap((block: any) => block.spans ?? []).map((span: any) => span.text).join("");

  // ---- A deck of our own, from a template, so there is real content.
  await need("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
  const original = (await page<{ presentationId: string }>(`window.deckastra.currentPresentation()`)).presentationId;
  const account = (await api<any>("/v1/account")).json;
  const projectId = account.workspaces.flatMap((workspace: any) => workspace.projects ?? [])[0]?.id;
  if (!projectId) throw new Error("agents: the account has no project to make a deck in");
  const made = await api<{ presentation_id: string }>("/v1/decks/from-template", "POST", {
    project_id: projectId, template_id: "technical-architecture", title: "Smoke: agents",
  });
  if (made.status !== 200) throw new Error(`agents: the template deck was refused: ${made.status} ${JSON.stringify(made.json)}`);
  const created = made.json.presentation_id;
  record.created = created;
  // Main remembers which deck is open; a load of the window opens it, as the
  // performance step does.
  await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(created)} })`);
  window.webContents.reload();
  await need("the template deck never opened", `document.querySelector('[data-presentation-id="${created}"] [data-editor-canvas]')`, 30_000);

  try {
    let deck = await stored(created);
    const firstSlide = deck.slides[0];
    const headline = firstSlide.elements.find((element: any) => element.semanticRole === "headline" && element.type === "text");
    if (!headline) throw new Error("agents: the first slide has no headline to work on");
    record.headline = headline.id;

    // ---- 1. Try another, then Keep: one change.
    await press("mode-motion");
    await trustedClick(window, `[data-editor-canvas] [data-element-id="${headline.id}"]`);
    await need("selecting the headline did not reach the Motion panel", `/1 selected/.test(document.querySelector('[data-testid="selected-motion-alternatives"]')?.textContent ?? "")`);
    const versionBefore = deck.__version;
    await press("motion-try-another");
    await need("Try another showed no preview", `document.querySelector('[data-testid="selected-motion-plan"]')`, 20_000);
    // The preset's own label, beside the Preview chip: textContent of the whole
    // card runs "Preview" into the name and reads like a code name.
    record.tryAnotherPreview = await page<string>(`document.querySelector('[data-testid="selected-motion-plan"] .dk-proposal__head > span:last-child')?.textContent ?? ""`);
    if (!record.tryAnotherPreview || /[a-z][A-Z]/.test(String(record.tryAnotherPreview))) {
      throw new Error(`agents: the preview names a preset by its code name: ${record.tryAnotherPreview}`);
    }
    await press("selected-motion-keep");
    await settle();
    deck = await stored(created);
    const tracks = (deck.slides[0].animations ?? []).filter((track: any) => track.targetId === headline.id);
    if (!tracks.length) throw new Error("agents: Keep did not store an entrance for the headline");
    record.keptPreset = tracks[0]?.clips?.[0]?.preset ?? null;
    const versions = (await api<any[]>(`/v1/presentations/${created}/versions`)).json;
    const since = versions.findIndex((row: any) => row.version_id === versionBefore || row.id === versionBefore);
    record.versionsFromKeep = since;
    if (since !== 1) throw new Error(`agents: Keep should be exactly one change; the store has ${since} since`);

    // ---- 2. Ask agent, two replies, choose one in Review.
    await typeInto('[data-testid="ask-agent-message"]', "The headline should arrive more gently.");
    await press("ask-agent-send");
    await need("sending the request said nothing", `/Waiting for your agent/.test(document.querySelector('[data-testid="ask-agent"]')?.textContent ?? "")`);
    const open = (await api<any[]>(`/v1/presentations/${created}/requests?status=open`)).json;
    if (open.length !== 1 || !open[0].target.element_ids.includes(headline.id)) {
      throw new Error(`agents: the request did not target the headline: ${JSON.stringify(open)}`);
    }
    const request = open[0];
    record.request = { id: request.id, kind: request.kind };

    // The agent's two replies, as small (low-risk) changes: a reply must still
    // wait for the person.
    deck = await stored(created);
    const element = deck.slides[0].elements.find((one: any) => one.id === headline.id);
    const rotationPath = `/slides/id:${deck.slides[0].id}/elements/id:${headline.id}/transform/rotation`;
    const op = "rotation" in element.transform ? "replace" : "add";
    const replies: string[] = [];
    for (const [label, value] of [["Tilt left", -2], ["Tilt right", 2]] as const) {
      const reply = await api<any>(`/v1/presentations/${created}/proposals`, "POST", {
        operations: [{ op, path: rotationPath, value }],
        intent: label, expected_version_id: deck.__version, in_reply_to: request.id, client_label: "smoke",
      });
      if (reply.status !== 200 || reply.json.outcome !== "pending") {
        throw new Error(`agents: a reply did not wait for the person: ${reply.status} ${JSON.stringify(reply.json)}`);
      }
      replies.push(reply.json.transaction_id);
    }
    const answered = await api<any>(`/v1/requests/${request.id}/answer`, "POST", { proposal_ids: replies });
    if (answered.status !== 200) throw new Error(`agents: the replies could not answer the request: ${JSON.stringify(answered.json)}`);

    await need("Review never offered the replies", `document.querySelector('[data-testid="open-review"]')`, 20_000);
    await press("open-review");
    await need("Review did not group the two replies", `document.querySelectorAll('[data-testid="review-proposal"]').length === 2 && document.querySelector('[data-testid="review-request-group"]')`, 20_000);
    record.reviewGroup = await page<string>(`document.querySelector('[data-testid="review-request-group"]').textContent`);
    if (/^motion/.test(String(record.reviewGroup))) throw new Error(`agents: the request kind is shown as code: ${record.reviewGroup}`);
    await press("review-proposal");
    await need("approving was not offered", `document.querySelector('[data-testid="review-approve"]')`);
    await press("review-approve");
    await need("the request was not closed by approving a reply", `!document.querySelector('[data-testid="review-request-group"]')`, 20_000);
    const closed = (await api<any[]>(`/v1/presentations/${created}/requests?status=closed`)).json;
    const pending = (await api<any>(`/v1/presentations/${created}/proposals`)).json;
    const stillPending = (Array.isArray(pending) ? pending : pending?.proposals ?? []).filter((row: any) => replies.includes(row.id));
    deck = await stored(created);
    const rotation = deck.slides[0].elements.find((one: any) => one.id === headline.id).transform.rotation;
    record.chosenReply = { closed: closed.some((row: any) => row.id === request.id), stillPending: stillPending.length, rotation };
    if (!closed.some((row: any) => row.id === request.id)) throw new Error("agents: approving a reply left the request open");
    if (stillPending.length) throw new Error("agents: the other reply is still waiting after one was chosen");
    if (rotation !== -2 && rotation !== 2) throw new Error(`agents: the deck does not hold the chosen reply (rotation ${rotation})`);
    await press("close-review");

    // ---- 3. Draft changes: one card rebuilt, everything else untouched.
    await settle();
    const beforeDraft = await stored(created);
    await press("draft-changes");
    await need("the draft board never opened", `document.querySelectorAll('[data-testid="draft-board"] [data-card-id]').length === ${beforeDraft.slides.length}`, 20_000);
    const seededWords = await page<string>(`document.querySelectorAll('[data-testid="draft-board"] [data-card-id]')[1].querySelector("textarea")?.value ?? ""`);
    record.seededSecondCard = seededWords;
    if (!seededWords.trim()) throw new Error("agents: the draft board seeded an empty card from a deck with words");
    const secondCard = await page<string>(`document.querySelectorAll('[data-testid="draft-board"] [data-card-id]')[1].getAttribute("data-card-id")`);
    const field = `[data-card-id="${secondCard}"] textarea`;
    await typeInto(field, "A sharper second slide");
    await page(`document.querySelector(${JSON.stringify(field)}).blur()`);
    await need("the edited card was not saved to the draft", `!document.querySelector('[data-testid="draft-board"] [aria-busy="true"]')`, 10_000);
    await sleep(800);
    await trustedClick(window, `[data-card-id="${secondCard}"] input[type="checkbox"]`);
    await press("draft-build");
    let built: any = null;
    for (let i = 0; i < 60 && !built; i += 1) {
      await sleep(500);
      const listed = (await api<any>(`/v1/presentations/${created}/proposals`)).json;
      built = (Array.isArray(listed) ? listed : listed?.proposals ?? []).find((row: any) => row.agent_id === "draft-board");
    }
    if (!built) throw new Error("agents: building the card made no proposal");
    // A build closes the board and opens Review on its own (EditorShell's onBuilt).
    await need("Review did not open on the draft build", `document.querySelector('[data-testid="review-workspace"] [data-testid="review-proposal"]') && !document.querySelector('[data-testid="draft-board"]')`, 20_000);
    await press("review-proposal");
    await press("review-approve");
    await need("the draft build was not applied", `!document.querySelector('[data-testid="review-proposal"]')`, 20_000);
    await press("close-review");
    const afterDraft = await stored(created);
    const before = beforeDraft.slides as any[];
    const after = afterDraft.slides as any[];
    const changed = after.map((slide, index) => JSON.stringify(slide) !== JSON.stringify(before[index]) ? index : -1).filter((index) => index >= 0);
    record.draftBuild = {
      slidesBefore: before.length, slidesAfter: after.length, changed,
      idsKept: before.every((slide, index) => after[index]?.id === slide.id),
      newWords: after[1]?.elements?.some((one: any) => words(one).includes("A sharper second slide")),
    };
    if (after.length !== before.length) throw new Error(`agents: building one card changed the slide count ${before.length} -> ${after.length}`);
    if (changed.length !== 1 || changed[0] !== 1) throw new Error(`agents: building one card changed slides ${JSON.stringify(changed)}`);
    if (!(record.draftBuild as any).idsKept) throw new Error("agents: building one card moved a slide id");
    if (!(record.draftBuild as any).newWords) throw new Error("agents: the rebuilt slide does not carry the new words");

    // ---- 4. Match the deck: the prompt the panel would show.
    const ask = (style_source: "deck" | "prompt") =>
      api<any>("/v1/assistant/media-prompt", "POST", { presentation_id: created, slide_id: deck.slides[0].id, subject: "A server room at dusk", kind: "image", style_source });
    const matched = (await ask("deck")).json;
    const followed = (await ask("prompt")).json;
    const sources = (answer: any) => (answer?.parts ?? []).map((part: any) => part.source);
    record.mediaPrompt = { deck: sources(matched), prompt: sources(followed) };
    if (!sources(matched).includes("palette")) throw new Error(`agents: Match the deck carried no palette: ${JSON.stringify(matched)}`);
    if (sources(followed).includes("palette")) throw new Error("agents: Follow my prompt borrowed the deck's palette");
    await press("mode-more");
    await press("mode-media");
    await need("the Generate panel has no Match the deck switch", `document.querySelector('[data-testid="generate-style-deck"]')`, 15_000);
    record.generationOffered = await page<boolean>(`Boolean(document.querySelector('[data-testid="generate-prompt"]'))`);
    record.panelPreviewChecked = record.generationOffered
      ? "the panel offers generation; its preview is the same service call"
      : "generation is off without sign-in, so the panel's preview was not drawn; the service call it makes was checked";
    await capture(window, join(dir, "agents-media.png")).catch(() => undefined);
  } finally {
    await api(`/v1/presentations/${created}`, "DELETE").catch(() => undefined);
    await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(original)} })`).catch(() => undefined);
    window.webContents.reload();
  }
}

/**
 * `media-signed-in`: the composed-prompt preview on screen, which only a
 * signed-in desktop can draw (generation goes through the account gateway).
 * It needs a person: it opens Settings › Profile and waits up to fifteen
 * minutes for someone to sign in, then draws the Generate panel's preview in
 * both modes and captures each. It never asks a price and never generates, so
 * no credit is spent; the deck it makes is deleted afterwards. Not a CI step.
 */
export async function runMediaSignedIn(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  try {
    await runMediaSignedInInner(window, dir, record);
  } catch (error) {
    await capture(window, join(dir, "media-signed-in-failure.png")).catch(() => undefined);
    throw error;
  }
}

async function runMediaSignedInInner(window: BrowserWindow, dir: string, record: Record<string, unknown>): Promise<void> {
  const page = <T = unknown>(js: string) => window.webContents.executeJavaScript(js) as Promise<T>;
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const need = async (what: string, expression: string, timeoutMs = 15_000) => {
    if (!(await until(window, expression, timeoutMs))) throw new Error(`media-signed-in: ${what}`);
  };
  const press = (testId: string) => trustedClick(window, `[data-testid="${testId}"]`);
  const api = <T = any>(path: string, method = "GET", body?: unknown) =>
    page<{ status: number; json: T }>(`fetch("/__api${path}", {
      method: ${JSON.stringify(method)},
      headers: { "Content-Type": "application/json" },
      ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`);

  await need("the editor never opened", `document.querySelector("[data-editor-canvas]")`, 30_000);
  const original = (await page<{ presentationId: string }>(`window.deckastra.currentPresentation()`)).presentationId;

  // ---- Wait for a person to sign in. Settings opens on the profile so the
  // button is in front of them; the step only watches.
  const imageAvailable = async () => {
    const answer = await api<any>(`/v1/assistant/capabilities`);
    return Boolean(answer.json?.tasks?.image?.available);
  };
  if (!(await imageAvailable())) {
    await page(`document.querySelector('[data-testid="account-menu"]')?.click()`);
    await sleep(400);
    await page(`[...document.querySelectorAll('[role="menuitem"]')].find((item) => /Settings/.test(item.textContent || ""))?.click()`);
    record.waitedForSignIn = true;
    const started = Date.now();
    while (!(await imageAvailable())) {
      if (Date.now() - started > 15 * 60_000) throw new Error("media-signed-in: nobody signed in within fifteen minutes");
      await sleep(3_000);
    }
    record.signInMs = Date.now() - started;
    // Close Settings the way a person does, so nothing modal covers the editor.
    for (let i = 0; i < 2; i += 1) {
      window.focus();
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await sleep(400);
    }
    await need("Settings did not close after signing in", `![...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')].some((node) => node.getBoundingClientRect().width > 0)`, 20_000);
  }
  record.generationAvailable = true;

  const account = (await api<any>("/v1/account")).json;
  const projectId = account.workspaces.flatMap((workspace: any) => workspace.projects ?? [])[0]?.id;
  const made = await api<{ presentation_id: string }>("/v1/decks/from-template", "POST", {
    project_id: projectId, template_id: "technical-architecture", title: "Smoke: composed prompt",
  });
  if (made.status !== 200) throw new Error(`media-signed-in: the template deck was refused: ${JSON.stringify(made.json)}`);
  const created = made.json.presentation_id;
  record.created = created;
  await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(created)} })`);
  window.webContents.reload();
  await need("the template deck never opened", `document.querySelector('[data-presentation-id="${created}"] [data-editor-canvas]')`, 30_000);

  try {
    await press("mode-more");
    await press("mode-media");
    if (!(await until(window, `document.querySelector('[data-testid="generate-prompt"]')`, 30_000))) {
      // Say what the panel said instead, and show it, before the deck goes.
      record.generatePanel = await page<string>(`document.querySelector('[data-testid="generate-media"]')?.innerText ?? "no Generate panel"`);
      record.scopedCapabilities = (await api<any>(`/v1/assistant/capabilities?presentation_id=${created}&slide_id=${(await api<any>(`/v1/presentations/${created}`)).json.document.slides[0].id}`)).json?.tasks?.image ?? null;
      await capture(window, join(dir, "media-signed-in-panel.png")).catch(() => undefined);
      throw new Error(`media-signed-in: the Generate panel offered no description box: ${String(record.generatePanel).slice(0, 300)}`);
    }
    await trustedClick(window, '[data-testid="generate-prompt"]');
    await window.webContents.insertText("A server room at dusk, rows of quiet machines");
    for (const mode of ["deck", "prompt"] as const) {
      await press(`generate-style-${mode}`);
      await need(`the ${mode} preview never drew`, `document.querySelector('[data-testid="generate-composed-prompt"]') && document.querySelector('[data-testid="generate-style-${mode}"]').getAttribute("aria-checked") === "true"`, 15_000);
      await sleep(900);
      const shown = await page<{ labels: string[]; prompt: string }>(`({
        labels: [...document.querySelectorAll('[data-testid="generate-composed-prompt"] .dk-generate__part strong')].map((node) => node.textContent),
        prompt: document.querySelector('[data-testid="generate-final-prompt"]').value,
      })`);
      record[`preview_${mode}`] = shown;
      await page(`document.querySelector('[data-testid="generate-composed-prompt"]').scrollIntoView({ block: "center" })`);
      await sleep(300);
      await capture(window, join(dir, `media-signed-in-${mode}.png`));
    }
    const deckLabels = (record.preview_deck as { labels: string[] }).labels.join(" | ");
    const promptLabels = (record.preview_prompt as { labels: string[] }).labels.join(" | ");
    if (!/palette/.test(deckLabels)) throw new Error(`media-signed-in: Match the deck showed no palette: ${deckLabels}`);
    if (/palette/.test(promptLabels)) throw new Error(`media-signed-in: Follow my prompt showed the deck's palette: ${promptLabels}`);
  } finally {
    await api(`/v1/presentations/${created}`, "DELETE").catch(() => undefined);
    await page(`window.deckastra.openPresentation({ presentationId: ${JSON.stringify(original)} })`).catch(() => undefined);
    window.webContents.reload();
  }
}
