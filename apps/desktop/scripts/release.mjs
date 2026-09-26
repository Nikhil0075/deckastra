import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest } from "./manifest.mjs";
import { authenticodeProbe, verifyRelease } from "./verify-release.mjs";

/**
 * `npm run release:win` — the one command that may produce a release.
 *
 * `npm run package` makes an installer and stays what it is: a development
 * package, unsigned unless credentials happen to be set, never called a
 * release. This wraps it with the parts that make a release a release, and
 * none of them is optional:
 *
 * - **Credentials first.** Without a certificate (`CSC_LINK`) and the name it
 *   must carry (`DECKASTRA_SIGNING_PUBLISHER`), it stops before building
 *   anything. electron-builder would otherwise produce an unsigned installer
 *   with a green log.
 * - **A clean output folder.** `release/` is emptied, so the installer checked
 *   is the one this run built and not one left from an earlier build.
 * - **The strict gate on that exact output** (`verify-release.mjs` with signing
 *   required): current, intact, one installer, our executables signed by our
 *   publisher, and no native file changed without a valid signature.
 * - **A report beside the installer** (`release-report.json`): its SHA-256, the
 *   build it contains, and every native file's signature status. Success is
 *   the report plus exit code 0; anything else is not a release.
 *
 * Windows x64 only, which is this release's scope. macOS needs its own build,
 * notarization and a machine to run it on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = dirname(HERE);
const RELEASE = join(DESKTOP, "release");

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

if (process.platform !== "win32") fail("release:win builds the Windows release and runs only on Windows.");
if (!process.env.CSC_LINK) {
  fail(
    "No signing certificate (CSC_LINK, with CSC_KEY_PASSWORD). A release is signed; " +
      "for an unsigned development installer use `npm run package`.",
  );
}
const publisher = process.env.DECKASTRA_SIGNING_PUBLISHER;
if (!publisher) {
  fail("Set DECKASTRA_SIGNING_PUBLISHER to the certificate subject our executables must carry (for example CN=...).");
}

if (existsSync(RELEASE)) rmSync(RELEASE, { recursive: true, force: true });

const env = { ...process.env, DECKASTRA_RELEASE: "1" };
const build = spawnSync("npm", ["run", "package"], { cwd: DESKTOP, env, stdio: "inherit", shell: true });
if (build.status !== 0) fail(`npm run package failed (exit ${build.status}).`);

const { ok, problems, report } = verifyRelease({
  releaseDir: RELEASE,
  distManifest: join(DESKTOP, "dist", "build-manifest.json"),
  current: buildManifest(),
  probe: authenticodeProbe,
  publisher,
  requireSigned: true,
});

writeFileSync(
  join(RELEASE, "release-report.json"),
  `${JSON.stringify({ ok, problems, publisher, verifiedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
  "utf8",
);

if (!ok) {
  for (const problem of problems) console.error(`[release] ${problem}`);
  fail("The build is not a release. See release/release-report.json.");
}
console.log(`[release] ${report.installer.file}\n[release] sha256 ${report.installer.sha256}`);
