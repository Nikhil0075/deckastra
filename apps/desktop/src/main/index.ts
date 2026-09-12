import { isRenderHost } from "./render-host";

/**
 * Which process this is.
 *
 * The same binary starts in two roles. Ordinarily it is the app: windows, the
 * workspace service, the single-instance lock. With `DECKASTRA_RENDER_HOST=1` it
 * is the exporter's browser (`render-host.ts`), started by the exporter and
 * driven over IPC — because an installed Electron app ignores a script path on
 * its command line and always runs this bundle, so a flag is the only way to ask
 * it to be something else.
 *
 * Both roles are loaded with `import()` so that only one of them runs. A static
 * import of `app.ts` would execute its top level — including the single-instance
 * lock — in the render host too, and the host would then find the user's running
 * app holding the lock and quit before rendering anything.
 */
if (isRenderHost()) {
  void import("./render-host").then(({ runRenderHost }) => runRenderHost());
} else {
  void import("./app");
}
