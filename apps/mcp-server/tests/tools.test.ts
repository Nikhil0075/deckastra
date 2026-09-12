import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import animationFixture from "@deckastra/presentation-schema/fixtures/animation-test.mydeck.json" with { type: "json" };

import type { Attached } from "../src/attach";
import { createAttachedClient } from "../src/client";
import { registerTools } from "../src/tools";

/**
 * The agent's side of the seam, driven over the real protocol.
 *
 * A `Client` and an `InMemoryTransport` rather than reaching into the server's
 * internals, because what matters is what an agent can actually call — a tool
 * registered but not reachable, or reachable with a different schema than it was
 * declared with, would pass an internals check and fail a real session.
 *
 * The service underneath is a stubbed `fetch` that records what arrived. These
 * cases exist to check what reached the authority, and a faked client would let a
 * changed request body pass every one of them.
 */

interface Sent {
  url: string;
  method: string;
  body: unknown;
  authorization?: string;
}

let sent: Sent[];

const account = {
  user: { id: "usr_local", email: "local@deckastra.invalid", name: "You" },
  workspaces: [
    {
      id: "wsp_local",
      name: "Yours",
      role: "owner",
      projects: [{ id: "prj_local", name: "First", description: null }],
    },
  ],
};

function stubService(answers: Record<string, unknown> = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.Authorization ?? headers.authorization,
    });

    const path = url.replace("http://127.0.0.1:51234", "");
    const match = Object.keys(answers).find((key) => path.startsWith(key));
    const payload = match
      ? answers[match]
      : path.endsWith("/v1/account")
        ? account
        : /^\/v1\/projects\/[^/]+\/presentations$/.test(path)
          ? { presentations: decks }
          : { document: animationFixture, version_id: "ver_1", can_edit: true };

    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
}

/** What the project list answers, most recently changed first. */
const decks = [
  { id: "pres_open", title: "Q3 Review", version_id: "ver_1", updated_at: "2026-09-12T00:10:00Z" },
  { id: "pres_other", title: "Hiring plan", version_id: "ver_9", updated_at: "2026-09-01T09:00:00Z" },
];

const attached: Attached = {
  baseUrl: "http://127.0.0.1:51234",
  attachment: {
    version: 2,
    port: 51_234,
    grant: "dk1.payload.signature",
    scopes: ["read", "write", "export"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    pid: process.pid,
    appVersion: "0.0.0",
    presentationId: "pres_open",
  },
};

async function connect(answers?: Record<string, unknown>): Promise<Client> {
  const fetchImpl = stubService(answers);
  globalThis.fetch = fetchImpl;

  const server = new McpServer({ name: "deckastra", version: "test" });
  registerTools(server, createAttachedClient(attached, "codex"), attached);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0" });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}

function text(result: unknown): string {
  return String((result as { content: { text: string }[] }).content[0]!.text);
}

beforeEach(() => {
  sent = [];
});

describe("the tool surface", () => {
  it("gives an agent no way to approve its own proposal", async () => {
    const names = (await (await connect()).listTools()).tools.map((tool) => tool.name);

    // The product's central claim is that a human stays in control of a risky
    // change. An agent that could approve its own work would reduce that claim
    // to a delay, so the absence is the feature and this is the case that keeps
    // it from being added back by someone wiring up "the missing tool".
    expect(names).not.toContain("proposal_approve");
    expect(names).not.toContain("proposal_reject");
    // Issuing a share link is granting a bearer credential to a document.
    expect(names.filter((name) => name.includes("share"))).toEqual([]);
    // It can still see what is waiting, which is what makes the refusal usable.
    expect(names).toContain("proposal_list");
  });

  it("names the deck the user has open, so an agent need not guess", async () => {
    const result = await (await connect()).callTool({ name: "workspace_list", arguments: {} });
    expect(JSON.parse(text(result)).openPresentationId).toBe("pres_open");
  });

  it("lists every deck in each project, not only the open one", async () => {
    // A real Claude Code session found this: the tool promised decks and
    // returned projects, so "which decks do I have" could name the open deck and
    // nothing else.
    const result = await (await connect()).callTool({ name: "workspace_list", arguments: {} });
    const project = JSON.parse(text(result)).workspaces[0].projects[0];

    expect(project.decks.map((deck: { title: string }) => deck.title)).toEqual(["Q3 Review", "Hiring plan"]);
    // The open one is marked in place, so an agent does not have to cross-
    // reference two fields to find the deck the user is looking at.
    expect(project.decks[0].open).toBe(true);
    expect(project.decks[1].open).toBeUndefined();
    expect(sent.some((request) => request.url.endsWith("/v1/projects/prj_local/presentations"))).toBe(true);
  });

  it("offers motion in roles, and gives an agent no way to send a duration", async () => {
    const client = await connect({
      "/v1/motion/capabilities": {
        presets: ["fade", "springIn"],
        pacing: { tight: { durationMs: 300, gapMs: 60 } },
        roles: ["headline", "body"],
        entrance_budget_ms: 2500,
        read_immediately_words: 24,
        notes: [],
      },
      "/v1/presentations/pres_open/motion": {
        outcome: "applied",
        risk_tier: "low",
        transaction_id: "txn_m",
        version_id: "ver_2",
        track_count: 2,
        warnings: ["body on a slide is long enough that the audience needs it immediately"],
      },
    });

    const capabilities = JSON.parse(
      text(await client.callTool({ name: "motion_capabilities", arguments: {} })),
    );
    expect(capabilities.entrance_budget_ms).toBe(2500);

    const tools = (await client.listTools()).tools;
    const propose = tools.find((tool) => tool.name === "motion_propose")!;
    const fields = Object.keys(propose.inputSchema.properties ?? {});
    // The split this whole surface exists to keep: roles and pacing in,
    // milliseconds computed. A duration field here would move that line.
    expect(fields).toContain("sequence");
    expect(fields).toContain("pacing");
    expect(fields.filter((field) => /ms$|duration|delay|easing/i.test(field))).toEqual([]);

    const result = JSON.parse(
      text(
        await client.callTool({
          name: "motion_propose",
          arguments: {
            presentation_id: "pres_open",
            slide_id: "sld_1",
            expected_version_id: "ver_1",
            sequence: ["headline", "body"],
            pacing: "tight",
          },
        }),
      ),
    );
    expect(result.outcome).toBe("applied");
    // What the composer left alone reaches the agent rather than being dropped.
    expect(result.warnings[0]).toMatch(/needs it immediately/);

    const sentMotion = sent.find((request) => request.url.endsWith("/motion"))!;
    expect(sentMotion.body).toMatchObject({
      slide_id: "sld_1",
      expected_version_id: "ver_1",
      sequence: ["headline", "body"],
      pacing: "tight",
      client_label: "codex",
    });
  });

  it("answers with an outline, not the whole document", async () => {
    const result = await (await connect()).callTool({
      name: "document_read",
      arguments: { presentation_id: "pres_open" },
    });
    const outline = JSON.parse(text(result));

    // The bound that makes the tool usable at all: the animation fixture in full
    // is tens of thousands of characters, most of it transforms and token
    // references an agent cannot act on.
    expect(text(result).length).toBeLessThan(JSON.stringify(animationFixture).length / 3);
    // But every id an operation needs is present, because a summary an agent
    // cannot address is a description rather than a working surface.
    expect(outline.slides[0].id).toMatch(/^sld_/);
    expect(outline.slides[0].elements[0].id).toMatch(/^el_/);
    expect(outline.versionId).toBe("ver_1");
  });

  it("hands back a slide as an image the model can look at", async () => {
    // Two real sessions had to ask the user whether the result looked right,
    // because the agent could describe its change and not see it.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const client = await connect({
      "/v1/presentations/pres_open/preview": {
        slide_id: "sld_1",
        image_base64: png,
        width: 1024,
        height: 576,
        version_id: "ver_1",
        changed_slide_ids: ["sld_1", "sld_2"],
        metrics_estimated: false,
      },
    });

    const result = (await client.callTool({
      name: "slide_preview",
      arguments: { presentation_id: "pres_open", slide_id: "sld_1", proposal_id: "txn_7" },
    })) as { content: { type: string; text?: string; data?: string; mimeType?: string }[] };

    const picture = result.content.find((part) => part.type === "image")!;
    expect(picture.data).toBe(png);
    expect(picture.mimeType).toBe("image/png");
    // And a caption, because an image with no version or size is a picture of
    // something the agent cannot place.
    expect(result.content[0]!.text).toMatch(/Slide sld_1 at version ver_1, 1024×576/);
    expect(result.content[0]!.text).toMatch(/proposal txn_7 applied to a copy/);
    expect(result.content[0]!.text).toMatch(/Other slides it changes: sld_2/);

    const sent_preview = sent.find((request) => request.url.endsWith("/preview"))!;
    expect(sent_preview.body).toEqual({ slide_id: "sld_1", proposal_id: "txn_7" });

    // Without a proposal it must not describe one. "Other slides this proposal
    // changes: none" on a plain preview reads as a bug in the answer.
    const plain = (await client.callTool({
      name: "slide_preview",
      arguments: { presentation_id: "pres_open", slide_id: "sld_1" },
    })) as { content: { type: string; text?: string }[] };
    expect(plain.content[0]!.text).toMatch(/the deck as it stands/);
    expect(plain.content[0]!.text).not.toMatch(/proposal/);
  });

  it("carries the base version into a proposal, so a stale change cannot overwrite", async () => {
    const client = await connect({
      "/v1/presentations/pres_open/proposals": {
        outcome: "applied",
        risk_tier: "low",
        reasons: [],
        transaction_id: "txn_1",
        version_id: "ver_2",
      },
    });

    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: "pres_open",
        expected_version_id: "ver_1",
        intent: "Retitle the opening slide",
        operations: [{ op: "replace", path: "/metadata/title", value: "New" }],
      },
    });

    const proposal = sent.find((request) => request.url.endsWith("/proposals"))!;
    expect(proposal.method).toBe("POST");
    expect((proposal.body as { expected_version_id: string }).expected_version_id).toBe("ver_1");
  });

  it("never sends an instruction to the paid edit route", async () => {
    const client = await connect({
      "/v1/presentations/pres_open/proposals": {
        outcome: "applied",
        risk_tier: "low",
        reasons: [],
        transaction_id: "txn_1",
        version_id: "ver_2",
      },
    });

    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: "pres_open",
        expected_version_id: "ver_1",
        intent: "Retitle",
        operations: [{ op: "replace", path: "/metadata/title", value: "New" }],
      },
    });

    // An external client supplying its own intelligence must not trigger a paid
    // model call. `agent/edit` takes words and pays a model to turn them into
    // operations; this caller has already done that work.
    expect(sent.some((request) => request.url.includes("/agent/edit"))).toBe(false);
  });

  it("authors under a label that cannot impersonate the product's own agents", async () => {
    const client = await connect({
      "/v1/presentations/pres_open/proposals": {
        outcome: "pending",
        risk_tier: "high",
        reasons: ["Removes an element"],
        transaction_id: "txn_1",
        expires_at: "2026-09-11T00:00:00Z",
      },
    });

    await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: "pres_open",
        expected_version_id: "ver_1",
        intent: "Drop the closing slide",
        operations: [{ op: "remove", path: "/slides/id:sld_x" }],
      },
    });

    const proposal = sent.find((request) => request.url.endsWith("/proposals"))!;
    // The route prefixes this again; what matters here is that the surface never
    // sends "editor", which in an approval prompt would tell a user the
    // product's own edit agent proposed something an external client did.
    expect((proposal.body as { client_label: string }).client_label).toBe("codex");
  });

  it("reports a pending change as awaiting the user, not as done", async () => {
    const client = await connect({
      "/v1/presentations/pres_open/proposals": {
        outcome: "pending",
        risk_tier: "high",
        reasons: ["Removes an element"],
        transaction_id: "txn_1",
        expires_at: "2026-09-11T00:00:00Z",
        preview: animationFixture,
      },
    });

    const result = await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: "pres_open",
        expected_version_id: "ver_1",
        intent: "Drop the closing slide",
        operations: [{ op: "remove", path: "/slides/id:sld_x" }],
      },
    });
    const answer = JSON.parse(text(result));

    // An agent that reads this as success will tell the user their deck is
    // changed when it is not.
    expect(answer.outcome).toBe("pending");
    expect(answer.awaiting).toMatch(/must approve this in Deckastra/i);
    // And the preview is outlined like everything else, rather than returning
    // the whole document the bound exists to keep out.
    expect(answer.would_produce.slideCount).toBeGreaterThan(0);
    expect(answer.would_produce.slides[0].elements[0].transform).toBeUndefined();
  });

  it("mints its own export idempotency key", async () => {
    const client = await connect({
      "/v1/presentations/pres_open/exports": { id: "exp_1", kind: "pdf", status: "queued" },
    });

    await client.callTool({
      name: "document_export",
      arguments: { presentation_id: "pres_open", kind: "pdf" },
    });

    const started = sent.find((request) => request.method === "POST" && request.url.includes("export"))!;
    const key = (started.body as { idempotency_key: string }).idempotency_key;
    // Accepted from the caller, a key is a key a caller can reuse — and two
    // exports sharing one collapse into a single job.
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("turns a conflict into an instruction the agent can follow", async () => {
    globalThis.fetch = (async (url: string) =>
      url.endsWith("/v1/account")
        ? ({ ok: true, status: 200, json: async () => account } as Response)
        : ({
            ok: false,
            status: 409,
            json: async () => ({ detail: { message: "This deck has changed since you read it." } }),
          } as Response)) as unknown as typeof fetch;

    const server = new McpServer({ name: "deckastra", version: "test" });
    registerTools(server, createAttachedClient(attached, "codex"), attached);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0" });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);

    const result = await client.callTool({
      name: "document_propose",
      arguments: {
        presentation_id: "pres_open",
        expected_version_id: "ver_stale",
        intent: "Retitle",
        operations: [{ op: "replace", path: "/metadata/title", value: "New" }],
      },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    // "Request failed" invites a retry loop. This says what to do instead.
    expect(text(result)).toMatch(/Read it again and re-author/i);
  });
});
