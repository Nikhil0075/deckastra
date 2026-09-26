import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { parseLock } from "./sbom.mjs";

/**
 * Third-party notices for what actually ships (register item 33).
 *
 * An SBOM lists components; licences such as MIT, BSD and OFL require their
 * *text* to travel with the copy, and that is this file. It is made from the
 * same lists as the SBOM, so the two cannot describe different products:
 *
 * - **JavaScript** — `dist/bundled-packages.json`, the packages the bundlers
 *   read (`build.mjs`). Their licence files are read from the installed package.
 *   The fonts (Inter, Jost, OFL-1.1) arrive this way, as npm packages.
 * - **The workspace service** — every distribution in the lock the service is
 *   frozen from, read from the build's own virtual environment
 *   (`dist/.venv`), plus the CPython licence for the interpreter PyInstaller
 *   embeds. A lock entry the environment does not have is a failure: the lock
 *   and the payload have drifted.
 * - **Electron and Chromium** — electron-builder already places
 *   `LICENSE.electron.txt` and `LICENSES.chromium.html` beside the executable;
 *   this file points to them rather than copying 15 MB of Chromium notices.
 * - **Models** — none ship in this release (local models are excluded), and the
 *   file says so rather than staying silent.
 *
 * A component with neither a licence file nor a declared licence is listed as
 * unresolved; `DECKASTRA_RELEASE=1` makes any unresolved component a failure.
 * Whether a licence *permits* redistribution is a person's decision, recorded
 * in the release checklist — this makes sure the texts are there to decide on.
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktop = dirname(here);
const dist = join(desktop, "dist");

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)(\.|-|$)/i;

function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => ({ file: entry.name, text: readFileSync(join(dir, entry.name), "utf8").trim() }));
}

function npmComponents() {
  const file = join(dist, "bundled-packages.json");
  if (!existsSync(file)) return { components: [], problems: ["dist/bundled-packages.json is missing; run the build first."] };
  const { packages } = JSON.parse(readFileSync(file, "utf8"));
  return {
    components: packages.map((pkg) => ({
      ecosystem: "npm",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      texts: licenseTexts(pkg.dir),
    })),
    problems: [],
  };
}

/**
 * Content copied into this repository's source from a package that is not
 * itself bundled: the extended icon library is Lucide's geometry, generated
 * into `packages/renderer/src/icon-library.ts` by `scripts/build-icon-library.mjs`
 * (design review, 2026-09-27). Its licence (ISC, with MIT for the icons that
 * came from Feather) has to travel with the copy all the same, so it is read
 * from the development dependency the generator used.
 */
const VENDORED = [{ name: "lucide-static", license: "ISC AND MIT", usedFor: "icon library geometry" }];

function vendoredComponents() {
  const components = [];
  const problems = [];
  for (const entry of VENDORED) {
    let dir;
    try {
      dir = dirname(require.resolve(`${entry.name}/package.json`));
    } catch {
      problems.push(`${entry.name} (${entry.usedFor}) is not installed; its licence text cannot be included.`);
      continue;
    }
    const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    components.push({ ecosystem: "vendored", name: entry.name, version, license: entry.license, texts: licenseTexts(dir) });
  }
  return { components, problems };
}

const PYTHON_DUMP = `
import json, sys, importlib.metadata as md, os
out = []
for dist in md.distributions():
    meta = dist.metadata
    name = meta["Name"]
    lic = meta.get("License-Expression") or (meta.get("License") or "").strip().splitlines()[0:1]
    lic = lic[0] if isinstance(lic, list) and lic else (lic if isinstance(lic, str) else "")
    classifiers = [c.split("::")[-1].strip() for c in (meta.get_all("Classifier") or []) if c.startswith("License ::")]
    texts = []
    for f in dist.files or []:
        path = str(f).replace(chr(92), "/")
        base = os.path.basename(path).lower()
        # Licence *files*: named like one, or in a dist-info licences folder.
        # Never code — the \`packaging.licenses\` module is not a licence.
        if base.endswith((".py", ".pyc", ".pyi", ".pyd", ".so", ".dll")):
            continue
        named = base.startswith(("license", "licence", "copying", "notice", "copyright", "authors"))
        if named or (".dist-info/licenses/" in path):
            try:
                with open(f.locate(), encoding="utf-8", errors="replace") as handle:
                    texts.append({"file": str(f).replace(chr(92), "/"), "text": handle.read().strip()})
            except Exception:
                pass
    out.append({"name": name, "version": dist.version, "license": lic or ", ".join(classifiers), "texts": texts})
base = sys.base_prefix
cpython = ""
for candidate in ("LICENSE.txt", "LICENSE"):
    p = os.path.join(base, candidate)
    if os.path.exists(p):
        cpython = open(p, encoding="utf-8", errors="replace").read().strip()
        break
print(json.dumps({"python": sys.version.split()[0], "cpython": cpython, "distributions": out}))
`;

function normal(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function pythonComponents() {
  const problems = [];
  const lockFile = join(desktop, "sidecar-requirements.lock");
  const python = join(dist, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(lockFile)) return { components: [], cpython: null, problems: ["sidecar-requirements.lock is missing."] };
  if (!existsSync(python)) {
    return { components: [], cpython: null, problems: ["The service's build environment (dist/.venv) is missing; run build:sidecar first."] };
  }
  const dump = JSON.parse(execFileSync(python, ["-c", PYTHON_DUMP], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  const installed = new Map(dump.distributions.map((entry) => [normal(entry.name), entry]));
  const components = [];
  for (const entry of parseLock(readFileSync(lockFile, "utf8"))) {
    const found = installed.get(normal(entry.name));
    if (!found) {
      problems.push(`${entry.name}==${entry.version} is in the lock but not in the build environment.`);
      continue;
    }
    if (found.version !== entry.version) {
      problems.push(`${entry.name}: the lock pins ${entry.version}, the build environment has ${found.version}.`);
    }
    components.push({ ecosystem: "pypi", name: found.name, version: found.version, license: found.license || null, texts: found.texts });
  }
  return { components, cpython: { version: dump.python, text: dump.cpython }, problems };
}

export function buildNotices() {
  const npm = npmComponents();
  const py = pythonComponents();
  const vendored = vendoredComponents();
  const components = [...npm.components, ...vendored.components, ...py.components];
  const unresolved = components.filter((c) => c.texts.length === 0 && !c.license).map((c) => `${c.name}@${c.version}`);
  const withoutText = components.filter((c) => c.texts.length === 0 && c.license).map((c) => `${c.name}@${c.version} (${c.license})`);
  const problems = [...npm.problems, ...vendored.problems, ...py.problems];
  if (py.cpython && !py.cpython.text) problems.push("The CPython licence text could not be found for the embedded interpreter.");

  const rule = "=".repeat(78);
  const lines = [
    "Deckastra — third-party notices",
    "",
    "Deckastra includes software written by others. Their licences and notices",
    "follow, grouped by where the software runs. Electron and Chromium's notices",
    "are in LICENSE.electron.txt and LICENSES.chromium.html beside Deckastra.exe.",
    "No machine-learning model is included in this release.",
    "",
  ];
  const section = (title, list) => {
    lines.push(rule, title, rule, "");
    for (const component of list) {
      lines.push(`${component.name} ${component.version}`, `Licence: ${component.license ?? "see below"}`, "");
      if (component.texts.length === 0) {
        lines.push("(The package ships no licence file; its declared licence is stated above.)", "");
      }
      for (const text of component.texts) lines.push(`--- ${text.file} ---`, text.text, "");
      lines.push("-".repeat(78), "");
    }
  };
  section("The editor, exporter and agent server (JavaScript)", npm.components);
  section("Content included in the editor's own code (icon geometry)", vendored.components);
  section("The workspace service (Python)", py.components);
  if (py.cpython) {
    lines.push(rule, `Python ${py.cpython.version} (embedded interpreter)`, rule, "", py.cpython.text, "");
  }

  return {
    text: `${lines.join("\n")}\n`,
    summary: {
      format: 1,
      npm: npm.components.length,
      python: py.components.length,
      components: components.map((c) => ({ ecosystem: c.ecosystem, name: c.name, version: c.version, license: c.license, files: c.texts.map((t) => t.file) })),
      unresolved,
      withoutText,
      problems,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { text, summary } = buildNotices();
  writeFileSync(join(dist, "THIRD_PARTY_NOTICES.txt"), text, "utf8");
  writeFileSync(join(dist, "notices.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(
    `notices: ${summary.npm} npm, ${summary.python} python; ${summary.withoutText.length} declared without a file, ` +
      `${summary.unresolved.length} unresolved, ${summary.problems.length} problem(s)`,
  );
  for (const problem of summary.problems) console.error(`notices: ${problem}`);
  for (const name of summary.unresolved) console.error(`notices: no licence found for ${name}`);
  // A component that ships no licence text needs a person's decision — fetch the
  // text from its source repository into the review file, or accept the declared
  // licence with a reason. Recorded in `notices-review.json`, never assumed.
  const reviewFile = join(desktop, "notices-review.json");
  const reviewed = existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, "utf8")).withoutText ?? {} : {};
  const undecided = summary.withoutText.filter((entry) => !reviewed[entry.split(" (")[0]]);
  for (const entry of undecided) console.error(`notices: ${entry} ships no licence text and has no recorded review decision`);
  if (process.env.DECKASTRA_RELEASE === "1" && (summary.problems.length > 0 || summary.unresolved.length > 0 || undecided.length > 0)) {
    console.error("A release ships a licence for everything it contains. Resolve the components above.");
    process.exit(1);
  }
}
