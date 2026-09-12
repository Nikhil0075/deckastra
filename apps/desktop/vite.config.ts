import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The renderer bundle.
 *
 * `base: "./"` because the page is served from a custom scheme rather than a web
 * root; absolute asset paths would resolve against the scheme's origin and miss.
 *
 * The workspace packages ship TypeScript source with no build step, which Vite
 * handles natively — the same arrangement `transpilePackages` gives the Next app,
 * with one less thing to keep in sync.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/main/renderer",
    emptyOutDir: true,
    // A packaged app is read from disk by one process. Source maps are worth more
    // than the bytes: a stack trace from a user's machine is otherwise unreadable.
    sourcemap: true,
  },
});
