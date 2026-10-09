import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountMenu, initials } from "../src/components/shell/AccountMenu";
import { THEME_KEY, resetChromeThemeForTests, resolveTheme } from "../src/lib/chrome-theme";

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
    render(<AccountMenu />);
    expect(rootTheme()).toBe("light");

    // The operating system goes dark.
    dark = true;
    act(() => changeListeners.forEach((listener) => listener()));
    expect(rootTheme()).toBe("dark");

    // The person picks Light: stored for them, and the system no longer decides.
    fireEvent.click(screen.getByTestId("account-menu"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(rootTheme()).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    act(() => changeListeners.forEach((listener) => listener()));
    expect(rootTheme()).toBe("light");

    // "Match the system" forgets the choice.
    fireEvent.click(screen.getByTestId("account-menu"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Match the system" }));
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(rootTheme()).toBe("dark");
  });

  it("says which choice is current, as radios a screen reader can read", () => {
    localStorage.setItem(THEME_KEY, "dark");
    render(<AccountMenu />);
    expect(rootTheme()).toBe("dark");
    fireEvent.click(screen.getByTestId("account-menu"));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([
      ["Match the system", "false"],
      ["Light", "false"],
      ["Dark", "true"],
    ]);
  });

  it("follows a choice made in another window", () => {
    render(<AccountMenu />);
    expect(rootTheme()).toBe("light");
    localStorage.setItem(THEME_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    });
    expect(rootTheme()).toBe("dark");
  });

  it("is the account menu too: initials, Settings and signing out where the host offers them", () => {
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
    fireEvent.click(screen.getByRole("menuitem", { name: /Settings/ }));
    expect(settings).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("account-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/ }));
    expect(signOut).toHaveBeenCalled();
  });
});
