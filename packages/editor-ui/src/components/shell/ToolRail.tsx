import { useRef } from "react";
import type { StarterElementKind } from "@deckastra/presentation-core";

import { IconButton, type IconName } from "../../ui";

interface Tool {
  id: string;
  label: string;
  icon: IconName;
  kind: StarterElementKind;
  shape?: "rectangle" | "ellipse";
}

/**
 * Insert tools, top to bottom in the order the Figma rail draws them. Each one
 * inserts at once — there is no armed-tool mode to leave the editor stuck in.
 */
const TOOLS: readonly Tool[] = [
  { id: "text", label: "Text", icon: "text", kind: "text" },
  { id: "rect", label: "Rectangle", icon: "rect", kind: "shape", shape: "rectangle" },
  { id: "ellipse", label: "Ellipse", icon: "ellipse", kind: "shape", shape: "ellipse" },
  { id: "line", label: "Line", icon: "line", kind: "line" },
];

const OBJECTS: readonly Tool[] = [
  { id: "chart", label: "Chart", icon: "chart", kind: "chart" },
  { id: "diagram", label: "Diagram", icon: "diagram", kind: "diagram" },
  { id: "table", label: "Table", icon: "table", kind: "table" },
  { id: "code", label: "Code", icon: "code", kind: "code" },
  { id: "equation", label: "Equation", icon: "equation", kind: "equation" },
  { id: "icon", label: "Icon", icon: "grid", kind: "icon" },
];

export interface ToolRailProps {
  onAdd: (kind: StarterElementKind, shape?: "rectangle" | "ellipse") => void;
  onAddImage: (file: File) => void | Promise<void>;
  disabled?: boolean;
}

/** The vertical insert toolbar on the left edge. */
export function ToolRail({ onAdd, onAddImage, disabled }: ToolRailProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const button = (tool: Tool) => (
    <IconButton
      key={tool.id}
      icon={tool.icon}
      label={`Add ${tool.label.toLowerCase()}`}
      disabled={disabled}
      onClick={() => onAdd(tool.kind, tool.shape)}
      data-testid={`tool-${tool.id}`}
    />
  );

  return (
    <div className="dk-rail" role="toolbar" aria-label="Insert" aria-orientation="vertical" data-region="tools">
      {TOOLS.map(button)}
      <IconButton
        icon="image"
        label="Add image"
        disabled={disabled}
        onClick={() => fileInput.current?.click()}
        data-testid="tool-image"
      />
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
      <span className="dk-rail__rule" aria-hidden="true" />
      {OBJECTS.map(button)}
    </div>
  );
}
