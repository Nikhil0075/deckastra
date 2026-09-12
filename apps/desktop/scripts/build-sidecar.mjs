import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package the workspace service as a self-contained binary (milestone D1.4).
 *
 * The point is what a user does *not* need: no Python, no pip, no virtualenv, no
 * `PYTHONPATH`. A development run happily shells out to the repository's
 * interpreter; an installed app has none, and asking someone to install one
 * before they can open a deck is not a product.
 *
 * `onedir` rather than `onefile`. A one-file build unpacks itself into a temp
 * directory on every launch, which costs seconds on the exact operation the D0
 * gate measures — and leaves the app's own code somewhere a user did not choose.
 *
 * What has to be told to PyInstaller, and why static analysis cannot find it:
 *
 * - **Alembic's migrations are data**, loaded by path at runtime. Nothing imports
 *   them, so nothing bundles them, and the first launch would fail on a database
 *   with no schema.
 * - **The generated JSON Schema** is read from disk by `schema.py` for the same
 *   reason: it is the artifact the whole product validates against, and it is not
 *   an import.
 * - **SQLAlchemy dialects, uvicorn's protocol implementations and the LangGraph
 *   savers** are all resolved by name at runtime.
 *
 * Deliberately *excluded*: `psycopg`, `boto3` and the Postgres saver. A local
 * install has SQLite and a directory; shipping the cloud's drivers would add tens
 * of megabytes to serve a configuration this binary cannot be in.
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktop = dirname(here);
const root = dirname(dirname(desktop));

const api = join(root, "apps", "api");
const out = join(desktop, "dist", "sidecar");
const work = join(desktop, "dist", ".pyinstaller");

const sep = process.platform === "win32" ? ";" : ":";
const data = [
  // Migrations and their config: read by path, never imported.
  [join(root, "infrastructure", "database", "migrations"), "infrastructure/database/migrations"],
  [join(root, "infrastructure", "database", "alembic.ini"), "infrastructure/database"],
  // The generated schema artifact the API validates every document against.
  [join(root, "packages", "presentation-schema", "generated"), "packages/presentation-schema/generated"],
  // Prompts the agent system loads as files.
  [join(root, "agents", "deckastra_agents", "prompts"), "deckastra_agents/prompts"],
];

const hidden = [
  "uvicorn.logging",
  "uvicorn.loops.auto",
  "uvicorn.protocols.http.auto",
  "uvicorn.protocols.websockets.auto",
  "uvicorn.lifespan.on",
  "sqlalchemy.dialects.sqlite",
  "langgraph.checkpoint.sqlite",
  "aiosqlite",
  "alembic.ddl.sqlite",
];

const excluded = [
  // The cloud's engine and object store. This binary can only ever be SQLite and
  // a local directory, so these are tens of megabytes serving nothing.
  "psycopg",
  "psycopg_binary",
  "boto3",
  "botocore",
  "langgraph.checkpoint.postgres",
  // Test and notebook machinery that arrives transitively.
  "pytest",
  "IPython",
  "tkinter",
  "matplotlib",
  // The numeric stack, which nothing in this product uses.
  //
  // PyInstaller follows imports it *finds*, not imports that will run, and an
  // optional branch inside a dependency is enough to drag in the whole of JAX.
  // Left alone these were 330MB of a 480MB build — most of the installer, for
  // code no request can reach. If a real dependency on one ever appears, it will
  // announce itself as an ImportError at startup rather than silently bloating.
  "jax",
  "jaxlib",
  "tensorstore",
  "scipy",
  "pandas",
  "grpc",
  "grpcio",
];

rmSync(out, { recursive: true, force: true });

const args = [
  "-m", "PyInstaller",
  // A launcher that imports the package, not a module run as `__main__`:
  // PyInstaller does the latter, and every relative import inside the package
  // then fails with "no known parent package".
  join(api, "deckastra_service.py"),
  "--name", "deckastra-service",
  "--onedir",
  "--noconfirm",
  "--clean",
  "--distpath", out,
  "--workpath", work,
  "--specpath", work,
  // `--console`: this is a child process whose stdout is the handshake. A
  // windowed build has no stdout, and the supervisor would wait for a ready line
  // that can never arrive.
  "--console",
  // Three source roots, because the product is three top-level packages by
  // design: the API must not import agent internals, and neither knows about
  // `integrations`. PyInstaller has to be told about each.
  "--paths", api,
  "--paths", join(root, "agents"),
  "--paths", join(root, "integrations"),
  ...data.flatMap(([from, to]) => (existsSync(from) ? ["--add-data", `${from}${sep}${to}`] : [])),
  ...hidden.flatMap((name) => ["--hidden-import", name]),
  ...excluded.flatMap((name) => ["--exclude-module", name]),
];

console.log("building the workspace service…");
const finished = spawnSync(process.env.DECKASTRA_PYTHON || "python", args, {
  cwd: root,
  stdio: "inherit",
});

if (finished.status !== 0) {
  console.error("PyInstaller failed.");
  process.exit(finished.status ?? 1);
}

console.log(`workspace service built into ${out}`);
