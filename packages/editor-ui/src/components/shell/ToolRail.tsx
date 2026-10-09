import { useRef } from "react";
import type { StarterElementKind } from "@deckastra/presentation-core";

import { Icon, cx, type IconName } from "../../ui";
import type { LibraryTab } from "./AddLibrary";

/**
 * The tool rail (design review, 2026-09-26): what can be added, each with its
 * name under its picture.
 *
 * The rail used to be eleven unlabelled pictograms and two of the eleven
 * shapes, which is why people concluded there were no shapes or icons. Now:
 * **Add** opens the library (every shape, icon and object, seen before it is
 * chosen); Text and Image insert in one click, because they are what a slide is
 * mostly made of; Shapes and Icons open the library at their tab; the objects
 * insert directly. At the bottom, the two side panels that are about the slide
 * rather than about adding to it: Layers and Check.
 */

export type SidePanel = "library" | "layers" | "check";

interface Tool {
  id: string;
  label: string;
  icon: IconName;
  /** Insert at once, or open the library at a tab. */
  action: { insert: StarterElementKind } | { library: LibraryTab } | { image: true };
}

const TOOLS: readonly Tool[] = [
  { id: "text", label: "Text", icon: "text", action: { insert: "text" } },
  { id: "patterns", label: "Patterns", icon: "grid", action: { library: "patterns" } },
  { id: "shapes", label: "Shapes", icon: "rect", action: { library: "shapes" } },
  { id: "icons", label: "Icons", icon: "grid", action: { library: "icons" } },
  { id: "image", label: "Image", icon: "image", action: { image: true } },
  { id: "chart", label: "Chart", icon: "chart", action: { insert: "chart" } },
  { id: "table", label: "Table", icon: "table", action: { insert: "table" } },
  { id: "diagram", label: "Diagram", icon: "diagram", action: { insert: "diagram" } },
  { id: "equation", label: "Equation", icon: "equation", action: { insert: "equation" } },
  { id: "code", label: "Code", icon: "code", action: { insert: "code" } },
];

export interface ToolRailProps {
  onAdd: (kind: StarterElementKind) => void;
  onAddImage: (file: File) => void | Promise<void>;
  /** Open (or, when it is the open one, close) a side panel. */
  onPanel: (panel: SidePanel, tab?: LibraryTab) => void;
  /** The side panel open now, and the library's tab when it is the library. */
  open?: SidePanel;
  libraryTab?: LibraryTab;
  disabled?: boolean;
  /** Design Check findings on this slide, shown on the Check button. */
  checkCount?: number;
}

export function ToolRail({ onAdd, onAddImage, onPanel, open, libraryTab, disabled, checkCount = 0 }: ToolRailProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const button = (id: string, label: string, icon: IconName, onClick: () => void, active = false, primary = false, title?: string, badge?: number) => (
    <button
      key={id}
      type="button"
      className={cx("dk-railbutton", active && "dk-railbutton--active", primary && "dk-railbutton--primary")}
      aria-label={title ?? label}
      aria-pressed={active || undefined}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      data-testid={`tool-${id}`}
    >
      <Icon name={icon} size={18} />
      <span className="dk-railbutton__label">{label}</span>
      {badge ? (
        <span className="dk-railbutton__badge" aria-hidden="true" data-testid={`tool-${id}-count`}>
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="dk-rail dk-rail--labelled" role="toolbar" aria-label="Insert" aria-orientation="vertical" data-region="tools">
      {button("add", "Add", "plus", () => onPanel("library"), open === "library", true, "Add shapes, icons and media")}
      {TOOLS.map((tool) => {
        const action = tool.action;
        if ("insert" in action) return button(tool.id, tool.label, tool.icon, () => onAdd(action.insert), false, false, `Add ${tool.label.toLowerCase()}`);
        if ("library" in action) {
          const active = open === "library" && libraryTab === action.library;
          return button(tool.id, tool.label, tool.icon, () => onPanel("library", action.library), active, false, `Browse ${tool.label.toLowerCase()}`);
        }
        return button(tool.id, tool.label, tool.icon, () => fileInput.current?.click(), false, false, "Add an image");
      })}
      <input
        ref={fileInput}
        type="file"
        // The kinds the renderer can draw. A wider filter would let someone pick
        // a PDF and meet a refusal after the upload rather than before it.
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        aria-label="Image file"
        tabIndex={-1}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first: picking the same file twice in a row fires no change
          // event otherwise, which reads as the button having stopped working.
          event.target.value = "";
          if (file) void onAddImage(file);
        }}
      />
      <span className="dk-rail__spacer" aria-hidden="true" />
      {button("layers", "Layers", "list", () => onPanel("layers"), open === "layers", false, "Layers on this slide")}
      {button(
        "check",
        "Check",
        "check",
        () => onPanel("check"),
        open === "check",
        false,
        checkCount ? `Design check: ${checkCount} ${checkCount === 1 ? "issue" : "issues"} on this slide` : "Design check",
        checkCount,
      )}
    </div>
  );
}
