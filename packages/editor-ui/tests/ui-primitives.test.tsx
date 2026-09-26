/**
 * Behaviour of the UI primitives the rewritten chrome is built from.
 *
 * What is asserted is what a keyboard or screen-reader user depends on, and the
 * two editing rules the inspector will lean on: a number field commits once per
 * intent and never a value it refused, and a select does not apply the options
 * someone merely arrowed past.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Button,
  Drawer,
  IconButton,
  Menu,
  NumberField,
  Popover,
  Section,
  Segmented,
  Select,
  StatusChip,
  Tabs,
  TOOLTIP_DELAY_MS,
} from "../src/ui";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Button / IconButton", () => {
  it("defaults to type=button so it never submits a surrounding form", () => {
    const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Apply</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("names an icon button by its label and exposes toggle state only on toggles", () => {
    render(
      <>
        <IconButton icon="rect" label="Rectangle" pressed={true} />
        <IconButton icon="undo" label="Undo" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Rectangle" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("aria-pressed")).toBe(false);
  });

  it("shows its tooltip after the hover delay and describes the button with it", () => {
    vi.useFakeTimers();
    render(<IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" />);
    const button = screen.getByRole("button", { name: "Undo" });
    fireEvent.pointerEnter(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Undo (Ctrl+Z)");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.pointerLeave(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("NumberField", () => {
  function field(onCommit = vi.fn(), props: Partial<Parameters<typeof NumberField>[0]> = {}) {
    render(<NumberField label="W" ariaLabel="Width" value={100} onCommit={onCommit} min={0} integer {...props} />);
    return { input: screen.getByLabelText("Width") as HTMLInputElement, onCommit };
  }

  it("commits once on Enter, not per keystroke", () => {
    const { input, onCommit } = field();
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.change(input, { target: { value: "120" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(120);
  });

  it("commits on blur", () => {
    const { input, onCommit } = field();
    fireEvent.change(input, { target: { value: "64" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(64);
  });

  it("refuses invalid or out-of-range text: commits nothing and shows the last good value", () => {
    const { input, onCommit } = field();
    for (const bad of ["abc", "-5", "2.5", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value, bad).toBe("100");
    }
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit an unchanged value", () => {
    const { input, onCommit } = field();
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("abandons the draft on Escape", () => {
    const { input, onCommit } = field();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(input.value).toBe("100");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("steps with the arrows, by ten with Shift, committing each step", () => {
    const { input, onCommit } = field();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(101);
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(91);
  });

  it("follows an outside change (undo) but not while someone is typing", () => {
    const { rerender } = render(<NumberField label="X" ariaLabel="X position" value={10} onCommit={() => {}} />);
    const input = screen.getByLabelText("X position") as HTMLInputElement;
    rerender(<NumberField label="X" ariaLabel="X position" value={20} onCommit={() => {}} />);
    expect(input.value).toBe("20");
    fireEvent.change(input, { target: { value: "3" } });
    rerender(<NumberField label="X" ariaLabel="X position" value={30} onCommit={() => {}} />);
    expect(input.value).toBe("3");
  });
});

describe("Menu", () => {
  function renderMenu() {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    render(
      <Menu
        label="Deck actions"
        trigger={(props) => (
          <button type="button" {...props}>
            Actions
          </button>
        )}
        items={[
          { id: "open", label: "Open", onSelect: onOpen },
          { id: "dup", label: "Duplicate", disabled: true, onSelect: vi.fn() },
          { id: "delete", label: "Delete", danger: true, onSelect: onDelete },
        ]}
      />,
    );
    return { trigger: screen.getByRole("button", { name: "Actions" }), onOpen, onDelete };
  }

  it("opens on ArrowDown with focus on the first item and skips disabled items", () => {
    const { trigger } = renderMenu();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("activates an item, closes, and returns focus to the trigger", () => {
    const { trigger, onDelete } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores a disabled item", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on Escape with focus back on the trigger, and on a press outside", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Select", () => {
  const options = [
    { value: "fixed", label: "Fixed" },
    { value: "auto", label: "Auto height" },
    { value: "shrink", label: "Shrink" },
  ] as const;

  it("does not apply the options someone arrows past — only the one they choose", () => {
    const onChange = vi.fn();
    render(<Select label="Fit mode" value="fixed" options={options} onChange={onChange} />);
    const button = screen.getByRole("button", { name: /Fit mode/ });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("shrink");
    expect(document.activeElement).toBe(button);
  });

  it("marks the current value selected and says nothing when it is re-chosen", () => {
    const onChange = vi.fn();
    render(<Select label="Fit mode" value="auto" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Fit mode/ }));
    expect(screen.getByRole("option", { name: "Auto height" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Auto height" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Segmented", () => {
  it("is a radio group whose arrows move and select, with one tab stop", () => {
    function Harness() {
      const [value, setValue] = useState<"cut" | "fade" | "morph">("fade");
      return (
        <Segmented
          label="Transition"
          value={value}
          onChange={setValue}
          items={[
            { value: "cut", label: "Cut" },
            { value: "fade", label: "Fade" },
            { value: "morph", label: "Morph" },
          ]}
        />
      );
    }
    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(radios[1]!, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Morph" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Morph" }));
  });
});

describe("Tabs", () => {
  it("mounts only the active panel, labelled by its tab", () => {
    function Harness() {
      const [value, setValue] = useState<"design" | "ai">("design");
      return (
        <Tabs
          label="Inspector"
          value={value}
          onChange={setValue}
          items={[
            { value: "design", label: "Design", panel: <p>design panel</p> },
            { value: "ai", label: "AI", panel: <p>ai panel</p> },
          ]}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("tabpanel", { name: "Design" }).textContent).toBe("design panel");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Design" }), { key: "ArrowRight" });
    expect(screen.getByRole("tabpanel", { name: "AI" }).textContent).toBe("ai panel");
    expect(screen.queryByText("design panel")).toBeNull();
  });
});

describe("Section", () => {
  it("is a disclosure whose body is unmounted while closed", () => {
    render(
      <Section title="Layers" meta="12 objects">
        <p>layer list</p>
      </Section>,
    );
    const toggle = screen.getByRole("button", { name: /Layers/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("layer list")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("layer list")).toBeTruthy();
    expect(toggle.textContent).toContain("12 objects");
  });
});

describe("Popover", () => {
  it("moves focus in on open and back to the trigger on Escape", () => {
    render(
      <Popover
        label="Share"
        trigger={(props) => (
          <button type="button" {...props}>
            Share
          </button>
        )}
      >
        <button type="button">Create view link</button>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "Share" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Share" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create view link" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Drawer", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          History
        </button>
        <Drawer
          open={open}
          onClose={() => setOpen(false)}
          title="Version history"
          meta="14 versions"
          footer={<Button variant="primary">Restore this version</Button>}
        >
          <button type="button">v14 — Current</button>
        </Drawer>
      </>
    );
  }

  it("is a labelled modal dialog that traps Tab and returns focus when closed", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "History" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Version history" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = screen.getByRole("button", { name: "Close version history" });
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the first focusable wraps to the last.
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Restore this version" }));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("StatusChip", () => {
  it("always carries a word, and its tone is a class, not an inline colour", () => {
    render(<StatusChip tone="waiting">Pending</StatusChip>);
    const chip = screen.getByText("Pending");
    expect(chip.className).toContain("dk-chip--waiting");
    expect(chip.getAttribute("style")).toBeNull();
  });
});
