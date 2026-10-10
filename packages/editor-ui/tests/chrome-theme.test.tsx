import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceSettings } from "../src/components/SettingsShell";
import { AccountMenu, initials } from "../src/components/shell/AccountMenu";
import { THEME_KEY, resetChromeThemeForTests, resolveTheme } from "../src/lib/chrome-theme";

// No service: the account card's credits meter has nothing to read and stays absent.
vi.mock("@deckastra/workspace-client/react", () => ({ useWorkspaceClient: () => ({ session: {} }) }));

/**
 * The chrome's light or dark (editor Phase 8): a per-viewer preference that
 * follows the operating system until the person chooses, written once on the
 * root element where `tokens.css` reads it.
 */

let dark = false;
const changeListeners = new Set<() => void>();

beforeEach(() => {
  dark = false;
  changeListeners.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, listener: () => void) => changeListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => changeListeners.delete(listener),
    })),
  );
  resetChromeThemeForTests();
  delete document.documentElement.dataset.dkTheme;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const rootTheme = () => document.documentElement.dataset.dkTheme;

describe("the chrome theme", () => {
  it("resolves a preference against the system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system until someone chooses, then keeps their choice", () => {
    render(<AppearanceSettings />);
    expect(rootTheme()).toBe("light");

    // The operating system goes dark.
    dark = true;
    act(() => changeListeners.forEach((listener) => listener()));
    expect(rootTheme()).toBe("dark");

    // The person picks Light: stored for them, and the system no longer decides.
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(rootTheme()).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    act(() => changeListeners.forEach((listener) => listener()));
    expect(rootTheme()).toBe("light");

    // "Match the system" forgets the choice.
    fireEvent.click(screen.getByRole("radio", { name: "Match the system" }));
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(rootTheme()).toBe("dark");
  });

  it("says which choice is current, as radios a screen reader can read", () => {
    localStorage.setItem(THEME_KEY, "dark");
    render(<AppearanceSettings />);
    expect(rootTheme()).toBe("dark");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([
      ["Match the system", "false"],
      ["Light", "false"],
      ["Dark", "true"],
    ]);
  });

  it("follows a choice made in another window", () => {
    render(<AppearanceSettings />);
    expect(rootTheme()).toBe("light");
    localStorage.setItem(THEME_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    });
    expect(rootTheme()).toBe("dark");
  });

  it("is chosen in Settings › Appearance; the account menu only links there", () => {
    const settings = vi.fn();
    render(<AccountMenu identity={{ email: "ann@example.com" }} onOpenSettings={settings} />);
    fireEvent.click(screen.getByTestId("account-menu"));
    expect(screen.queryAllByRole("menuitemradio")).toEqual([]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Appearance/ }));
    expect(settings).toHaveBeenCalledWith("appearance");
  });
});

describe("the account menu", () => {
  it("opens on who is signed in, then Settings and signing out where the host offers them", () => {
    expect(initials({ name: "Nikhil Ranjan Murmu" })).toBe("NM");
    expect(initials({ email: "ann@example.com" })).toBe("A");
    expect(initials(null)).toBeNull();
    const settings = vi.fn();
    const signOut = vi.fn();
    render(<AccountMenu identity={{ name: "Ann Lee", email: "ann@example.com" }} onOpenSettings={settings} onSignOut={signOut} />);
    const trigger = screen.getByTestId("account-menu");
    expect(trigger.textContent).toBe("AL");
    expect(trigger.getAttribute("aria-label")).toBe("Account: ann@example.com");
    fireEvent.click(trigger);

    // The card is read, never focused, and sits outside the menu role.
    const card = screen.getByTestId("account-card");
    expect(card.textContent).toContain("Ann Lee");
    expect(card.textContent).toContain("ann@example.com");
    expect(card.closest('[role="menu"]')).toBeNull();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Settings…", "Appearance…", "Sign out"]);

    fireEvent.click(screen.getByRole("menuitem", { name: /Settings/ }));
    expect(settings).toHaveBeenCalledWith();
    fireEvent.click(screen.getByTestId("account-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/ }));
    expect(signOut).toHaveBeenCalled();
  });

  it("says when nobody is signed in rather than showing an empty card", () => {
    render(<AccountMenu onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("account-menu"));
    expect(screen.getByTestId("account-card").textContent).toContain("Not signed in");
    expect(screen.getByTestId("account-menu").getAttribute("aria-label")).toBe("Account");
  });
});
