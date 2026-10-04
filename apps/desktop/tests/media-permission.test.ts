import { describe, expect, it } from "vitest";

import { allowsMedia } from "../src/main/media-permission";

const ORIGIN = "deckastra://app";
const base = { permission: "media", mediaTypes: ["audio"], requestingUrl: `${ORIGIN}/index.html`, isMainFrame: true, fromEditorWindow: true };

describe("the microphone, for narration only (integration plan 01 §3.5)", () => {
  it("is granted to an editor window's main frame on our origin, for audio", () => {
    expect(allowsMedia(base, ORIGIN)).toBe(true);
  });
  it("is refused to a presenter window, a sub-frame, another origin, and the camera", () => {
    expect(allowsMedia({ ...base, fromEditorWindow: false }, ORIGIN)).toBe(false);
    expect(allowsMedia({ ...base, isMainFrame: false }, ORIGIN)).toBe(false);
    expect(allowsMedia({ ...base, requestingUrl: "deckastra://app.evil.example/" }, ORIGIN)).toBe(false);
    expect(allowsMedia({ ...base, requestingUrl: "https://example.com/" }, ORIGIN)).toBe(false);
    expect(allowsMedia({ ...base, mediaTypes: ["audio", "video"] }, ORIGIN)).toBe(false);
    expect(allowsMedia({ ...base, mediaTypes: [] }, ORIGIN)).toBe(false);
  });
  it("still refuses every other permission", () => {
    for (const permission of ["geolocation", "notifications", "clipboard-read", "midi"]) {
      expect(allowsMedia({ ...base, permission }, ORIGIN)).toBe(false);
    }
  });
});
