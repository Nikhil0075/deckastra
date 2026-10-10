import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkspaceClient } from "@deckastra/workspace-contracts";

import type { Attached } from "./attach";

const PURPOSES = ["business", "product", "teaching", "technical", "team", "personal"] as const;
type Purpose = (typeof PURPOSES)[number];

const AUTHORING_GUIDE = `# Authoring in Deckastra

Deckastra is the deterministic presentation engine; you provide narrative intent and words.

## Create

1. Call \`workspace_list\` to find the target project.
2. Call \`preset_list\` with the deck purpose. Every template composes in a design language; filter by \`language\` if the person named a look.
3. Call \`design_language_get\` for the chosen template's language and follow its rules and density limits when you write slot text.
4. Prefer \`deck_from_template\`: fill named slots under stable slide keys in one call.
5. Use \`deck_compose\` only when the template sequence does not fit, and pass the same \`design_language\`. StoryPlan layouts are limited to \`title\`, \`statement\`, \`bullets\`, \`metrics\`, \`quote\`, \`code\`, and \`split\`.

Never send coordinates, font sizes, colours, timing in milliseconds, or raw document JSON to the creation tools. Deckastra owns geometry, theme tokens, motion timing, schema validity, and export mapping.

## Revise safely

1. Call \`document_read\` before editing and keep its \`version_id\`.
2. Address elements by id and propose the smallest complete operation set with \`document_propose\`.
3. Pass the version you read as \`expected_version_id\`. On conflict, read again and re-author; never retry a stale patch unchanged.
4. Use semantic roles such as \`headline\`, \`body\`, \`metric\`, \`quote\`, and \`caption\`; do not infer importance from coordinates.
5. Use \`slide_preview\` and \`design_check\` to review the result. After motion changes, use \`motion_preview\` to inspect the time-labelled frame strip. Author motion by role and pacing, never by duration.

Risky changes wait for the person in Deckastra. You may list or withdraw your own proposal, but you cannot approve, share, or move a deck to another workspace.
`;

const EXAMPLES: Record<Purpose, { template_id: string; title: string; content: Record<string, Record<string, unknown>> }> = {
  business: {
    template_id: "business-pitch",
    title: "Pilot proposal",
    content: {
      opening: { eyebrow: "PILOT PROPOSAL", headline: "Turn one recurring delay into a measurable win", subtitle: "A six-week test with a clear owner and exit signal" },
      problem: { headline: "The handoff costs two days every week", body: "Decisions wait because evidence, ownership and status are separated." },
      approach: { bullets: ["Name one accountable owner", "Keep evidence beside the decision", "Review one shared signal weekly"] },
      close: { headline: "Approve the pilot and name the first team" },
    },
  },
  product: {
    template_id: "product-launch",
    title: "Atlas launch",
    content: {
      opening: { eyebrow: "INTRODUCING ATLAS", headline: "The calm way to finish cross-team work", subtitle: "From scattered context to one visible path" },
      tension: { headline: "The work is fast; the handoffs are not", body: "Teams lose the thread between deciding, making and shipping." },
      experience: { bullets: ["Start from the outcome", "Keep changes editable", "Share one source of progress"] },
      availability: { headline: "Available to the first design partners today" },
    },
  },
  teaching: {
    template_id: "teaching-workshop",
    title: "Evidence-first decisions",
    content: {
      opening: { headline: "Make a decision people can test", subtitle: "A 45-minute working session" },
      goal: { headline: "Leave with one decision and its evidence", body: "You will turn a vague disagreement into a measurable next step." },
      model: { bullets: ["State the decision", "Name the evidence", "Choose a reversible next step"] },
      practice: { headline: "Apply the model to a live decision" },
    },
  },
  technical: {
    template_id: "technical-architecture",
    title: "Queue boundary review",
    content: {
      opening: { headline: "Separate coordination from execution", subtitle: "Decision, evidence and migration path" },
      constraints: { bullets: ["No silent loss", "Idempotent retries", "Observable ownership", "Incremental migration"] },
      proposal: { headline: "Put a durable queue behind one narrow contract", bullets: ["Versioned inputs", "Explicit outcomes", "Replayable work"] },
      decision: { headline: "Approve the boundary; shadow the existing path first" },
    },
  },
  team: {
    template_id: "team-all-hands",
    title: "October team update",
    content: {
      opening: { headline: "What we learned—and where we focus next" },
      wins: { headline: "The customer path is getting clearer" },
      focus: { bullets: ["Finish the onboarding path", "Remove the weekly bottleneck", "Share decisions one day earlier"] },
      close: { headline: "Keep the signal strong" },
    },
  },
  personal: {
    template_id: "personal-portfolio",
    title: "Selected work",
    content: {
      opening: { headline: "Making complex systems feel clear", subtitle: "Selected product and narrative work" },
      belief: { quote: "Clarity is choosing what deserves attention.", attribution: "Working principle" },
      work: { headline: "From fragmented workflow to one calm path", bullets: ["Research", "System design", "Measured rollout"] },
      close: { headline: "The next good problem starts with a conversation" },
    },
  },
};

function markdownResource(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

function exampleMarkdown(purpose: Purpose): string {
  const example = EXAMPLES[purpose];
  return `# ${purpose[0]!.toUpperCase()}${purpose.slice(1)} deck example

Call \`preset_list\` first, then use this as a compact starting shape for \`deck_from_template\`. Replace every factual claim with information supplied by the user or evidence you can cite.

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`
`;
}

export function registerGuidance(server: McpServer, client: WorkspaceClient, attached: Attached): void {
  server.registerResource(
    "deckastra-authoring-guide",
    "deckastra://guides/authoring",
    { title: "Deckastra authoring guide", description: "Roles, slots, safe revision workflow and refusal boundaries.", mimeType: "text/markdown" },
    async (uri) => markdownResource(uri, AUTHORING_GUIDE),
  );

  server.registerResource(
    "deckastra-current-theme",
    "deckastra://current/theme",
    { title: "Current deck theme tokens", description: "The portable theme and token values for the deck open in Deckastra.", mimeType: "text/markdown" },
    async (uri) => {
      const presentationId = attached.attachment.presentationId;
      if (!presentationId) return markdownResource(uri, "# Current deck theme\n\nNo deck is open. Open the target deck in Deckastra and read this resource again.\n");
      try {
        const read = await client.documents.read(presentationId, { fresh: true });
        return markdownResource(
          uri,
          `# Current deck theme\n\nPresentation: \`${presentationId}\`\n\nUse token names; never copy resolved colours or font sizes into geometry.\n\n\`\`\`json\n${JSON.stringify(read.document.theme, null, 2)}\n\`\`\`\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return markdownResource(uri, `# Current deck theme\n\nThe open deck could not be read: ${message}\n`);
      }
    },
  );

  for (const purpose of PURPOSES) {
    server.registerResource(
      `deckastra-example-${purpose}`,
      `deckastra://examples/${purpose}`,
      { title: `${purpose} deck example`, description: `A worked ${purpose} template payload.`, mimeType: "text/markdown" },
      async (uri) => markdownResource(uri, exampleMarkdown(purpose)),
    );
  }

  server.registerPrompt(
    "build_deck",
    {
      title: "Build a reviewed Deckastra deck",
      description: "Create a deck from a reviewed template with deterministic layout.",
      argsSchema: {
        purpose: z.enum(PURPOSES),
        topic: z.string().min(1).max(300),
        audience: z.string().min(1).max(300),
      },
    },
    ({ purpose, topic, audience }) => ({
      description: `Build a ${purpose} deck about ${topic}`,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            `Build a ${purpose} presentation about ${topic} for ${audience}. ` +
            `Read deckastra://guides/authoring and deckastra://examples/${purpose}. ` +
            "Call workspace_list and preset_list, then create the complete first draft with deck_from_template in one call. " +
            "Preview representative slides and run design_check. Do not invent facts or send geometry.",
        },
      }],
    }),
  );

  server.registerPrompt(
    "revise_deck",
    {
      title: "Revise the open Deckastra deck",
      description: "Read, propose and visually check a version-safe deck revision.",
      argsSchema: { instruction: z.string().min(1).max(1_000) },
    },
    ({ instruction }) => ({
      description: "Revise the open deck without overwriting newer work",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            `Revise the deck currently open in Deckastra: ${instruction}\n\n` +
            "Read deckastra://guides/authoring and deckastra://current/theme. Use workspace_list to identify the open deck, " +
            "then document_read. Propose the smallest complete patch against the returned version_id, preview each affected slide, " +
            "and run design_check. Leave any risky proposal for the user to approve.",
        },
      }],
    }),
  );
}
