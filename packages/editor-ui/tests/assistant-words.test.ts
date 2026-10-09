import { describe, expect, it } from "vitest";

import { plain, serviceWords } from "../src/lib/assistant-words";

describe("service-facing words", () => {
  it("replaces engineering details and environment keys", () => {
    expect(plain("Configure DECKASTRA_VERTEX_PROJECT and DECKASTRA_VERTEX_LOCATION")).toBe("Not set up yet.");
    expect(plain("Model tasks require representative qualification")).toBe("Not set up yet.");
    expect(plain("Install the Gemma pack")).toBe("Not set up yet.");
    expect(plain("Select a slide with pictures first.")).toBe("Select a slide with pictures first.");
    expect(plain("the slide_count is fine")).toBe("the slide_count is fine");
    expect(plain(null)).toBeNull();
  });

  it("uses the surface-specific fallback when a service sentence is internal", () => {
    expect(serviceWords("Vertex credential missing", "Translation is not set up yet.")).toBe("Translation is not set up yet.");
    expect(serviceWords("Try again later.", "Translation is not set up yet.")).toBe("Try again later.");
  });
});
