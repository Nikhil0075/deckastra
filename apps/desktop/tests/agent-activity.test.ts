import { describe, expect, it } from "vitest";

import { activityWords } from "../src/renderer/AgentAccessControl";

describe("the agent chip's activity line", () => {
  const now = 1_800_000_000_000;
  it("says nobody has connected until an agent uses its grant", () => {
    expect(activityWords(null, now)).toMatchObject({ active: false });
  });
  it("says connected within two minutes, then when", () => {
    expect(activityWords(now / 1000 - 30, now)).toEqual({ active: true, words: "An agent is connected and working now." });
    expect(activityWords(now / 1000 - 600, now).words).toBe("An agent last connected 10 minutes ago.");
    expect(activityWords(now / 1000 - 3 * 3600, now).words).toBe("An agent last connected 3 hours ago.");
  });
});
