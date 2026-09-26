import { useState } from "react";
import { ICON_NAMES, findIcon } from "@deckastra/renderer";

import { Popover, TextField, cx } from "../../ui";
import { IconThumb, ShapeThumb } from "../shell/AddLibrary";

/**
 * Changing a shape or an icon by looking at the choices (design review,
 * 2026-09-26). A shape was a dropdown of internal names ("speechBubble") and an
 * icon a text field you had to know a name for; both are now the same drawings
 * the Add library shows.
 */

const SHAPES: { value: string; label: string }[] = [
  { value: "rectangle", label: "Rectangle" },
  { value: "ellipse", label: "Circle" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" },
  { value: "pill", label: "Pill" },
  { value: "polygon", label: "Hexagon" },
  { value: "star", label: "Star" },
  { value: "parallelogram", label: "Parallelogram" },
  { value: "arrow", label: "Arrow" },
  { value: "chevron", label: "Chevron" },
  { value: "speechBubble", label: "Speech bubble" },
];

export function ShapePicker({ value, onChange, disabled }: { value: string; onChange: (shape: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const current = SHAPES.find((shape) => shape.value === value)?.label ?? value;
  return (
    <div className="dk-field">
      <span className="dk-label">Shape</span>
      <Popover
        label="Shape choices"
        align="end"
        open={open}
        onOpenChange={setOpen}
        className="dk-visualpicker"
        trigger={(props) => (
          <button type="button" className="dk-input dk-visualpicker__trigger" aria-label={`Shape: ${current}`} disabled={disabled} data-testid="shape-picker" {...props}>
            <span className="dk-visualpicker__thumb">
              <ShapeThumb shape={value as never} />
            </span>
            {current}
          </button>
        )}
      >
        <div className="dk-library__grid" role="listbox" aria-label="Shape">
          {SHAPES.map((shape) => (
            <button
              key={shape.value}
              type="button"
              role="option"
              aria-selected={shape.value === value}
              aria-label={shape.label}
              title={shape.label}
              className={cx("dk-library__add", shape.value === value && "dk-visualpicker__on")}
              onClick={() => {
                setOpen(false);
                if (shape.value !== value) onChange(shape.value);
              }}
            >
              <ShapeThumb shape={shape.value as never} />
              <span className="dk-library__caption">{shape.label}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

export function IconPicker({ value, onChange, disabled }: { value: string; onChange: (name: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const names = ICON_NAMES.filter((name) => !needle || `${name} ${findIcon(name)?.keywords.join(" ") ?? ""}`.toLowerCase().includes(needle));
  return (
    <div className="dk-field">
      <span className="dk-label">Icon</span>
      <Popover
        label="Icon choices"
        align="end"
        open={open}
        onOpenChange={setOpen}
        className="dk-visualpicker"
        trigger={(props) => (
          <button type="button" className="dk-input dk-visualpicker__trigger" aria-label={`Icon: ${value}`} disabled={disabled} data-testid="icon-picker" {...props}>
            <span className="dk-visualpicker__thumb">
              <IconThumb name={value} />
            </span>
            {value.replace(/-/g, " ")}
          </button>
        )}
      >
        <TextField label="Search icons" hideLabel type="search" placeholder="Search icons" value={query} onChange={setQuery} />
        <div className="dk-library__grid dk-library__grid--icons dk-visualpicker__list" role="listbox" aria-label="Icon">
          {names.map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={name === value}
              aria-label={name.replace(/-/g, " ")}
              title={name.replace(/-/g, " ")}
              className={cx("dk-library__add", name === value && "dk-visualpicker__on")}
              onClick={() => {
                setOpen(false);
                setQuery("");
                if (name !== value) onChange(name);
              }}
            >
              <IconThumb name={name} />
            </button>
          ))}
        </div>
        {names.length === 0 ? <p className="dk-field__hint">No icon matches "{query}".</p> : null}
      </Popover>
    </div>
  );
}
