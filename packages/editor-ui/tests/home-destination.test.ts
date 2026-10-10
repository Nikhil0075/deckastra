import { describe, expect, it } from "vitest";

import { loadDestination, saveDestination } from "../src/lib/home-destination";

const memory = (value: string | null) => ({ getItem: () => value });

describe("the remembered home destination", () => {
  it("restores either destination it saved", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    saveDestination("templates", storage);
    expect(loadDestination(storage)).toBe("templates");
    saveDestination("projects", storage);
    expect(loadDestination(storage)).toBe("projects");
  });

  it("opens on Projects when nothing usable is saved", () => {
    expect(loadDestination(memory(null))).toBe("projects");
    expect(loadDestination(memory("trash"))).toBe("projects");
    expect(loadDestination(memory('"templates"'))).toBe("projects");
    expect(loadDestination(undefined)).toBe("projects");
  });

  it("survives storage that refuses to be read or written", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadDestination(refusing)).toBe("projects");
    expect(() => saveDestination("templates", refusing)).not.toThrow();
  });
});
