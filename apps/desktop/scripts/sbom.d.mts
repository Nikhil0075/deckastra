/** Types for `sbom.mjs` (build scripts are plain JavaScript, with no compile step). */
export interface SbomComponent {
  type: string;
  name: string;
  version: string;
  purl: string;
  hashes?: Array<{ alg: string; content: string }>;
  properties?: Array<{ name: string; value: string }>;
}

export function parseLock(text: string): Array<{ name: string; version: string; hashes: string[] }>;

export function buildSbom(): {
  bomFormat: string;
  specVersion: string;
  version: number;
  metadata: { timestamp: string; component: { type: string; name: string; version: string; purl: string }; tools: Array<{ name: string }> };
  components: SbomComponent[];
};
