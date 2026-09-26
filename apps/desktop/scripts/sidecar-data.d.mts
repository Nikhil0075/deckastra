/** Types for `sidecar-data.mjs` (the build scripts are plain JavaScript, with no compile step). */
export function dataEntries(root: string): Array<[from: string, to: string]>;
export function missingData(entries: Array<[from: string, to: string]>): string[];
