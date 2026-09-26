import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What actually ships, listed (final package review, item 09).
 *
 * CycloneDX, because it is the format the notices work (item 33) and any later
 * vulnerability check will expect. Two sources, and neither is a guess:
 *
 * - **Python**, from `sidecar-requirements.lock` — the same file the build
 *   installs from, so the list is what was installed rather than what someone
 *   meant to install, and it carries the hashes pip verified.
 * - **npm**, from the installed tree's production dependencies. The app bundles
 *   its JavaScript, so these are the sources that went into the bundle.
 *
 * It does not claim to be a licence audit: names and versions are facts, and
 * what may be redistributed is a decision a person makes (item 33).
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const root = dirname(dirname(desktop));

/** Every `name==version` with its hashes, as the lock records them. */
export function parseLock(text) {
  const components = [];
  // A requirement runs until the next one: "name==version \" then hash lines.
  const blocks = text.split(/\r?\n(?=[A-Za-z0-9])/);
  for (const block of blocks) {
    const match = /^([A-Za-z0-9._-]+)==([^\s\\]+)/.exec(block);
    if (!match) continue;
    const hashes = [...block.matchAll(/--hash=sha256:([0-9a-f]{64})/g)].map((found) => found[1]);
    components.push({ name: match[1], version: match[2], hashes });
  }
  return components;
}

function pythonComponents() {
  const lock = join(desktop, "sidecar-requirements.lock");
  if (!existsSync(lock)) return [];
  return parseLock(readFileSync(lock, "utf8")).map((entry) => ({
    type: "library",
    name: entry.name,
    version: entry.version,
    purl: `pkg:pypi/${entry.name.toLowerCase()}@${entry.version}`,
    // Every distribution pip was allowed to install for this one: a package
    // publishes a wheel per platform, and the lock pins all of their bytes.
    hashes: entry.hashes.map((hash) => ({ alg: "SHA-256", content: hash })),
    properties: [{ name: "deckastra:source", value: "sidecar-requirements.lock" }],
  }));
}

/**
 * The npm packages inside the bundles, as the bundlers recorded them
 * (`dist/bundled-packages.json`, written by `build.mjs`). Preferred over
 * `npm ls`, which lists what is installed rather than what shipped; the
 * notices are made from the same file, so the two cannot disagree.
 */
function bundledComponents() {
  const file = join(desktop, "dist", "bundled-packages.json");
  if (!existsSync(file)) return null;
  const { packages } = JSON.parse(readFileSync(file, "utf8"));
  return packages.map((pkg) => ({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    purl: `pkg:npm/${pkg.name.replace("@", "%40")}@${pkg.version}`,
    ...(pkg.license ? { licenses: [{ expression: pkg.license }] } : {}),
    properties: [{ name: "deckastra:source", value: `bundled (${pkg.bundles.join(", ")})` }],
  }));
}

function npmComponents() {
  const bundled = bundledComponents();
  if (bundled) return bundled;
  let tree;
  try {
    const json = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
      cwd: desktop,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    tree = JSON.parse(json);
  } catch (error) {
    // `npm ls` exits non-zero for an extraneous or missing package while still
    // printing the tree, so its output is used when there is any.
    const output = error?.stdout;
    if (!output) return [];
    tree = JSON.parse(output);
  }

  const found = new Map();
  const walk = (node) => {
    for (const [name, value] of Object.entries(node?.dependencies ?? {})) {
      if (!value?.version) continue;
      const key = `${name}@${value.version}`;
      if (!found.has(key)) {
        found.set(key, {
          type: "library",
          name,
          version: value.version,
          purl: `pkg:npm/${name.replace("@", "%40")}@${value.version}`,
          properties: [{ name: "deckastra:source", value: "npm (production)" }],
        });
      }
      walk(value);
    }
  };
  walk(tree);
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function buildSbom() {
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  const components = [...pythonComponents(), ...npmComponents()];
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: pkg.productName ?? pkg.name,
        version: pkg.version,
        purl: `pkg:generic/deckastra@${pkg.version}`,
      },
      tools: [{ name: "deckastra sbom.mjs" }],
    },
    components,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sbom = buildSbom();
  const out = join(desktop, "dist", "sbom.json");
  writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  const python = sbom.components.filter((component) => component.purl.startsWith("pkg:pypi/")).length;
  console.log(`sbom: ${sbom.components.length} components (${python} python, ${sbom.components.length - python} npm)`);
  if (python === 0 && process.env.DECKASTRA_RELEASE === "1") {
    console.error("A release SBOM must list the service's dependencies. Compile the lock first.");
    process.exit(1);
  }
  void root;
}
