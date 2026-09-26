import { describe, expect, it } from "vitest";

import { isDeckListCommand, modeForCommand, themeForCommand } from "../src/lib/host-commands";

describe("host commands", () => {
  it("map the menu's names onto editor state, and nothing else onto it", () => {
    expect(modeForCommand("mode-code")).toBe("code");
    expect(modeForCommand("undo")).toBeNull();
    expect(themeForCommand("theme-system")).toBe("system");
    expect(themeForCommand("theme-dark")).toBe("dark");
    expect(themeForCommand("present")).toBeNull();
  });

  it("send only New deck and Generate on to the deck list", () => {
    expect(isDeckListCommand("new-deck")).toBe(true);
    expect(isDeckListCommand("generate-deck")).toBe(true);
    expect(isDeckListCommand("all-decks")).toBe(false);
  });
});
