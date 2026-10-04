import { describe, expect, it } from "vitest";

import { insertPause } from "../src/lib/pause-insert";

describe("the Pause button", () => {
  it("puts the pause between words, never inside one", () => {
    expect(insertPause("Three steps make this work.", 19)).toEqual({ text: "Three steps make this [pause] work.", caret: 29 });
  });

  it("adds the spaces it needs and no more", () => {
    expect(insertPause("One deck.", 9).text).toBe("One deck. [pause]");
    expect(insertPause("One deck.", 0).text).toBe("[pause] One deck.");
    expect(insertPause("One deck. Two.", 10).text).toBe("One deck. [pause] Two.");
  });

  it("replaces a selection", () => {
    expect(insertPause("One — deck.", 4, 5).text).toBe("One [pause] deck.");
  });

  it("keeps a Devanagari vowel sign with its letter", () => {
    // Caret between क and the sign ि of "कि": the pause goes after the word.
    expect(insertPause("एक कित", 4).text).toBe("एक कित [pause]");
  });
});
