import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";

/**
 * The workspace service, supervised (milestone D1).
 *
 * The desktop runs the *same* API the cloud does, as a child process on a
 * loopback port. Not a smaller reimplementation: the store, the version chain,
 * the authorization ladder and the agent graph are the parts of this product
 * worth trusting precisely because there is one of each, and a second local
 * implementation would be a second set of bugs in the code that owns people's
 * documents.
 *
 * Three properties of the arrangement:
 *
 * - **The secret is minted here and never leaves this process.** The renderer
 *   reaches the service through a proxy on its own origin (`protocol.ts`), so the
 *   page never learns the port or the token. A compromised page cannot talk to
 *   the service directly, and nothing else on the machine can talk to it at all.
 * - **The ready line is the handshake.** The service prints one JSON object and
 *   then falls silent; anything else on stdout after that is log output. A
 *   chattier protocol means parsing a stream, which is where a partial line
 *   becomes a hang.
 * - **A crash is visible.** The supervisor restarts with backoff and reports the
 *   state, because a blank window with no explanation is the worst thing a
 *   packaged app can do.
 */

export interface SidecarStatus {
  state: "starting" | "ready" | "restarting" | "failed";
  detail?: string;
  attempt: number;
}

export interface Sidecar {
  /** Loopback port the service is listening on. */
  readonly port: number;
  /** The bearer this process injects. Never sent to the renderer. */
  readonly secret: string;
  stop(): Promise<void>;
}

/** How long the service gets to migrate, seed and bind before we give up on it. */
const READY_TIMEOUT_MS = 60_000;

/** Backoff between restarts, capped. A tight restart loop is a busy machine. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

interface Options {
  dataDir: string;
  onStatus: (status: SidecarStatus) => void;
}

/**
 * Where the service lives.
 *
 * A packaged app ships a self-contained binary next to its resources; a
 * development run uses the repository's Python. `DECKASTRA_SIDECAR` overrides
 * both, which is how the acceptance harness points at a build under test.
 */
/**
 * Tell the service how to run the exporter.
 *
 * A packaged app has no `npx`, no `node_modules` and no TypeScript, so the
 * service cannot shell out to the source the way a checkout does. It gets a
 * bundled JavaScript entry point and a runtime to run it — Electron's own binary,
 * which `export_service` starts with `ELECTRON_RUN_AS_NODE=1`. Nothing extra
 * ships, and there is one Node on the machine rather than two.
 */
function exporterEnvironment(): NodeJS.ProcessEnv {
  // Outside the asar when packaged. `ELECTRON_RUN_AS_NODE` runs a plain Node,
  // which has no asar support — a path into the archive simply does not exist to
  // it, and the export stalls with the job stuck on "rendering".
  const worker = app.isPackaged
    ? join(process.resourcesPath, "worker")
    : join(import.meta.dirname, "..", "worker");

  return {
    DECKASTRA_WORKER_CMD: join(worker, "cli.mjs"),
    DECKASTRA_WORKER_NODE: process.execPath,
    // Built alongside the exporter, because the packaged app has neither the
    // measurer's TypeScript source nor esbuild to compile it with.
    DECKASTRA_MEASURER_JS: join(worker, "measurement-browser.js"),
    // Render with this app's own Chromium instead of Playwright's, which a
    // packaged build does not carry. The exporter starts this same binary in
    // render-host mode (`render-host.ts`) and drives it over IPC — no debugging
    // port, nothing for anything else on the machine to find. A packaged binary
    // always runs its own bundle, so it takes no arguments; a development run
    // has to be told which app directory to load.
    DECKASTRA_RENDER_BACKEND: "electron",
    DECKASTRA_RENDER_ELECTRON: process.execPath,
    DECKASTRA_RENDER_ELECTRON_ARGS: JSON.stringify(app.isPackaged ? [] : [app.getAppPath()]),
  };
}

function command(dataDir: string): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const override = process.env.DECKASTRA_SIDECAR;
  const packaged = join(process.resourcesPath ?? "", "sidecar", process.platform === "win32" ? "deckastra-service.exe" : "deckastra-service");

  const binary = override || (app.isPackaged ? packaged : "");
  if (binary) {
    return {
      file: binary,
      args: ["--data-dir", dataDir],
      // The binary's own directory, not the data directory. On Windows `spawn`
      // reports a missing *cwd* as ENOENT against the executable's path, which
      // reads as "the service is not installed" — and the data directory does not
      // exist yet on a first launch, because the service is what creates it.
      cwd: dirname(binary),
      env: { ...process.env, ...exporterEnvironment() },
    };
  }

  // Development: the repository's own Python, four levels up from `dist/main`.
  const root = resolve(app.getAppPath(), "..", "..");
  const apiDir = join(root, "apps", "api");
  if (!existsSync(apiDir)) {
    throw new Error(
      `No packaged service and no repository at ${apiDir}. Set DECKASTRA_SIDECAR to a service binary.`,
    );
  }
  return {
    file: process.env.DECKASTRA_PYTHON || "python",
    args: ["-m", "deckastra_api.local_server", "--data-dir", dataDir],
    cwd: root,
    // Prepended rather than replaced: a developer's own PYTHONPATH is not ours
    // to discard, and `agents/` is resolved by the API's own path bootstrap.
    env: {
      ...process.env,
      ...exporterEnvironment(),
      PYTHONPATH: [apiDir, process.env.PYTHONPATH].filter(Boolean).join(";"),
    },
  };
}

export async function startSidecar(options: Options): Promise<Sidecar> {
  // 256 bits, per launch. Not derived from anything on disk: a secret that
  // survives a restart is a secret that can be read from disk by anything
  // running as this user.
  const secret = randomBytes(32).toString("base64url");

  let child: ChildProcess | undefined;
  let stopping = false;
  let attempt = 0;
  let port = 0;

  async function launch(): Promise<number> {
    const { file, args, cwd, env } = command(options.dataDir);
    options.onStatus({ state: attempt === 0 ? "starting" : "restarting", attempt });

    const spawned = spawn(file, args, {
      cwd,
      env: { ...env, DECKASTRA_LOCAL_SECRET: secret },
      stdio: ["ignore", "pipe", "pipe"],
      // Never a shell. The arguments include a path from the environment, and a
      // shell would give that path a chance to be a command.
      shell: false,
    });
    child = spawned;

    spawned.stderr?.on("data", (chunk: Buffer) => {
      // The service's own logs. Kept on our stderr so a packaged run still has
      // somewhere to look when something fails.
      process.stderr.write(chunk);
    });

    const ready = await readReadyLine(spawned);
    // The socket is listening by the time the line is printed, so a request now
    // queues rather than being refused — but "listening" is not "serving", and a
    // window that renders before the first route answers shows a failure the app
    // already knew was coming. One health check makes `ready` mean answering.
    await waitForHealth(ready, secret);

    spawned.on("exit", (code, signal) => {
      if (stopping) return;
      attempt += 1;
      const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
      options.onStatus({
        state: "restarting",
        detail: `The workspace service stopped (${signal ?? code}). Restarting…`,
        attempt,
      });
      setTimeout(() => {
        if (stopping) return;
        launch().catch((error: unknown) => {
          options.onStatus({
            state: "failed",
            detail: error instanceof Error ? error.message : String(error),
            attempt,
          });
        });
      }, delay);
    });

    port = ready;
    options.onStatus({ state: "ready", attempt });
    return ready;
  }

  port = await launch();

  return {
    get port() {
      return port;
    },
    secret,
    async stop() {
      stopping = true;
      const running = child;
      if (!running || running.exitCode !== null) return;

      // Ask, then insist. A service killed mid-commit is the case the store's
      // savepoint exists for, but giving it a moment to finish is cheaper than
      // relying on that.
      running.kill();
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          running.kill("SIGKILL");
          done();
        }, 3_000);
        running.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };
}

/** Poll `/health` until the service answers, or give up and say which it was. */
async function waitForHealth(port: number, secret: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`The workspace service bound a port but never answered (${lastError}).`);
}

/** Read stdout until the service announces its port, then stop consuming it. */
function readReadyLine(spawned: ChildProcess): Promise<number> {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      spawned.kill();
      rejectReady(new Error("The workspace service did not start within a minute."));
    }, READY_TIMEOUT_MS);

    const finish = (error: Error | null, value?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spawned.stdout?.off("data", onData);
      if (error) rejectReady(error);
      else resolveReady(value!);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const line = buffer.slice(0, newline).trim();
      try {
        const announced = JSON.parse(line) as { ready?: boolean; port?: number };
        if (!announced.ready || typeof announced.port !== "number") {
          throw new Error("no port");
        }
        finish(null, announced.port);
      } catch {
        finish(new Error(`The workspace service announced something unreadable: ${line.slice(0, 200)}`));
      }
    };

    spawned.stdout?.on("data", onData);
    spawned.once("error", (error) => finish(error));
    spawned.once("exit", (code) =>
      finish(new Error(`The workspace service exited before it was ready (code ${code}).`)),
    );
  });
}
