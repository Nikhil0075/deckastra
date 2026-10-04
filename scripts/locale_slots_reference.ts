/**
 * The TypeScript text-slot enumeration and hash, as a stdin/stdout filter.
 *
 * For `apps/api/tests/test_locale_conformance.py`, which holds the Python
 * enumeration in `deckastra_api/locales.py` to this one — the same arrangement
 * as `apply_patch_reference.ts` and for the same reason: a second
 * implementation compared with a paraphrase of itself would test nothing.
 *
 *   echo '[document, …]' | npx tsx scripts/locale_slots_reference.ts
 *
 * Answers, per document, every slot as `{path, kind, hash}`.
 */
import { localeSlots, localeTextHash, type PresentationDocument } from "../packages/presentation-schema/src/index";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const documents = JSON.parse(await readStdin()) as PresentationDocument[];
  const answer = documents.map((document) =>
    localeSlots(document).map((slot) => ({ path: slot.path, kind: slot.kind, hash: localeTextHash(slot.value) })),
  );
  process.stdout.write(JSON.stringify(answer));
}

void main();
