import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { recordBundledPackages } from "./bundled-packages.mjs";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";

/**
 * Build all three processes.
 *
 * Three bundles because Electron runs three different things under three
 * different sets of rules, and pretending otherwise is how a Node builtin ends up
 * in a renderer:
 *
 * - **main** — Node with `electron` available. ESM, because it uses
 *   `import.meta.dirname` to find its own files.
 * - **preload** — CommonJS, and it has to be. With `sandbox: true` a preload
 *   script runs in a restricted context that has no ESM loader; an `.mjs` preload
 *   silently fails to load and the bridge is simply absent at runtime.
 * - **renderer** — the browser. Vite, and no Node builtins reachable at all.
 * - **worker** — the exporter, which the service shells out to. Bundled here
 *   because a packaged app has no `npx`, no `node_modules` and no TypeScript;
 *   Electron's own binary runs it in Node mode, so no second runtime ships.
 *
 * Everything except `electron` is bundled in. A packaged app should not depend on
 * `node_modules` being present, and the workspace packages ship TypeScript source
 * that nothing would compile at install time anyway.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist");

// Only what this script produces. `dist/` also holds the packaged workspace
// service, which takes minutes to build and is produced by `build:sidecar` —
// clearing the whole directory silently deleted it, and the next launch failed
// with a spawn error naming a binary that had been there ten seconds earlier.
await rm(join(out, "main"), { recursive: true, force: true });
await rm(join(out, "worker"), { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  // Provided by the runtime, not by us. Bundling it would produce a second copy
  // of Electron's own module and none of the APIs would be wired up.
  external: ["electron"],
  logLevel: "info",
};

const main = await esbuild({
  ...shared,
  entryPoints: [join(root, "src/main/index.ts")],
  outfile: join(out, "main/index.js"),
  format: "esm",
  metafile: true,
  // The fixture is inlined at build time rather than read from disk at runtime:
  // a path into `node_modules` does not survive packaging.
  loader: { ".json": "json" },
});

const preload = await esbuild({
  ...shared,
  entryPoints: [join(root, "src/preload/index.ts")],
  outfile: join(out, "main/preload.cjs"),
  format: "cjs",
  metafile: true,
});

const worker = await esbuild({
  ...shared,
  entryPoints: [join(root, "..", "worker", "src", "cli.ts")],
  // Read below, to refuse a bundle that cannot load where it is installed.
  metafile: true,
  // `.mjs`, not `.js`. The bundle is ESM, and Node decides module kind from the
  // extension or from the nearest `package.json`. In a checkout the desktop
  // package's `"type": "module"` covers it; in the installed app the exporter
  // sits in a resources directory with no package.json at all, and Node parsed
  // the first `import` as a CommonJS syntax error.
  outfile: join(out, "worker/cli.mjs"),
  format: "esm",
  // Playwright is loaded through a dynamic `import()` at render time and reads
  // its own browser installation from disk. Bundling it would inline a package
  // that expects to be a package; it stays external and is resolved at runtime.
  external: [...shared.external, "playwright", "esbuild"],
  // The exporter renders React to markup, so the same JSX transform the rest of
  // the project uses has to reach it.
  jsx: "automatic",
  loader: { ".json": "json" },
  banner: {
    // React and react-dom are CommonJS, and their module bodies call `require`
    // for things esbuild cannot resolve statically. An ESM bundle has no
    // `require`, so esbuild's shim throws at load — the whole exporter fails
    // before it reads a byte of stdin. Handing it a real one is the fix.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

/*
  The MCP server, bundled so an installed app can offer one.

  It used to run only from a checkout, through `tsx` and this repository's
  `node_modules` — so anyone who installed Deckastra without cloning it had no
  agent access at all, which is most people who would have it. Electron's binary
  runs it in Node mode, the same way it runs the exporter, and for the same
  reason: stdio works there and an Electron main process never receives piped
  stdin on Windows.
*/
const mcp = await esbuild({
  ...shared,
  entryPoints: [join(root, "..", "mcp-server", "src", "cli.ts")],
  outfile: join(out, "mcp/cli.mjs"),
  format: "esm",
  metafile: true,
  banner: {
    // The MCP SDK is published as CommonJS in places and reaches for `require`.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

const assistantDesign = await esbuild({
  ...shared,
  entryPoints: [join(root, "..", "..", "scripts", "assistant-design-check.ts")],
  outfile: join(out, "worker/assistant-design-check.cjs"),
  format: "cjs",
});

for (const [label, built] of [
  ["exporter", worker],
  ["MCP server", mcp],
]) {
  const staticExternals = Object.values(built.metafile.outputs)
    .flatMap((output) => output.imports)
    // A Node built-in is always there, prefixed or not ("fs", which fontkit
    // imports, is the same module as "node:fs"); anything else is a package an
    // installed app does not ship.
    .filter((entry) => entry.external && entry.kind === "import-statement" && !entry.path.startsWith("node:") && !builtinModules.includes(entry.path))
    .map((entry) => entry.path);
  if (staticExternals.length > 0) {
    console.error(
      `desktop: the ${label} statically imports ${[...new Set(staticExternals)].join(", ")}, which ` +
        "an installed app does not ship. Import it with a dynamic import() on the path that needs it.",
    );
    process.exit(1);
  }
}

// The DOM measurer, as a script the exporter injects into its render page.
// Built here because a packaged app has neither the TypeScript source nor
// esbuild; `DECKASTRA_MEASURER_JS` points the exporter at the result.
const measurer = await esbuild({
  metafile: true,
  entryPoints: [join(root, "..", "worker", "src", "measurement-browser.ts")],
  outfile: join(out, "worker/measurement-browser.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "DeckastraMeasurement",
  target: "es2022",
  logLevel: "info",
});

// The bundled fonts, for the exporter's render page (`apps/worker/src/fonts.ts`).
// A packaged app has no node_modules, so the stylesheets and their Latin files
// are copied beside the exporter, laid out as the package paths the library
// names; `DECKASTRA_FONTS_DIR` points there. The list is read from the library
// itself rather than restated, so a font added there is shipped here.
const library = await readFile(join(root, "..", "..", "packages", "renderer", "src", "font-library.ts"), "utf8");
// Each entry's stylesheet and the script subsets it embeds (`subsets: [...]`).
const fonts = [...library.matchAll(/css: "([^"]+)"(?:, subsets: \[([^\]]*)\])?/g)].map((match) => ({
  css: match[1],
  subsets: [...(match[2] ?? "").matchAll(/"([^"]+)"/g)].map((subset) => subset[1]),
}));
if (fonts.length === 0) {
  console.error("desktop: no bundled fonts found in font-library.ts");
  process.exit(1);
}
const requireFrom = createRequire(join(root, "..", "..", "apps", "worker", "package.json"));
async function copyStylesheet(css, subsets) {
  const source = requireFrom.resolve(css);
  const target = join(out, "worker", "fonts", css);
  await mkdir(join(dirname(target), "files"), { recursive: true });
  await copyFile(source, target);
  // Latin always, and the script a script face exists for: a packaged Hindi
  // export used to carry no Devanagari file at all, because only Latin was copied.
  const wanted = new RegExp(`-(latin|latin-ext${subsets.map((subset) => `|${subset}`).join("")})-`);
  // Only the files the stylesheet names: a package folder also holds width
  // axes and woff copies nothing here ever loads.
  const named = new Set([...(await readFile(source, "utf8")).matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((match) => match[1]));
  for (const file of named) {
    if (wanted.test(file)) await copyFile(join(dirname(source), "files", file), join(dirname(target), "files", file));
  }
  // The licence travels with the files it covers.
  await copyFile(join(dirname(source), "LICENSE"), join(dirname(target), "LICENSE")).catch(() => undefined);
}
let staticSheets = 0;
for (const { css, subsets } of fonts) {
  await copyStylesheet(css, subsets);
  // The static weights the exporter declares instead (`staticPackage` in
  // apps/worker/src/fonts.ts): a variable face embeds in a PDF as Type3, whose
  // shaped glyphs copy out as U+0000.
  const pkg = css.replace("@fontsource-variable/", "@fontsource/").replace(/\/[^/]+\.css$/, "");
  for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
    try {
      requireFrom.resolve(`${pkg}/${weight}.css`);
    } catch {
      continue;
    }
    await copyStylesheet(`${pkg}/${weight}.css`, subsets);
    staticSheets += 1;
  }
}
const stylesheets = fonts;
// KaTeX's stylesheet and its woff2 faces, for equations (`EQUATION_STYLESHEET`).
{
  const source = requireFrom.resolve("katex/dist/katex.min.css");
  const target = join(out, "worker", "fonts", "katex", "dist");
  await mkdir(join(target, "fonts"), { recursive: true });
  await copyFile(source, join(target, "katex.min.css"));
  for (const file of await readdir(join(dirname(source), "fonts"))) {
    if (file.endsWith(".woff2")) await copyFile(join(dirname(source), "fonts", file), join(target, "fonts", file));
  }
  await copyFile(join(dirname(source), "..", "LICENSE"), join(target, "..", "LICENSE")).catch(() => undefined);
}
console.log(`desktop: ${stylesheets.length} bundled fonts (${staticSheets} static weights) and the equation faces copied for the exporter`);

const renderer = await vite({ root, configFile: join(root, "vite.config.ts") });

// Every third-party package that is actually inside a bundle, read from the
// bundlers' own records — the list the SBOM and the notices are made from, so
// neither describes what was merely installed (register item 33).
const bundled = recordBundledPackages({
  esbuild: { main, preload, exporter: worker, mcp, measurer, assistantDesign },
  vite: renderer,
  cwd: process.cwd(),
  out: join(out, "bundled-packages.json"),
});
console.log(`desktop: ${bundled.length} third-party packages bundled`);

console.log("desktop: main, preload, worker, MCP server and renderer built");
