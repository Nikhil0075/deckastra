import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What the frozen service must carry, and the check that it is all there
 * (final package review, item 08).
 *
 * Three kinds of file are read by path rather than imported — Alembic's
 * migrations and its config, the generated JSON Schema every document is
 * validated against, and the agent prompts — so nothing bundles them
 * automatically and nothing fails at build time when one is absent.
 *
 * They used to be filtered with `existsSync`, which turned a moved path or a
 * checkout that had never run `schema:emit` into a binary quietly missing one
 * of them. The failure then arrived on a user's machine, as a migration that
 * could not run or a document that could not be validated, with nothing naming
 * the cause. Now the build stops here.
 *
 * Emptiness counts as missing: a directory satisfies `existsSync` and ships
 * nothing.
 */

export function dataEntries(root) {
  return [
    // Migrations and their config: read by path, never imported.
    [join(root, "infrastructure", "database", "migrations"), "infrastructure/database/migrations"],
    [join(root, "infrastructure", "database", "alembic.ini"), "infrastructure/database"],
    // The generated schema artifact the API validates every document against.
    [join(root, "packages", "presentation-schema", "generated"), "packages/presentation-schema/generated"],
    // Prompts the agent system loads as files.
    [join(root, "agents", "deckastra_agents", "prompts"), "deckastra_agents/prompts"],
  ];
}

/** Which of them are absent or empty, as sentences a build can print. */
export function missingData(entries) {
  const missing = [];
  for (const [from] of entries) {
    if (!existsSync(from)) {
      missing.push(`${from} (not found)`);
      continue;
    }
    if (statSync(from).isDirectory() && readdirSync(from).length === 0) missing.push(`${from} (empty)`);
  }
  return missing;
}
