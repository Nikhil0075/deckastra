import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

import animationFixture from "@deckastra/presentation-schema/fixtures/animation-test.mydeck.json" with { type: "json" };

/**
 * Which deck this install opens.
 *
 * A pointer, not a document. D0 kept the deck in a JSON file here; D1 gives that
 * job to the workspace service, which has the store, the version chain and the
 * history — so all this has to remember is *which* deck, and even that is
 * temporary: a deck list belongs in the service, and this file goes away when
 * there is one.
 *
 * The sample is seeded through the service's own transaction endpoint rather than
 * written to disk. That is the point: first launch exercises create-then-commit,
 * so if the store, the applier or the concurrency check were broken, the app
 * would fail to open rather than fail later on someone's first edit.
 */

interface State {
  presentationId?: string;
}

interface Service {
  port: number;
  secret: string;
}

function statePath(): string {
  return join(app.getPath("userData"), "workspace.json");
}

export function dataDir(): string {
  return join(app.getPath("userData"), "workspace");
}

async function read(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as State;
  } catch {
    // Missing or unreadable both mean "we have not opened a deck yet", and a
    // corrupt pointer should cost a new sample deck rather than a dead app.
    return {};
  }
}

async function write(state: State): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(state, null, 2), "utf8");
  await rename(staging, path);
}

async function call(service: Service, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${service.secret}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (body as { detail?: unknown }).detail;
    throw new Error(
      typeof detail === "string" ? detail : `The workspace service refused ${path} (${response.status}).`,
    );
  }
  return body;
}

/**
 * The deck to open, creating and seeding one on a first launch.
 *
 * Verifies a remembered pointer rather than trusting it: a deck can disappear
 * between launches — a restored backup, a database someone deleted — and opening
 * an id the service does not have would leave the editor showing a 404 with no
 * way forward.
 */
export async function ensurePresentation(service: Service): Promise<string> {
  const state = await read();

  if (state.presentationId) {
    try {
      await call(service, `/v1/presentations/${encodeURIComponent(state.presentationId)}`);
      return state.presentationId;
    } catch {
      // Fall through: the most recent other deck, or a new one.
    }
  }

  // The remembered deck is gone — most often because the person deleted it
  // from the deck list. Open the most recently changed deck they still have,
  // rather than seeding a fresh sample they never asked for; only an install
  // with no decks at all gets the sample.
  const recent = await mostRecentDeck(service).catch(() => null);
  if (recent) {
    await write({ presentationId: recent });
    return recent;
  }

  const created = await call(service, "/v1/presentations", {
    method: "POST",
    body: JSON.stringify({ title: "Animation Conformance Deck" }),
  });
  const presentationId = String(created.presentation_id);

  await seedSample(service, presentationId, String(created.version_id));
  await write({ presentationId });
  return presentationId;
}

/**
 * Make `presentationId` the deck this install opens (the deck list's Open).
 *
 * Asks the service first: the id came from the renderer, and the renderer is
 * the process this file does not trust. A deck that does not exist, is
 * deleted, or is in a workspace this install cannot read is refused with the
 * service's own answer, and the remembered pointer is left alone.
 */
export async function rememberPresentation(service: Service, presentationId: string): Promise<string> {
  if (!/^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$/.test(presentationId)) {
    throw new Error("That is not a deck id.");
  }
  await call(service, `/v1/presentations/${encodeURIComponent(presentationId)}`);
  await write({ presentationId });
  return presentationId;
}

/** The most recently changed deck in the first project this install can see. */
async function mostRecentDeck(service: Service): Promise<string | null> {
  const account = await call(service, "/v1/account");
  for (const workspace of account.workspaces ?? []) {
    for (const project of workspace.projects ?? []) {
      const listed = await call(service, `/v1/projects/${encodeURIComponent(project.id)}/presentations?limit=1`);
      const first = listed.presentations?.[0];
      if (first?.id) return String(first.id);
    }
  }
  return null;
}

/**
 * Fill a new deck with the bundled sample, as one ordinary transaction.
 *
 * `replace` on whole arrays rather than a slide-by-slide insert: the deck was
 * created moments ago and has exactly the empty shell the API builds, so there is
 * no history to preserve and a single patch is the honest description of what is
 * happening.
 *
 * A failure here is deliberately not fatal. An empty deck the user can work in
 * beats a launch that refuses because a sample would not load.
 */
async function seedSample(service: Service, presentationId: string, versionId: string): Promise<void> {
  const sample = animationFixture as { slides: unknown; theme: unknown; metadata?: { title?: string } };

  try {
    await call(service, `/v1/presentations/${encodeURIComponent(presentationId)}/transactions`, {
      method: "POST",
      body: JSON.stringify({
        operations: [
          { op: "replace", path: "/theme", value: sample.theme },
          { op: "replace", path: "/slides", value: sample.slides },
        ],
        intent: "Open the sample deck",
        expected_version_id: versionId,
        client_id: "desktop-editor",
      }),
    });
  } catch (error) {
    console.warn("Could not seed the sample deck:", error);
  }
}
