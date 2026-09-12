import { defineConfig } from "vitest/config";

/**
 * The shell's own tests.
 *
 * They cover the two things that are genuinely this package's: the local
 * workspace client's persistence contract, and the presenter handle. The editor
 * itself is tested in `packages/editor-ui`; running it again here would only
 * prove the import works.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    globals: false,
  },
});
