import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Installing the next version over this one (final package review, item 16).
 *
 * This release has **no updater**, by decision: upgrades are manual, and the
 * policy is only worth having if what survives the swap is written down and
 * checked. `docs/UPGRADING.md` is the written-down half. This is the checked
 * half, and it runs against the one thing a manual upgrade actually changes —
 * a new binary reading the profile the old one left behind.
 *
 * Installing the real installers twice is item 26, and it is the user's run;
 * what this can do without one is drive the same profile across a version
 * change and assert the three rules the register names: the data is kept, the
 * settings are kept, and the agent consent is not.
 */

const profile = mkdtempSync(join(tmpdir(), "deckastra-upgrade-"));
let version = "0.9.0-beta.1";

vi.mock("electron", () => ({
  app: { getPath: () => profile, getVersion: () => version },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^sealed:/, ""),
  },
}));

const { readAgentAccess, setAgentAccess } = await import("../src/main/agent-access");
const { cloudKeyState, readCloudKey, setCloudKey } = await import("../src/main/cloud-key");

/** The profile as version N leaves it: agents allowed, a key stored, a deck open. */
async function installAndUse(): Promise<void> {
  version = "0.9.0-beta.1";
  await setAgentAccess(true);
  await setCloudKey("sk-ant-api03-averylongtestkeyvalue");
  writeFileSync(join(profile, "workspace.json"), JSON.stringify({ presentationId: "doc_kept" }), "utf8");
}

/** The next version, reading the same profile. */
function upgrade(to = "0.9.0-beta.2"): void {
  version = to;
}

beforeEach(async () => {
  version = "0.9.0-beta.1";
  await setCloudKey(null);
  await setAgentAccess(false);
});

describe("installing the next version over this one", () => {
  it("keeps the key the person stored", async () => {
    // A setting someone entered is not a thing to make them enter again. The
    // key is sealed to this account by the operating system, and an upgrade
    // does not change the account.
    await installAndUse();
    upgrade();

    expect((await cloudKeyState()).set).toBe(true);
    expect(await readCloudKey()).toBe("sk-ant-api03-averylongtestkeyvalue");
  });

  it("keeps the deck that was open", async () => {
    await installAndUse();
    upgrade();

    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(profile, "workspace.json"), "utf8"))).toEqual({
      presentationId: "doc_kept",
    });
  });

  it("does not keep the agent consent", async () => {
    // The opposite rule to the two above, and deliberately so. Consent was
    // given to a particular build to let something else on this machine reach
    // these decks; a new build is a new thing to decide about, and a permission
    // that survives every upgrade is one nobody ever revisits.
    await installAndUse();
    expect((await readAgentAccess()).allowed).toBe(true);

    upgrade();

    const after = await readAgentAccess();
    expect(after.allowed).toBe(false);
    expect(after.expiresAt).toBeNull();
    // What is kept is *when they last decided*, because the window says so.
    expect(after.decidedAt).not.toBeNull();
  });

  it("does not take the same version as an upgrade", async () => {
    // Otherwise every launch would revoke the consent given on the last one.
    await installAndUse();
    upgrade("0.9.0-beta.1");

    expect((await readAgentAccess()).allowed).toBe(true);
  });

  it("treats going back to an older version as a change too", async () => {
    // Someone reinstalling the version they still have the installer for is a
    // real case with manual upgrades, and it is not more trustworthy for being
    // older.
    await installAndUse();
    upgrade("0.9.0-alpha.9");

    expect((await readAgentAccess()).allowed).toBe(false);
  });
});
