import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The web app's test runner.
 *
 * What is left here is thin on purpose: the editor's own behaviour is tested in
 * `packages/editor-ui`, which is where it lives. These suites cover what only
 * this app has — its routes, and what they do with the answers they get.
 *
 * jsdom rather than a real browser. Anything that genuinely needs one is either
 * an `.e2e.test.ts` here (excluded from `npm test`, opt-in with `E2E=1`) or the
 * pixel-regression suite in `packages/renderer`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    globals: false,
  },
});
