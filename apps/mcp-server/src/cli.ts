#!/usr/bin/env node
import { main } from "./index";

/**
 * The stdio entry point.
 *
 * Separate from `index.ts` so importing the server does not start one. The tests
 * build the tool surface in-process against a stubbed service, and a module that
 * connected a transport on import could not be tested that way.
 */
main().catch((error: unknown) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error) + "\n");
  process.exit(1);
});
