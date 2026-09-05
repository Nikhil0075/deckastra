/**
 * The TypeScript patch applier, exposed as a stdin/stdout filter.
 *
 * Exists so the Python conformance test can compare against the *real*
 * implementation rather than against a Python re-description of it. Comparing an
 * implementation to a paraphrase of itself tests nothing.
 *
 *   echo '[{"document":…,"operations":[…]}, …]' | npx tsx scripts/apply_patch_reference.ts
 *
 * Takes a batch and returns one result per case, because starting Node costs far
 * more than applying a patch — per-case invocation turned the conformance suite
 * into a minute of process startup, which is how a test ends up skipped.
 *
 * Each result is `{document, inverse}` on success and `{error, code}` on a
 * rejected patch: a rejection is a result to compare, not a crash.
 */
import { applyPatch, PatchError } from "../packages/transactions/src/index";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

type Case = { document: unknown; operations: Parameters<typeof applyPatch>[1] };

function runCase(input: Case): unknown {
  try {
    const { document, inverse } = applyPatch(input.document, input.operations);
    return { document, inverse };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof PatchError ? error.code : "UNKNOWN",
    };
  }
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as Case | Case[];
  const batch = Array.isArray(input) ? input : [input];
  process.stdout.write(JSON.stringify(batch.map(runCase)));
}

void main();
