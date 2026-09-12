import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { buildDocumentScene, documentDigest } from "@deckastra/renderer";

import { App } from "./App";
import "@deckastra/editor-ui/styles.css";

/**
 * Renderer entry.
 *
 * The bridge is read once, here, and passed down. If it is missing the page is
 * not running under the shell — which in practice means someone opened the built
 * HTML directly — and saying so is more useful than a stack trace from the first
 * component that tried to read a deck.
 */
/**
 * The scene builder, reachable from the main process.
 *
 * `executeJavaScript` runs in the page's main world and cannot see module scope,
 * so the D0 rendering-parity gate — does Electron's Chromium build byte-identical
 * scenes to Node? — has no way in without this. Guarded by a query parameter only
 * the main process sets, and only when the acceptance harness is running.
 */
if (new URLSearchParams(window.location.search).get("smoke") === "1") {
  Object.assign(window, { __deckastraScene: { buildDocumentScene, documentDigest } });
}

const bridge = window.deckastra;
const root = createRoot(document.getElementById("root")!);

if (!bridge) {
  root.render(
    <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "#9aa4b2" }}>
      This page has to run inside the Deckastra desktop app.
    </div>,
  );
} else {
  root.render(
    <StrictMode>
      <App bridge={bridge} />
    </StrictMode>,
  );
}
