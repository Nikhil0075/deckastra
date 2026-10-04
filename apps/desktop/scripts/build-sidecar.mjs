import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dataEntries, missingData } from "./sidecar-data.mjs";

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
const data = dataEntries(root);

// Every one of them is required: a service binary built without one fails on a
// user's machine rather than here (item 08, `sidecar-data.mjs`).
const missing = missingData(data);
if (missing.length > 0) {
  console.error("The workspace service cannot be packaged without these:");
  for (const entry of missing) console.error(`  - ${entry}`);
  console.error(
    "Each is read by path at runtime. Run `npm run schema:emit` if the generated schema is what is missing.",
  );
  process.exit(1);
}

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
  // Google credentials (google_credentials.py) import their classes by name at
  // run time: a user's sign-in file and a service account, and the transport
  // that renews them. Static analysis does not see those imports.
  "google.auth.transport.requests",
  "google.oauth2.credentials",
  "google.oauth2.service_account",
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

/**
 * The environment the service is frozen from (final package review, item 09).
 *
 * A clean virtual environment installed from `sidecar-requirements.lock` with
 * `--require-hashes`, so the binary is built from bytes that are written down
 * rather than from whatever a developer's global site-packages happens to hold.
 * Two builders of the same commit then install the same dependencies, and a
 * package that was tampered with in transit fails the install rather than
 * shipping.
 *
 * Reused between builds while the lock is unchanged — a stamp beside it records
 * which lock it was made from, because a venv built from an older lock is
 * exactly the silent mismatch this exists to prevent.
 *
 * `DECKASTRA_SIDECAR_PYTHON=system` skips it for a quick development build. The
 * artifact is then not reproducible, and the script says so rather than leaving
 * that to be assumed.
 */
function frozenPython() {
  if (process.env.DECKASTRA_SIDECAR_PYTHON === "system") {
    console.warn(
      "building from the system Python: this artifact is not reproducible and must not be released " +
        "(unset DECKASTRA_SIDECAR_PYTHON to build from the lock)",
    );
    return process.env.DECKASTRA_PYTHON || "python";
  }

  const lock = join(desktop, "sidecar-requirements.lock");
  if (!existsSync(lock)) {
    console.error(`No dependency lock at ${lock}. Compile it first:`);
    console.error("  python -m piptools compile --generate-hashes --strip-extras --allow-unsafe \\");
    console.error("    --output-file apps/desktop/sidecar-requirements.lock apps/desktop/sidecar-requirements.in");
    process.exit(1);
  }

  const venv = join(desktop, "dist", ".venv");
  const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const stamp = join(venv, "lock.sha256");
  const wanted = createHash("sha256").update(readFileSync(lock)).digest("hex");
  const current = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;

  if (current !== wanted || !existsSync(python)) {
    console.log("installing the service's dependencies from the lock…");
    rmSync(venv, { recursive: true, force: true });
    run(process.env.DECKASTRA_PYTHON || "python", ["-m", "venv", venv]);
    // `--require-hashes` is the point: pip refuses anything whose bytes are not
    // the ones the lock names.
    run(python, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
    run(python, ["-m", "pip", "install", "--quiet", "--require-hashes", "--no-deps", "-r", lock]);
    writeFileSync(stamp, `${wanted}\n`, "utf8");
  }
  return python;
}

function run(file, args) {
  const done = spawnSync(file, args, { cwd: root, stdio: "inherit" });
  if (done.status !== 0) {
    console.error(`${file} ${args.slice(0, 3).join(" ")} … failed (${done.status ?? done.error?.message})`);
    process.exit(1);
  }
}

const python = frozenPython();

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
  ...data.flatMap(([from, to]) => ["--add-data", `${from}${sep}${to}`]),
  ...hidden.flatMap((name) => ["--hidden-import", name]),
  ...excluded.flatMap((name) => ["--exclude-module", name]),
];

console.log("building the workspace service…");
const finished = spawnSync(python, args, {
  cwd: root,
  stdio: "inherit",
});

if (finished.status !== 0) {
  console.error("PyInstaller failed.");
  process.exit(finished.status ?? 1);
}

console.log(`workspace service built into ${out}`);
