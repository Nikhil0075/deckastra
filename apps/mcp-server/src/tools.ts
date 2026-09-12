import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

import type { Attached } from "./attach";
import { outlineDocument, slideOf } from "./outline";

/**
 * What an agent can do to a deck (milestone D2.2).
 *
 * The whole surface is a thin adapter: every tool below is one call on
 * `WorkspaceClient`, and there is no second write path. That is what makes the
 * product's guarantees hold for an agent without any of them being restated
 * here — risk tier is computed server-side, a proposal expires in 24 hours and is
 * re-validated on approval, an applied change carries an inverse and undoes like
 * a typed edit, and a stale base version is a 409 rather than a silent overwrite.
 *
 * Three things are deliberately **absent**, and each absence is the feature:
 *
 * - **No approval tool.** An agent cannot approve its own pending proposal. The
 *   product's central claim is that a human stays in control of a risky change,
 *   and an agent that could approve its own work would reduce that to a delay.
 *   Approval happens in the app, by the person whose deck it is.
 * - **No sharing tool.** Issuing a share link is granting a bearer credential to
 *   a document, and it is not something an agent should do while the user is
 *   looking elsewhere.
 * - **No path anywhere.** Not for an export destination, not for a repository.
 *   Document content reaches this process, and a tool that took a path would let
 *   a deck someone emailed you choose where bytes are written.
 *
 * The first two are **not enforced here**, and that is the point. This process
 * holds a grant carrying `read`, `write` and `export` (`main/attachment.ts`), and
 * the authority refuses the rest by capability (`grants.py`). A tool added to
 * this file tomorrow cannot exceed that, and neither can anything else that reads
 * the attachment — which was the hole when the file published the launch secret:
 * the refusals lived in whichever tools this file happened to register.
 */

/** Most recently changed first; the rest are counted, not listed. */
const DECKS_PER_PROJECT = 50;

/** How a refusal reaches the model: as an error result it can read and act on. */
function failure(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** An image the model can actually look at, with a line saying what it is. */
function image(base64: string, caption: string) {
  return {
    content: [
      { type: "text" as const, text: caption },
      { type: "image" as const, data: base64, mimeType: "image/png" },
    ],
  };
}

/** Turn a thrown `WorkspaceRequestError` into something worth reading. */
function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as { status?: number }).status;
  if (status === 409) {
    return `${error.message} (The deck changed under you. Read it again and re-author the change.)`;
  }
  if (status === 404) {
    return `${error.message} (No such deck, or this workspace cannot see it.)`;
  }
  return error.message;
}

type Result = ReturnType<typeof json> | ReturnType<typeof image> | ReturnType<typeof failure>;

async function guard(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    return failure(explain(error));
  }
}

export function registerTools(server: McpServer, client: WorkspaceClient, attached: Attached): void {
  // ------------------------------------------------------------------ reading

  server.registerTool(
    "workspace_list",
    {
      title: "List Deckastra workspaces and decks",
      description:
        "The workspaces, projects and decks this Deckastra install holds, plus which deck the " +
        "user currently has open. Start here: every other tool needs a presentation id.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const account = await client.session.account({ fresh: true });
        const openId = attached.attachment.presentationId ?? null;

        // The decks, which `/v1/account` does not carry. This tool promised them
        // and returned only projects, so an agent asked "which decks do I have"
        // could name the open one and nothing else. Found by a real Claude Code
        // session, which said so rather than pretending.
        const workspaces = await Promise.all(
          account.workspaces.map(async (workspace) => ({
            ...workspace,
            projects: await Promise.all(
              workspace.projects.map(async (project) => {
                const decks = await client.documents.list(project.id, { fresh: true });
                return {
                  ...project,
                  // Bounded like every other answer here. A project with
                  // hundreds of decks would otherwise spend an agent's whole
                  // context on a list it only needed the top of.
                  decks: decks.slice(0, DECKS_PER_PROJECT).map((deck) => ({
                    id: deck.id,
                    title: deck.title,
                    updated_at: deck.updated_at,
                    ...(deck.id === openId ? { open: true } : {}),
                  })),
                  ...(decks.length > DECKS_PER_PROJECT
                    ? { more_decks: decks.length - DECKS_PER_PROJECT }
                    : {}),
                };
              }),
            ),
          })),
        );

        return json({
          user: account.user,
          // The deck the user is looking at right now. An agent asked to "fix
          // this slide" has no other way to know which deck "this" is, and
          // guessing means editing something nobody is watching.
          openPresentationId: openId,
          workspaces,
        });
      }),
  );

  server.registerTool(
    "document_read",
    {
      title: "Read a deck's outline",
      description:
        "A deck as a readable outline: slides, their intent and key message, and every element's " +
        "id, type, role and text. This is the right default. A full .mydeck document is mostly " +
        "geometry and token references, and reading one costs more context than changing it. " +
        "Use document_read_slide when you need the exact geometry of one slide.",
      annotations: { readOnlyHint: true },
      inputSchema: { presentation_id: z.string().min(1) },
    },
    async ({ presentation_id }) =>
      guard(async () => {
        const read = await client.documents.read(presentation_id, { fresh: true });
        return json(
          outlineDocument(read.document, {
            presentationId: presentation_id,
            versionId: read.version_id,
          }),
        );
      }),
  );

  server.registerTool(
    "document_read_slide",
    {
      title: "Read one slide in full",
      description:
        "One slide exactly as stored: transforms, typography, content, animations. Ask for this " +
        "when you are about to author operations against it and need the current values.",
      annotations: { readOnlyHint: true },
      inputSchema: { presentation_id: z.string().min(1), slide_id: z.string().min(1) },
    },
    async ({ presentation_id, slide_id }) =>
      guard(async () => {
        const read = await client.documents.read(presentation_id, { fresh: true });
        return json({ version_id: read.version_id, slide: slideOf(read.document, slide_id) });
      }),
  );

  server.registerTool(
    "slide_preview",
    {
      title: "See a slide",
      description:
        "Render one slide as an image — the deck as it stands, or, with proposal_id, how a " +
        "pending proposal would leave it.\n\n" +
        "Look at your own work before asking the user to. An outline says what a slide contains; " +
        "it cannot show that a headline now overflows, that gold-on-black went unreadable, or " +
        "that two elements overlap. This renders through the same browser an export uses, so what " +
        "you see is what the deck exports as.\n\n" +
        "One slide per call: rendering starts a browser, and a whole deck is a lot of pictures " +
        "for a change that touched one slide.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        presentation_id: z.string().min(1),
        slide_id: z.string().min(1),
        proposal_id: z
          .string()
          .min(1)
          .optional()
          .describe("A pending proposal, to see what it would produce. Nothing is applied."),
      },
    },
    async ({ presentation_id, slide_id, proposal_id }) =>
      guard(async () => {
        const preview = await client.documents.preview(
          presentation_id,
          { slide_id, ...(proposal_id ? { proposal_id } : {}) },
          { fresh: true },
        );
        // Only said when there is a proposal. "Other slides this proposal
        // changes: none" on a plain preview describes a proposal that does not
        // exist, which reads as a bug in the answer.
        const also = proposal_id
          ? preview.changed_slide_ids.filter((id) => id !== slide_id).join(", ") || "none"
          : undefined;
        return image(
          preview.image_base64,
          `Slide ${preview.slide_id} at version ${preview.version_id}, ` +
            `${preview.width}×${preview.height}` +
            (proposal_id
              ? ` — with proposal ${proposal_id} applied to a copy. Other slides it changes: ${also}.`
              : " — the deck as it stands.") +
            (preview.metrics_estimated
              ? " Some text was estimated rather than measured; treat spacing as approximate."
              : ""),
        );
      }),
  );

  server.registerTool(
    "motion_capabilities",
    {
      title: "What motion a deck can be given",
      description:
        "The presets, pacing words and semantic roles a motion plan may use, plus the " +
        "per-slide entrance budget. Read this before motion_propose. There are no " +
        "milliseconds in a plan: you name roles, a preset and one word of pacing, and the " +
        "app computes the timings — which is how every slide stays inside its budget.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => guard(async () => json(await client.motion.capabilities())),
  );

  server.registerTool(
    "motion_propose",
    {
      title: "Animate a slide",
      description:
        "Give one slide an entrance sequence, described in semantic roles. " +
        "sequence is the reveal order — ['headline', 'body', 'metric'] means the headline " +
        "arrives, then the body, then the numbers. Roles you leave out are on screen from " +
        "the first frame, which is the right default: a deck where everything moves is one " +
        "the audience reads none of. " +
        "Use document_read to see which roles a slide's elements actually carry. " +
        "The app composes the tracks with the same code its own composer uses, compresses a " +
        "sequence that would over-run the entrance budget, and leaves long body text in " +
        "place. It tells you what it left alone. Like any change, the result is applied or " +
        "becomes a proposal for the user, and you cannot choose which.",
      inputSchema: {
        presentation_id: z.string().min(1),
        slide_id: z.string().min(1),
        expected_version_id: z.string().min(1),
        sequence: z
          .array(z.string().min(1))
          .min(1)
          .max(12)
          .describe("Semantic roles, in the order they should appear."),
        entrance: z.string().max(40).optional().describe("A preset from motion_capabilities."),
        pacing: z.enum(["tight", "measured", "deliberate"]).optional(),
        click_reveals: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("How many later steps the presenter reveals by clicking."),
        intent: z.string().min(1).max(500).optional(),
      },
    },
    async ({ presentation_id, slide_id, expected_version_id, sequence, entrance, pacing, click_reveals, intent }) =>
      guard(async () =>
        json(
          await client.motion.propose(presentation_id, {
            slide_id,
            expected_version_id,
            sequence,
            ...(entrance ? { entrance } : {}),
            ...(pacing ? { pacing } : {}),
            ...(click_reveals === undefined ? {} : { click_reveals }),
            ...(intent ? { intent } : {}),
            client_label: client.clientId.replace(/^mcp:/, ""),
          }),
        ),
      ),
  );

  server.registerTool(
    "document_versions",
    {
      title: "A deck's history",
      description: "Recent versions of a deck: what changed, when, and which surface authored it.",
      annotations: { readOnlyHint: true },
      inputSchema: { presentation_id: z.string().min(1) },
    },
    async ({ presentation_id }) =>
      guard(async () => json((await client.documents.versions(presentation_id)).slice(0, 50))),
  );

  // ------------------------------------------------------------------ writing

  server.registerTool(
    "document_create",
    {
      title: "Create an empty deck",
      description:
        "A new deck with one empty slide, in the user's default project. It runs no model and " +
        "costs nothing; fill it with document_propose.",
      inputSchema: { title: z.string().min(1).max(200) },
    },
    async ({ title }) => guard(async () => json(await client.documents.create({ title }))),
  );

  server.registerTool(
    "document_propose",
    {
      title: "Propose a change to a deck",
      description:
        "Apply id-addressed patch operations to a deck. You author the operations yourself, so " +
        "this calls no model and bills the user nothing.\n\n" +
        "Paths are id-addressed, for example /slides/id:sld_x/elements/id:el_y/transform/x. " +
        "Index paths break the moment an earlier sibling is inserted.\n\n" +
        "expected_version_id is the version you read the deck at. If the user has edited since, " +
        "this returns a conflict rather than overwriting their work. Re-read and re-author.\n\n" +
        "The outcome is not yours to choose: the server computes a risk tier from the operations. " +
        "A low-risk change applies immediately; anything else becomes a pending proposal that the " +
        "user approves in the app. You cannot approve it yourself.",
      inputSchema: {
        presentation_id: z.string().min(1),
        expected_version_id: z.string().min(1),
        intent: z.string().min(1).max(500).describe("What this change is for, in the user's terms."),
        operations: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .max(2_000)
          .describe("PatchOperation[] as defined by the .mydeck schema."),
        reason: z.string().max(1_000).optional(),
      },
    },
    async ({ presentation_id, expected_version_id, intent, operations, reason }) =>
      guard(async () => {
        const result = await proposeAuthored(client, attached, presentation_id, {
          operations,
          intent,
          expected_version_id,
          ...(reason ? { reason } : {}),
        });

        // The preview document comes back whole, and whole is exactly what this
        // surface must not return. Outlined instead, so the agent can see what
        // its change produced without spending its context on what it did not
        // touch.
        const shown = (result.preview ?? result.document)
          ? outlineDocument((result.preview ?? result.document) as never, {
              presentationId: presentation_id,
              versionId: result.version_id ?? expected_version_id,
            })
          : undefined;

        return json({
          outcome: result.outcome,
          risk_tier: result.risk_tier,
          reasons: result.reasons,
          transaction_id: result.transaction_id,
          version_id: result.version_id,
          expires_at: result.expires_at,
          ...(result.outcome === "pending"
            ? {
                awaiting:
                  "The user must approve this in Deckastra. It expires in 24 hours and is " +
                  "re-validated against the deck as it stands when they do.",
                would_produce: shown,
              }
            : { applied: shown }),
        });
      }),
  );

  server.registerTool(
    "proposal_list",
    {
      title: "Pending proposals on a deck",
      description:
        "Changes waiting for the user's approval, including ones you proposed. Read-only: " +
        "approving is the user's decision and happens in the app.",
      annotations: { readOnlyHint: true },
      inputSchema: { presentation_id: z.string().min(1) },
    },
    async ({ presentation_id }) =>
      guard(async () => json(await client.agent.proposals(presentation_id, { fresh: true }))),
  );

  // ---------------------------------------------------------------- exporting

  server.registerTool(
    "document_export",
    {
      title: "Export a deck",
      description:
        "Start a PDF or PPTX export. Returns a job; poll it with export_status. The file stays " +
        "in Deckastra: this tool cannot write to a path, and the user saves it from the app.",
      inputSchema: {
        presentation_id: z.string().min(1),
        kind: z.enum(["pdf", "pptx"]),
        include_notes: z.boolean().default(false),
        at_time: z.enum(["final", "initial"]).default("final"),
      },
    },
    async ({ presentation_id, kind, include_notes, at_time }) =>
      guard(async () =>
        json(
          await client.exports.start(presentation_id, {
            kind,
            include_notes,
            at_time,
            // Minted here, not accepted from the caller. An idempotency key a
            // client chooses is a key a client can reuse, and two exports
            // sharing one collapse into a single job whose result is attributed
            // to whichever asked first.
            idempotency_key: crypto.randomUUID(),
          }),
        ),
      ),
  );

  server.registerTool(
    "export_status",
    {
      title: "Check an export",
      description:
        "An export job's progress, and its degradation report when it finishes: what was " +
        "flattened, rasterized, dropped or approximated.",
      annotations: { readOnlyHint: true },
      inputSchema: { export_id: z.string().min(1) },
    },
    async ({ export_id }) => guard(async () => json(await client.exports.status(export_id))),
  );

  server.registerTool(
    "export_cancel",
    {
      title: "Cancel an export",
      description: "Stop an export that is still running.",
      inputSchema: { export_id: z.string().min(1) },
    },
    async ({ export_id }) => guard(async () => json(await client.exports.cancel(export_id))),
  );
}

interface AuthoredResult {
  outcome: string;
  risk_tier: string;
  reasons: string[];
  transaction_id?: string | null;
  version_id?: string | null;
  expires_at?: string | null;
  preview?: unknown;
  document?: unknown;
}

/**
 * The authored-proposal route, called directly.
 *
 * The one place this adapter reaches past `WorkspaceClient`. `client.agent.edit`
 * sends an *instruction*, and the API pays a model to turn it into operations —
 * which is exactly the bill an external agent must not generate, having already
 * done that work itself. Rather than widening the shared interface for a route
 * only this surface uses, it goes through fetch here and moves onto the interface
 * if a second caller ever appears.
 */
export async function proposeAuthored(
  client: WorkspaceClient,
  attached: Attached,
  presentationId: string,
  body: { operations: unknown[]; intent: string; expected_version_id: string; reason?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AuthoredResult> {
  const response = await fetchImpl(
    `${attached.baseUrl}/v1/presentations/${encodeURIComponent(presentationId)}/proposals`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${attached.attachment.grant}`,
      },
      body: JSON.stringify({ ...body, client_label: client.clientId.replace(/^mcp:/, "") }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = payload.detail as { message?: string } | string | undefined;
    const message =
      typeof detail === "string"
        ? detail
        : (detail?.message ?? `The change was refused (${response.status}).`);
    const error = new Error(message);
    (error as { status?: number }).status = response.status;
    throw error;
  }
  return payload as unknown as AuthoredResult;
}
