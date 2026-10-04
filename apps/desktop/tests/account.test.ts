import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "." }, safeStorage: {}, shell: {} }));
const { pkce, validState, tokenExpiry } = await import("../src/main/account");

describe("browser account sign-in boundary", () => {
  it("rejects invalid token lifetimes", () => {
    for (const value of [undefined, "NaN", "", 0, -1, 86401, Infinity]) expect(() => tokenExpiry(value)).toThrow();
    expect(tokenExpiry("3600")).toBeGreaterThan(Date.now());
  });
  it("uses the RFC 7636 S256 challenge", () => {
    expect(pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("rejects missing, changed and non-ASCII callback state", () => {
    expect(validState("fixed-state", "fixed-state")).toBe(true);
    expect(validState(null, "fixed-state")).toBe(false);
    expect(validState("wrong-state", "fixed-state")).toBe(false);
    expect(validState("é", "a")).toBe(false);
  });
});
