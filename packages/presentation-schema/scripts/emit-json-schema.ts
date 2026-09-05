/**
 * Emits JSON Schema from the Zod definitions.
 *
 * The generation chain is one-directional and must stay that way (doc 02 §34.4):
 *
 *     Zod schemas  (normative, hand-written)
 *          |
 *     JSON Schema  (generated, committed)
 *          |
 *     Python validation, MCP tool inputSchema, external tooling, docs
 *
 * Nothing downstream is ever hand-edited. The Python service validates documents
 * against this exact artifact rather than against a translated copy of the model,
 * so there is no second definition to drift from — which is the whole reason the
 * schema package is TypeScript and the API is Python.
 *
 *   npm run schema:emit    regenerate
 *   npm run schema:drift   fail if the committed artifact is stale (CI)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  PatchOperationSchema,
  PatchSchema,
  PresentationDocumentSchema,
  SCHEMA_VERSION,
  ThemeDefinitionSchema,
  TransactionSchema,
} from "../src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "generated");

const TARGETS: { file: string; title: string; schema: z.ZodType<unknown> }[] = [
  {
    file: "mydeck-document.schema.json",
    title: "Deckastra .mydeck presentation document",
    schema: PresentationDocumentSchema as z.ZodType<unknown>,
  },
  {
    file: "mydeck-theme.schema.json",
    title: "Deckastra theme definition",
    schema: ThemeDefinitionSchema as z.ZodType<unknown>,
  },
  {
    file: "mydeck-patch.schema.json",
    title: "Deckastra patch",
    schema: PatchSchema as z.ZodType<unknown>,
  },
  {
    file: "mydeck-patch-operation.schema.json",
    title: "Deckastra patch operation",
    schema: PatchOperationSchema as z.ZodType<unknown>,
  },
  {
    file: "mydeck-transaction.schema.json",
    title: "Deckastra transaction",
    schema: TransactionSchema as z.ZodType<unknown>,
  },
];

function emit(title: string, schema: z.ZodType<unknown>): string {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // The model is recursive (a group contains elements which contain groups), so
    // cycles are expressed as $ref rather than being inlined or rejected.
    cycles: "ref",
    reused: "ref",
    // Some leaves are deliberately unconstrained — `Keyframe.value` holds whatever
    // the animated property takes, and `extensions` holds anything a future client
    // put there. Emitting `true` keeps them permissive instead of failing the run.
    unrepresentable: "any",
    io: "input",
  });

  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    description:
      `Generated from @deckastra/presentation-schema v${SCHEMA_VERSION}. Do not edit by hand — ` +
      `run "npm run schema:emit" instead. The Zod definitions in src/ are normative.`,
    "x-schema-version": SCHEMA_VERSION,
    ...jsonSchema,
  };

  return JSON.stringify(document, null, 2) + "\n";
}

function main(): void {
  const check = process.argv.includes("--check");
  mkdirSync(OUT_DIR, { recursive: true });

  let stale = false;

  for (const { file, title, schema } of TARGETS) {
    const next = emit(title, schema);
    const path = join(OUT_DIR, file);

    if (check) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (current !== next) {
        stale = true;
        console.error(`  DRIFT  ${file} is out of date`);
      } else {
        console.log(`  ok     ${file}`);
      }
      continue;
    }

    writeFileSync(path, next, "utf8");
    console.log(`  wrote  ${file} (${(next.length / 1024).toFixed(1)} KB)`);
  }

  if (stale) {
    console.error(
      "\nThe committed JSON Schema no longer matches the Zod definitions.\n" +
        'Run "npm run schema:emit" and commit the result. Never edit generated/ by hand.',
    );
    process.exit(1);
  }
}

main();
