import { join } from "node:path";

/**
 * Which dependency lock the frozen service is built from, on this machine.
 *
 * A pip-tools lock resolves for the platform it is compiled on: the Windows one
 * carries `pefile` and `pywin32-ctypes` and has no `macholib`, which PyInstaller
 * needs on macOS, so installing it there with `--require-hashes --no-deps`
 * fails the freeze. macOS therefore has a lock of its own, compiled from the
 * same `sidecar-requirements.in`, and this is the one answer to which of them a
 * build means. `build-sidecar.mjs` installs from it, and `sbom.mjs`,
 * `notices.mjs` and `manifest.mjs` describe it; four places asking separately
 * is how an SBOM comes to list the bytes of a lock the binary was not built
 * from.
 *
 * Only macOS is split off. Every other platform keeps the original file,
 * exactly as before: Windows is the release, and Linux CI reads that lock in
 * the SBOM tests without ever freezing from it. A Mac with no compiled lock
 * (Intel, today) is refused with the command that makes one rather than given
 * the Windows file, which would fail the install with a hash error that names
 * nothing useful.
 */

export const WINDOWS_LOCK = "sidecar-requirements.lock";

const MAC_LOCKS = {
  arm64: "sidecar-requirements.macos-arm64.lock",
};

export function sidecarLockName(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return WINDOWS_LOCK;
  const name = MAC_LOCKS[arch];
  if (name) return name;
  throw new Error(
    `No frozen-service lock is compiled for macOS ${arch}. Compile one on such a Mac, from the same input:\n` +
      "  python -m piptools compile --generate-hashes --strip-extras --allow-unsafe \\\n" +
      `    --output-file apps/desktop/sidecar-requirements.macos-${arch}.lock apps/desktop/sidecar-requirements.in\n` +
      "and name it in scripts/sidecar-lock.mjs.",
  );
}

export function sidecarLockFile(desktop, platform = process.platform, arch = process.arch) {
  return join(desktop, sidecarLockName(platform, arch));
}
