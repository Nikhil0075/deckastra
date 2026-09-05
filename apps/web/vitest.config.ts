import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The web app's test runner.
 *
 * jsdom rather than a real browser: what is worth testing here is the *logic*
 * the components carry — index clamping, gesture-to-patch conversion, keyboard
 * routing — not how Chromium paints. Anything that genuinely needs a browser
 * belongs in the pixel-regression suite (`packages/renderer/tests/pixels`),
 * which runs real Chromium and is honest about being slower.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    globals: false,
  },
});
