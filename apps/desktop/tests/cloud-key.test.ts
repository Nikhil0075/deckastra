import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The user's cloud API key (final package review, item 23).
 *
 * `safeStorage` is the operating system's, so it is stood in for here — what
 * these check is ours: that nothing is stored in the clear, that what the page
 * can ask for never includes the key, and that a key is checked before it
 * becomes a child process's environment.
 */

const profile = mkdtempSync(join(tmpdir(), "deckastra-key-"));
let available = true;

vi.mock("electron", () => ({
  app: { getPath: () => profile },
  safeStorage: {
    isEncryptionAvailable: () => available,
    // A stand-in that is obviously not plaintext, so a test can tell the
    // difference between "encrypted" and "written as it was typed".
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^sealed:/, ""),
  },
}));

const { checkKey, cloudKeyState, readCloudKey, setCloudKey } = await import("../src/main/cloud-key");

beforeEach(async () => {
  available = true;
  await setCloudKey(null);
});

describe("storing a key", () => {
  it("keeps it for this account only, never in the clear", async () => {
    await setCloudKey("sk-ant-api03-averylongtestkeyvalue");
    const onDisk = readFileSync(join(profile, "cloud-key.json"), "utf8");
    expect(onDisk).not.toContain("sk-ant-api03-averylongtestkeyvalue");
    expect(await readCloudKey()).toBe("sk-ant-api03-averylongtestkeyvalue");
  });

  it("tells the page whether a key is set, and nothing more", async () => {
    await setCloudKey("sk-ant-api03-averylongtestkeyvalue");
    const state = await cloudKeyState();
    expect(state).toEqual({ set: true, updatedAt: expect.any(String), storable: true });
    expect(JSON.stringify(state)).not.toContain("sk-ant");
  });

  it("removes it on request", async () => {
    await setCloudKey("sk-ant-api03-averylongtestkeyvalue");
    expect((await setCloudKey(null)).set).toBe(false);
    expect(await readCloudKey()).toBeNull();
  });

  it("refuses to store anything where the operating system cannot protect it", async () => {
    available = false;
    await expect(setCloudKey("sk-ant-api03-averylongtestkeyvalue")).rejects.toThrow("cannot store a key securely");
    expect(await readCloudKey()).toBeNull();
    expect((await cloudKeyState()).storable).toBe(false);
  });

  it("does not hand a decryption failure to the caller as a crash", async () => {
    await setCloudKey("sk-ant-api03-averylongtestkeyvalue");
    // A profile copied from another machine decrypts to nothing here.
    const { safeStorage } = await import("electron");
    vi.spyOn(safeStorage, "decryptString").mockImplementation(() => {
      throw new Error("wrong account");
    });
    expect(await readCloudKey()).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("checking a key before it becomes an environment variable", () => {
  it("accepts a key and trims it", () => {
    expect(checkKey("  sk-ant-api03-averylongtestkeyvalue  ")).toBe("sk-ant-api03-averylongtestkeyvalue");
  });

  it.each([
    ["too short", "sk-ant-short"],
    ["a line break", "sk-ant-api03-averylongtestkey\nvalue"],
    ["a space", "sk-ant-api03 averylongtestkeyvalue"],
    ["a null", "sk-ant-api03-averylongtest\0keyvalue"],
  ])("refuses %s", (_name, key) => {
    expect(() => checkKey(key)).toThrow();
  });
});
