import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Which third-party packages are inside the built bundles (register item 33).
 *
 * `npm ls` says what is installed, which is not the same thing: a production
 * dependency tree-shaken to nothing ships nothing, and a package reached only
 * through a workspace package's own dependencies ships in full while appearing
 * nowhere in this app's manifest. The bundlers know exactly which files they
 * read, so the list is taken from them — esbuild's metafiles and Vite's output
 * (its modules, and the source files of emitted assets such as fonts).
 *
 * A file belongs to the package whose `package.json` is nearest above it inside
 * a `node_modules` folder. Workspace packages (`@deckastra/*`) are ours and are
 * not third-party.
 */

function packageOf(file, cache) {
  const normal = resolve(file);
  const marker = `${sep}node_modules${sep}`;
  const at = normal.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = normal.slice(at + marker.length).split(sep);
  const depth = rest[0]?.startsWith("@") ? 2 : 1;
  const dir = normal.slice(0, at + marker.length) + rest.slice(0, depth).join(sep);
  if (cache.has(dir)) return cache.get(dir);
  const manifest = join(dir, "package.json");
  let found;
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name && !pkg.name.startsWith("@deckastra/")) {
      found = { name: pkg.name, version: pkg.version ?? "0.0.0", license: licenseField(pkg), dir };
    }
  }
  cache.set(dir, found);
  return found;
}

function licenseField(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return null;
}

export function recordBundledPackages({ esbuild, vite, cwd, out }) {
  const cache = new Map();
  const packages = new Map();
  const add = (file, bundle) => {
    const path = isAbsolute(file) ? file : join(cwd, file);
    const found = packageOf(path.replace(/\?.*$/, "").replace(/^\0/, ""), cache);
    if (!found) return;
    const key = `${found.name}@${found.version}`;
    const entry = packages.get(key) ?? { ...found, bundles: [] };
    if (!entry.bundles.includes(bundle)) entry.bundles.push(bundle);
    packages.set(key, entry);
  };

  for (const [bundle, result] of Object.entries(esbuild)) {
    for (const input of Object.keys(result?.metafile?.inputs ?? {})) add(input, bundle);
  }
  const outputs = [vite].flat().flatMap((result) => result?.output ?? []);
  for (const item of outputs) {
    for (const id of Object.keys(item.modules ?? {})) add(id, "renderer");
    for (const original of item.originalFileNames ?? []) add(original, "renderer");
  }

  const list = [...packages.values()]
    .map((entry) => ({ ...entry, dir: entry.dir.split(sep).join("/") }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
  if (out) {
    const base = dirname(out);
    void base;
    writeFileSync(out, `${JSON.stringify({ format: 1, packages: list }, null, 2)}\n`, "utf8");
  }
  return list;
}
