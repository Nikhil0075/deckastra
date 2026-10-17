/** Types for `sidecar-lock.mjs` (the build scripts are plain JavaScript, with no compile step). */
export const WINDOWS_LOCK: string;
export function sidecarLockName(platform?: string, arch?: string): string;
export function sidecarLockFile(desktop: string, platform?: string, arch?: string): string;
