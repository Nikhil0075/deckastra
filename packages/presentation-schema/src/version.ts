/**
 * Schema version constants.
 *
 * Semantics (doc 02 §35.1):
 *   major — breaking. A reader whose supported major is lower refuses the document outright.
 *   minor — additive. New optional properties or element types.
 *   patch — clarification or fix that changes no representation.
 */
export const SCHEMA_VERSION = "1.1.0" as const;

/** The oldest document version this reader can migrate forward from. */
export const MIN_SUPPORTED_SCHEMA_VERSION = "1.0.0" as const;

/** Majors this reader can open at all (doc 02 §35.4). */
export const SUPPORTED_MAJOR = 1 as const;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVer(version: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new Error(`Not a parseable schema version: ${JSON.stringify(version)}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareSemVer(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] < y[k]) return -1;
    if (x[k] > y[k]) return 1;
  }
  return 0;
}

/**
 * Forward-compatible *reading* is not forward-compatible *editing* (doc 02 §0.8).
 * A newer major is refused rather than partially understood.
 */
export function isReadableSchemaVersion(version: string): boolean {
  return parseSemVer(version).major === SUPPORTED_MAJOR;
}
