import { useMemo, useRef, useState } from "react";
import type { ShapeKind } from "@deckastra/presentation-schema";
import type { StarterElementKind } from "@deckastra/presentation-core";
import { ICON_NAMES, ICON_VIEWBOX, findIcon, shapeGeometry } from "@deckastra/renderer";

import { Button, Icon, IconButton, Tabs, TextField, cx, type IconName } from "../../ui";

/**
 * The Add library (design review, 2026-09-26): everything that can be put on a
 * slide, seen before it is chosen.
 *
 * The product always had eleven shapes and 42 curated icons, but the rail showed
 * two shapes and an icon was chosen by typing its name into a field, so people
 * concluded there were none. Here every shape is drawn by the same geometry the
 * renderer uses, every icon is drawn from its own paths, search matches names
 * and keywords, and the last few things used and the ones starred stay at hand.
 * Recent and favourites are this person's editor state, kept in this browser;
 * they never reach a document.
 */

export type LibraryTab = "shapes" | "icons" | "media";

export type LibraryItem =
  | { kind: "shape"; shape: ShapeKind }
  | { kind: "line" }
  | { kind: "icon"; name: string }
  | { kind: "object"; object: StarterElementKind };

interface ShapeEntry {
  shape: ShapeKind | "line";
  label: string;
  keywords: string;
  categories: string[];
}

const SHAPES: readonly ShapeEntry[] = [
  { shape: "rectangle", label: "Rectangle", keywords: "box square card process", categories: ["Basic", "Flowchart"] },
  { shape: "ellipse", label: "Circle", keywords: "ellipse oval round dot", categories: ["Basic"] },
  { shape: "triangle", label: "Triangle", keywords: "warning pyramid", categories: ["Basic"] },
  { shape: "diamond", label: "Diamond", keywords: "decision rhombus", categories: ["Basic", "Flowchart"] },
  { shape: "pill", label: "Pill", keywords: "rounded capsule terminator start end tag", categories: ["Basic", "Flowchart"] },
  { shape: "polygon", label: "Hexagon", keywords: "polygon honeycomb", categories: ["Basic"] },
  { shape: "star", label: "Star", keywords: "favourite rating highlight", categories: ["Basic"] },
  { shape: "parallelogram", label: "Parallelogram", keywords: "input output data slant", categories: ["Basic", "Flowchart"] },
  { shape: "arrow", label: "Arrow", keywords: "direction next forward pointer", categories: ["Arrows"] },
  { shape: "chevron", label: "Chevron", keywords: "step process stage arrow", categories: ["Arrows", "Flowchart"] },
  { shape: "line", label: "Line", keywords: "rule divider connector stroke", categories: ["Arrows"] },
  { shape: "speechBubble", label: "Speech bubble", keywords: "callout quote comment say", categories: ["Callouts"] },
];

const CATEGORIES = ["All", "Basic", "Arrows", "Flowchart", "Callouts"] as const;

const OBJECTS: readonly { object: StarterElementKind; label: string; icon: IconName; keywords: string }[] = [
  { object: "chart", label: "Chart", icon: "chart", keywords: "graph bar line pie data" },
  { object: "table", label: "Table", icon: "table", keywords: "grid rows columns data" },
  { object: "diagram", label: "Diagram", icon: "diagram", keywords: "flow architecture boxes" },
  { object: "equation", label: "Equation", icon: "equation", keywords: "math formula latex" },
  { object: "code", label: "Code", icon: "code", keywords: "snippet source program" },
];

const STORE = "deckastra.library";
const RECENT_LIMIT = 8;

function keyOf(item: LibraryItem): string {
  return item.kind === "shape" ? `shape:${item.shape}` : item.kind === "line" ? "shape:line" : item.kind === "icon" ? `icon:${item.name}` : `object:${item.object}`;
}

function itemOf(key: string): LibraryItem | undefined {
  const [kind, name] = key.split(":") as [string, string];
  if (kind === "shape") return name === "line" ? { kind: "line" } : SHAPES.some((s) => s.shape === name) ? { kind: "shape", shape: name as ShapeKind } : undefined;
  if (kind === "icon") return findIcon(name) ? { kind: "icon", name } : undefined;
  if (kind === "object") return OBJECTS.some((o) => o.object === name) ? { kind: "object", object: name as StarterElementKind } : undefined;
  return undefined;
}

interface Saved {
  recent: string[];
  favourites: string[];
}

function load(): Saved {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Saved>;
    return {
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((key) => typeof key === "string" && itemOf(key)) : [],
      favourites: Array.isArray(parsed.favourites) ? parsed.favourites.filter((key) => typeof key === "string" && itemOf(key)) : [],
    };
  } catch {
    return { recent: [], favourites: [] };
  }
}

function save(next: Saved): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    // A browser that refuses storage still inserts; it just does not remember.
  }
}

/** A shape drawn by the renderer's own geometry, so the tile is what arrives. */
export function ShapeThumb({ shape }: { shape: ShapeKind | "line" }) {
  if (shape === "line") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true" className="dk-library__art">
        <path d="M6 26 42 6" fill="none" stroke="currentColor" strokeWidth="3" />
      </svg>
    );
  }
  const geometry = shapeGeometry({ shape, width: 44, height: 28 });
  return (
    <svg viewBox="-2 -2 48 32" aria-hidden="true" className="dk-library__art">
      {geometry.preferRect && geometry.radiusOverride ? (
        // Drawn the way the renderer draws it: a rounded rect, not the outline.
        <rect width={44} height={28} rx={geometry.radiusOverride} fill="currentColor" fillOpacity="0.5" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <path d={geometry.pathData} fill="currentColor" fillOpacity="0.5" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  );
}

/** A curated icon, drawn from the same paths the slide uses. */
export function IconThumb({ name }: { name: string }) {
  const icon = findIcon(name);
  if (!icon) return null;
  return (
    <svg viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} aria-hidden="true" className="dk-library__icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icon.paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
      {(icon.circles ?? []).map(([cx, cy, r], index) => (
        <circle key={`c${index}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}

function labelOf(item: LibraryItem): string {
  if (item.kind === "icon") return item.name.replace(/-/g, " ");
  if (item.kind === "line") return "Line";
  if (item.kind === "object") return OBJECTS.find((o) => o.object === item.object)?.label ?? item.object;
  return SHAPES.find((s) => s.shape === item.shape)?.label ?? item.shape;
}

export interface AddLibraryProps {
  tab: LibraryTab;
  onTab: (tab: LibraryTab) => void;
  onClose: () => void;
  onAdd: (item: LibraryItem) => void;
  onAddImage: (file: File) => void | Promise<void>;
}

export function AddLibrary({ tab, onTab, onClose, onAdd, onAddImage }: AddLibraryProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [saved, setSaved] = useState<Saved>(load);
  const fileInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();

  const add = (item: LibraryItem) => {
    const key = keyOf(item);
    const next = { ...saved, recent: [key, ...saved.recent.filter((existing) => existing !== key)].slice(0, RECENT_LIMIT) };
    setSaved(next);
    save(next);
    onAdd(item);
  };
  const toggleFavourite = (item: LibraryItem) => {
    const key = keyOf(item);
    const favourites = saved.favourites.includes(key) ? saved.favourites.filter((existing) => existing !== key) : [...saved.favourites, key];
    const next = { ...saved, favourites };
    setSaved(next);
    save(next);
  };

  const shapes = SHAPES.filter(
    (entry) =>
      (category === "All" || entry.categories.includes(category)) &&
      (!needle || `${entry.label} ${entry.keywords}`.toLowerCase().includes(needle)),
  );
  const icons = useMemo(
    () =>
      ICON_NAMES.filter((name) => {
        if (!needle) return true;
        const keywords = findIcon(name)?.keywords.join(" ") ?? "";
        return `${name} ${keywords}`.toLowerCase().includes(needle);
      }),
    [needle],
  );

  const tile = (item: LibraryItem, art: React.ReactNode, caption?: string) => {
    const key = keyOf(item);
    const label = labelOf(item);
    const favourite = saved.favourites.includes(key);
    return (
      <div key={key} className="dk-library__tile">
        <button
          type="button"
          className="dk-library__add"
          aria-label={`Add ${label.toLowerCase()}`}
          title={label}
          data-testid={`library-${key.replace(":", "-")}`}
          onClick={() => add(item)}
        >
          {art}
          {caption ? <span className="dk-library__caption">{caption}</span> : null}
        </button>
        <button
          type="button"
          className={cx("dk-library__star", favourite && "dk-library__star--on")}
          aria-label={favourite ? `Remove ${label.toLowerCase()} from favourites` : `Add ${label.toLowerCase()} to favourites`}
          aria-pressed={favourite}
          onClick={() => toggleFavourite(item)}
        >
          {favourite ? "★" : "☆"}
        </button>
      </div>
    );
  };

  const artFor = (item: LibraryItem) =>
    item.kind === "icon" ? <IconThumb name={item.name} /> : item.kind === "object" ? <Icon name={OBJECTS.find((o) => o.object === item.object)!.icon} size={22} /> : <ShapeThumb shape={item.kind === "line" ? "line" : item.shape} />;

  const quick = (title: string, keys: string[], empty: string) => (
    <section className="dk-library__section">
      <h4 className="dk-library__heading">{title}</h4>
      {keys.length ? (
        <div className="dk-library__grid dk-library__grid--small">
          {keys.map((key) => {
            const item = itemOf(key);
            return item ? tile(item, artFor(item)) : null;
          })}
        </div>
      ) : (
        <p className="dk-field__hint">{empty}</p>
      )}
    </section>
  );

  const shapesPanel = (
    <>
      <div className="dk-library__chips" role="group" aria-label="Shape category">
        {CATEGORIES.map((name) => (
          <button
            key={name}
            type="button"
            className={cx("dk-chipbutton", category === name && "dk-chipbutton--on")}
            aria-pressed={category === name}
            onClick={() => setCategory(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="dk-library__grid" data-testid="library-shapes">
        {shapes.map((entry) =>
          tile(entry.shape === "line" ? { kind: "line" } : { kind: "shape", shape: entry.shape }, <ShapeThumb shape={entry.shape} />, entry.label),
        )}
      </div>
      {shapes.length === 0 ? <p className="dk-field__hint">No shape matches "{query}".</p> : null}
      {!needle ? (
        <>
          <h4 className="dk-library__heading">Objects</h4>
          <div className="dk-library__grid">
            {OBJECTS.map((entry) => tile({ kind: "object", object: entry.object }, <Icon name={entry.icon} size={22} />, entry.label))}
          </div>
        </>
      ) : null}
    </>
  );

  const iconsPanel = (
    <>
      <div className="dk-library__grid dk-library__grid--icons" data-testid="library-icons">
        {icons.map((name) => tile({ kind: "icon", name }, <IconThumb name={name} />))}
      </div>
      {icons.length === 0 ? <p className="dk-field__hint">No icon matches "{query}". Try a word like "user", "chart" or "time".</p> : null}
      <p className="dk-field__hint">{ICON_NAMES.length} icons, drawn as lines that take your colours and export as shapes.</p>
    </>
  );

  const mediaPanel = (
    <>
      <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()} data-testid="library-upload-image">
        Upload an image
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        aria-label="Image file"
        tabIndex={-1}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onAddImage(file);
        }}
      />
      <p className="dk-field__hint">PNG, JPEG, GIF, WebP or SVG. You can also paste a picture or drop one on the slide.</p>
      <h4 className="dk-library__heading">Objects</h4>
      <div className="dk-library__grid">
        {OBJECTS.map((entry) => tile({ kind: "object", object: entry.object }, <Icon name={entry.icon} size={22} />, entry.label))}
      </div>
    </>
  );

  return (
    <aside className="dk-library" aria-label="Add to slide" data-region="library" data-testid="add-library">
      <div className="dk-library__head">
        <h3 className="dk-library__title">Add to slide</h3>
        <IconButton icon="close" label="Close the library" size="sm" onClick={onClose} />
      </div>
      {tab !== "media" ? (
        <TextField
          label="Search shapes and icons"
          hideLabel
          type="search"
          placeholder="Search shapes and icons"
          value={query}
          data-testid="library-search"
          onChange={setQuery}
        />
      ) : null}
      <Tabs
        label="Library"
        value={tab}
        onChange={onTab}
        className="dk-library__tabs"
        items={[
          { value: "shapes", label: "Shapes", panel: shapesPanel },
          { value: "icons", label: "Icons", panel: iconsPanel },
          { value: "media", label: "Media", panel: mediaPanel },
        ]}
      />
      {quick("Recent", saved.recent, "What you add appears here.")}
      {quick("Favourites", saved.favourites, "Star anything to keep it here.")}
    </aside>
  );
}
