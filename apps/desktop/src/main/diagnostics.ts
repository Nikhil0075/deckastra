import { app } from "electron";

import type { ServiceStatus } from "../shared/ipc";
import { buildManifest } from "./build-manifest";
import { accountState } from "./account";
import { readAgentAccess } from "./agent-access";
import { logsDir, tail } from "./logs";

/**
 * A report someone can send without a developer console (final package review,
 * item 18).
 *
 * Everything in it is either a fact about this build and this machine's
 * configuration, or a tail of the logs — which are written under the rule in
 * `logs.ts`: nothing user-written is logged in the first place, and the
 * credentials whose shape is known are redacted on the way in.
 *
 * What it deliberately does not contain: the API key (only whether one is set),
 * the launch secret, an agent grant, deck titles, deck content, prompts, or the
 * contents of any file. A path is included — the data directory — because "it
 * failed to start" is not answerable without knowing where it was looking.
 */

export interface Diagnostics {
  format: 1;
  generatedAt: string;
  app: { version: string; packaged: boolean };
  runtime: { electron: string; chrome: string; node: string; platform: string };
  build: unknown;
  dataDir: string;
  logsDir: string;
  service: { state: string; detail?: string; kind?: string; attempt: number };
  generation: { provider: string; available: boolean; reason: string | null } | { error: string };
  account: { signedIn: boolean; configured: boolean };
  agentAccess: { allowed: boolean; expiresAt: string | null; decidedAt: string | null };
  logs: { app: string[]; service: string[] };
}

/** Ask the service what it would do, without going through the window. */
async function generation(service: { port: number; secret: string } | null) {
  if (!service) return { error: "the workspace service was not running when this was written" };
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/health`, {
      headers: { authorization: `Bearer ${service.secret}` },
    });
    const body = (await response.json()) as { intelligence?: string; intelligence_error?: string | null };
    return {
      provider: String(body.intelligence ?? "unknown"),
      available: body.intelligence !== "none" && body.intelligence !== "misconfigured" && !body.intelligence_error,
      reason: body.intelligence_error ?? null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectDiagnostics(input: {
  status: ServiceStatus;
  service: { port: number; secret: string } | null;
  dataDir: string;
}): Promise<Diagnostics> {
  const access = await readAgentAccess();
  return {
    format: 1,
    generatedAt: new Date().toISOString(),
    app: { version: app.getVersion(), packaged: app.isPackaged },
    runtime: {
      electron: process.versions.electron ?? "unknown",
      chrome: process.versions.chrome ?? "unknown",
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
    },
    build: await buildManifest(),
    dataDir: input.dataDir,
    logsDir: logsDir(),
    service: {
      state: input.status.state,
      detail: input.status.detail,
      kind: input.status.kind,
      attempt: input.status.attempt,
    },
    generation: await generation(input.service),
    account: await accountState().then(({ signedIn, configured }) => ({ signedIn, configured })),
    // Whether an agent may reach this install, and until when. Never the grant.
    agentAccess: { allowed: access.allowed, expiresAt: access.expiresAt, decidedAt: access.decidedAt },
    logs: { app: tail("app"), service: tail("service") },
  };
}

export function diagnosticsFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `deckastra-diagnostics-${app.getVersion()}-${stamp}.json`;
}
