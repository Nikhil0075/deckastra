/**
 * Is the thing we just built actually signed? (D6)
 *
 * electron-builder signs when it finds credentials and produces an **unsigned
 * artifact with a green log** when it does not. That is the whole hazard: an
 * unsigned build is byte-for-byte a normal build until a user's machine refuses
 * to open it, and the build output that would have told you scrolled past
 * minutes ago among a thousand other lines.
 *
 * So this asks the operating system about the file rather than believing the
 * builder. On Windows that is `Get-AuthenticodeSignature`; on macOS `codesign
 * --verify` plus `spctl --assess`, which is the check Gatekeeper itself makes —
 * a binary can be validly signed and still be refused for not being notarized,
 * and only `spctl` distinguishes those.
 *
 * **It reports by default and fails on demand.** A developer building locally
 * has no certificate and should not be blocked; a release has one and an
 * unsigned artifact there is the bug. `DECKASTRA_RELEASE=1` is that line.
 *
 *   npm run verify:signing                     # report
 *   DECKASTRA_RELEASE=1 npm run verify:signing # and fail if anything is unsigned
 *
 * Nothing here can sign anything. No certificate exists in this repository and
 * none should; this is the check that says so out loud instead of letting an
 * unsigned installer be mistaken for a release.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE = join(HERE, "..", "release");
const REQUIRED = process.env.DECKASTRA_RELEASE === "1";

/** What a release actually ships, as opposed to build scratch. */
const SHIPPED = new Set([".exe", ".dmg", ".zip", ".pkg", ".appx", ".msi"]);

function artifacts() {
  if (!existsSync(RELEASE)) return [];
  return readdirSync(RELEASE)
    .filter((name) => SHIPPED.has(extname(name).toLowerCase()))
    .map((name) => join(RELEASE, name))
    .filter((path) => statSync(path).isFile());
}

function run(command, args) {
  try {
    return { ok: true, out: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return {
      ok: false,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || String(error.message ?? error),
    };
  }
}

/**
 * Windows: the signature status the loader itself would see.
 *
 * `NotSigned` and `Valid` are the two that matter. `UnknownError` usually means
 * a signature that chains to a certificate this machine does not trust, which is
 * a different problem from having none and is reported as itself rather than
 * folded into "unsigned".
 */
function windowsStatus(path) {
  const probe = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}').Status`,
  ]);
  if (!probe.ok) return { signed: false, detail: `could not be checked: ${probe.out}` };
  const status = probe.out.trim();
  return { signed: status === "Valid", detail: status || "no status reported" };
}

/**
 * macOS: signed *and* accepted.
 *
 * Two questions, because they have different answers. `codesign --verify` says
 * the signature is intact and covers the bundle; `spctl --assess` says Gatekeeper
 * would let a user open it, which is where notarization shows up. A build that
 * passes the first and fails the second is the one that reaches a customer and
 * is refused on launch.
 */
function macStatus(path) {
  const signature = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]);
  if (!signature.ok) return { signed: false, detail: `codesign: ${signature.out.split("\n")[0]}` };

  const gatekeeper = run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", path]);
  return {
    signed: gatekeeper.ok,
    detail: gatekeeper.ok
      ? "codesign valid, accepted by Gatekeeper"
      : `signed, but Gatekeeper refuses it (usually not notarized): ${gatekeeper.out.split("\n")[0]}`,
  };
}

function main() {
  const files = artifacts();

  if (files.length === 0) {
    // Not a pass. Checking nothing and reporting success is how a gate comes to
    // be believed about something it never looked at.
    console.error(`No release artifact under ${RELEASE}. Build one first: npm run package`);
    process.exitCode = 1;
    return;
  }

  const check =
    process.platform === "win32" ? windowsStatus : process.platform === "darwin" ? macStatus : undefined;

  if (!check) {
    console.log(
      `[signing] ${process.platform} has no artifact signing in this product; nothing to check.`,
    );
    return;
  }

  let unsigned = 0;
  for (const path of files) {
    const { signed, detail } = check(path);
    if (!signed) unsigned += 1;
    console.log(`[signing] ${signed ? "signed  " : "UNSIGNED"}  ${path.slice(RELEASE.length + 1)} — ${detail}`);
  }

  if (unsigned === 0) return;

  const summary = `${unsigned} of ${files.length} artifact(s) are not signed and accepted.`;
  if (REQUIRED) {
    console.error(`[signing] ${summary} Refusing to call this a release.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[signing] ${summary} That is expected without credentials — set CSC_LINK (and, on macOS, ` +
      "APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID plus --config.mac.notarize=true) to sign. " +
      "DECKASTRA_RELEASE=1 makes this a failure.",
  );
}

main();
