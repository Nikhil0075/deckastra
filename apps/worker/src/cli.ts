/**
 * The export CLI — how the Python API reaches the worker.
 *
 * A process boundary rather than a service, for now. The renderer, the adapters
 * and the animation engine are all TypeScript; the API is Python. The options
 * were a long-running Node service with an HTTP surface, or a subprocess, and
 * a subprocess is the honest choice while there is one machine: no port to
 * allocate, no health check, no second thing to deploy, and the failure mode is
 * a non-zero exit code with stderr attached rather than a connection error.
 *
 * The contract is deliberately narrow so it can become a service later without
 * the caller changing: **JSON in on stdin, JSON out on stdout, bytes to a file.**
 * Progress goes to stderr as one JSON object per line, which keeps stdout a
 * single parseable value.
 *
 *   echo '{"kind":"pdf","output":"/tmp/deck.pdf","document":{...}}' \
 *     | npx tsx apps/worker/src/cli.ts
 */

import { readFileSync, writeFileSync } from "node:fs";

import { runExport, type ExportKind } from "./index";
import { RenderPool, render } from "./render";

interface Invocation {
  /**
   * `png` renders one slide instead of packaging a deck.
   *
   * The same contract, because the caller is the same: JSON in, JSON out, bytes
   * to a file. It exists so a proposal can be *seen* before it is approved —
   * an agent that cannot look at its own change has to ask the user to.
   */
  kind: ExportKind | "png";
  /** Where to write the artifact. */
  output: string;
  /** The document, inline or as a path — a 60-slide deck is large for an argv. */
  document?: unknown;
  documentPath?: string;
  options?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  const invocation = JSON.parse(raw) as Invocation;

  const document = invocation.documentPath
    ? JSON.parse(readFileSync(invocation.documentPath, "utf8"))
    : invocation.document;

  if (!document) throw new Error("no document was supplied");

  if (invocation.kind === "png") {
    const options = (invocation.options ?? {}) as {
      slideIds?: string[];
      scale?: number;
      atTime?: number | "final" | "initial";
    };
    const pool = new RenderPool();
    try {
      const rendered = await render(
        {
          document: document as never,
          format: "png",
          ...(options.slideIds ? { slideIds: options.slideIds } : {}),
          ...(options.scale ? { scale: options.scale } : {}),
          atTimeMs: options.atTime ?? "final",
        },
        pool,
      );
      const [artifact] = rendered.artifacts;
      if (!artifact) throw new Error("No such slide in this deck.");

      writeFileSync(invocation.output, artifact.bytes);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          output: invocation.output,
          bytes: artifact.bytes.length,
          slideId: artifact.slideId,
          width: artifact.width,
          height: artifact.height,
          metricsEstimated: rendered.metricsEstimated,
        }),
      );
      return;
    } finally {
      await pool.close();
    }
  }

  const outcome = await runExport(
    {
      kind: invocation.kind,
      document: document as never,
      options: (invocation.options ?? {}) as never,
    },
    (progress) => {
      // stderr, one object per line. stdout stays a single JSON value so the
      // caller can parse it without scanning for a delimiter.
      process.stderr.write(`${JSON.stringify({ type: "progress", ...progress })}\n`);
    },
  );

  writeFileSync(invocation.output, outcome.bytes);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: invocation.output,
      bytes: outcome.bytes.length,
      filename: outcome.filename,
      contentType: outcome.contentType,
      report: outcome.report,
    }),
  );
}

main().catch((error: unknown) => {
  // A structured failure, not a stack trace on stdout: the caller reports this
  // to a user, and "Error: ENOENT" with a JavaScript stack under it is not
  // something a user can act on.
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
});
