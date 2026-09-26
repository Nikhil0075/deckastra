/** Types for `manifest.mjs`, which is plain JavaScript because the build scripts run without a compile step. */
export interface TreeHash {
  sha256: string;
  files: number;
}

export function hashTree(directory: string, options?: { exclude?: (file: string) => boolean }): TreeHash | null;

export function buildManifest(): {
  format: number;
  app: { name: string; version: string };
  builtAt: string;
  source: { commit: string | null; dirty: boolean | null; changedFiles: number | null; treeSha256: string | null };
  runtime: { electron: string | null; electronBuilder: string | null; node: string; python: string | null };
  payloads: Record<string, TreeHash | null>;
  installed: Record<"worker" | "mcp" | "sidecar", Record<string, string> | null>;
  migrations: TreeHash | null;
  dependencies: { lockSha256: string | null; sbomSha256: string | null };
  complete: boolean;
};

export function fileHashes(directory: string): Record<string, string> | null;

export function writeManifest(file?: string): ReturnType<typeof buildManifest>;
