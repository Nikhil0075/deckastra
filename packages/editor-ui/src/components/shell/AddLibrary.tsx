import { useEffect, useMemo, useRef, useState } from "react";
import type { BrandIcon, PatchOperation, PresentationDocument, ShapeKind } from "@deckastra/presentation-schema";
import type { StarterElementKind } from "@deckastra/presentation-core";
import { ICON_CATEGORIES, ICON_NAMES, ICON_VIEWBOX, findIcon, shapeGeometry } from "@deckastra/renderer";
import { useOptionalWorkspaceClient } from "@deckastra/workspace-client/react";

import { pptxFidelity } from "../../lib/export-fidelity";
import { addBrandIconOperations, brandIconName, parseSvgIcon, removeBrandIconOperations } from "../../lib/svg-icon";
import { Button, Icon, IconButton, StatusChip, Tabs, TextField, cx, type IconName } from "../../ui";

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

export type LibraryTab = "shapes" | "icons" | "brand" | "media";

export type LibraryItem =
  | { kind: "shape"; shape: ShapeKind }
  | { kind: "line" }
  | { kind: "icon"; name: string; set?: "brand" }
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
  if (item.kind === "icon") return item.set === "brand" ? `brand:${item.name}` : `icon:${item.name}`;
  return item.kind === "shape" ? `shape:${item.shape}` : item.kind === "line" ? "shape:line" : `object:${item.object}`;
}

function itemOf(key: string, brand: Record<string, BrandIcon> = {}): LibraryItem | undefined {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const name = key.slice(at + 1);
  if (kind === "shape") return name === "line" ? { kind: "line" } : SHAPES.some((s) => s.shape === name) ? { kind: "shape", shape: name as ShapeKind } : undefined;
  if (kind === "icon") return findIcon(name) ? { kind: "icon", name } : undefined;
  if (kind === "brand") return brand[name] ? { kind: "icon", name, set: "brand" } : undefined;
  if (kind === "object") return OBJECTS.some((o) => o.object === name) ? { kind: "object", object: name as StarterElementKind } : undefined;
  return undefined;
}

interface Saved {
  recent: string[];
  favourites: string[];
}

/**
 * Keys only: whether each still names something is decided where they are
 * shown, because a brand icon's name means something only against a deck.
 */
function clean(value: unknown): Saved {
  const parsed = (value && typeof value === "object" ? value : {}) as Partial<Saved>;
  const keys = (list: unknown) => (Array.isArray(list) ? list.filter((key): key is string => typeof key === "string" && key.length < 120).slice(0, 60) : []);
  return { recent: keys(parsed.recent).slice(0, RECENT_LIMIT), favourites: keys(parsed.favourites) };
}

function load(): Saved {
  try {
    return clean(JSON.parse(localStorage.getItem(STORE) ?? "{}"));
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

/** A curated icon, or one of the theme's own, drawn from the same paths the slide uses. */
export function IconThumb({ name, brand }: { name: string; brand?: BrandIcon }) {
  const icon = brand ?? findIcon(name);
  if (!icon) return null;
  const box = brand?.viewBox ?? ICON_VIEWBOX;
  const filled = Boolean(brand?.fill);
  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      aria-hidden="true"
      className="dk-library__icon"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : (1.8 * box) / ICON_VIEWBOX}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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
  /** The deck, for its brand icons; and a way to add or remove one. */
  document?: PresentationDocument;
  apply?: (operations: PatchOperation[], label: string) => void;
}

export function AddLibrary({ tab, onTab, onClose, onAdd, onAddImage, document, apply }: AddLibraryProps) {
  const client = useOptionalWorkspaceClient();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [iconCategory, setIconCategory] = useState<string>("All");
  const [saved, setSaved] = useState<Saved>(load);
  const [svgProblem, setSvgProblem] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  const svgInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const brand = (document?.theme.icons ?? {}) as Record<string, BrandIcon>;

  // Recent and favourites follow the person (design review, 2026-09-27): read
  // from the service once, merged with this browser's copy, which stays as the
  // offline cache. A service that cannot keep them leaves the local copy alone.
  useEffect(() => {
    if (!client?.session.readPreference) return;
    let live = true;
    client.session
      .readPreference("library")
      .then((value) => {
        if (!live || !value) return;
        const remote = clean(value);
        setSaved((local) => {
          const merged = {
            recent: [...new Set([...local.recent, ...remote.recent])].slice(0, RECENT_LIMIT),
            favourites: [...new Set([...remote.favourites, ...local.favourites])],
          };
          save(merged);
          return merged;
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  const remember = (next: Saved) => {
    setSaved(next);
    save(next);
    void client?.session.writePreference?.("library", next).catch(() => undefined);
  };

  const add = (item: LibraryItem) => {
    const key = keyOf(item);
    remember({ ...saved, recent: [key, ...saved.recent.filter((existing) => existing !== key)].slice(0, RECENT_LIMIT) });
    onAdd(item);
  };
  const toggleFavourite = (item: LibraryItem) => {
    const key = keyOf(item);
    const favourites = saved.favourites.includes(key) ? saved.favourites.filter((existing) => existing !== key) : [...saved.favourites, key];
    remember({ ...saved, favourites });
  };

  const uploadSvg = async (file: File) => {
    if (!document || !apply) return;
    const result = parseSvgIcon(await readText(file));
    if (!result.ok) {
      setSvgProblem(result.reason);
      return;
    }
    const name = brandIconName(document, file.name);
    apply(addBrandIconOperations(document, name, result.icon), `Add the ${name} icon`);
    setSvgProblem(undefined);
  };

  const shapes = SHAPES.filter(
    (entry) =>
      (category === "All" || entry.categories.includes(category)) &&
      (!needle || `${entry.label} ${entry.keywords}`.toLowerCase().includes(needle)),
  );
  const icons = useMemo(
    () =>
      ICON_NAMES.filter((name) => {
        const icon = findIcon(name);
        if (iconCategory !== "All" && icon?.category !== iconCategory) return false;
        if (!needle) return true;
        return `${name} ${icon?.keywords.join(" ") ?? ""}`.toLowerCase().includes(needle);
      }),
    [needle, iconCategory],
  );
  const brandNames = Object.keys(brand)
    .filter((name) => !needle || `${name} ${brand[name]!.keywords?.join(" ") ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));

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
    item.kind === "icon" ? <IconThumb name={item.name} brand={item.set === "brand" ? brand[item.name] : undefined} /> : item.kind === "object" ? <Icon name={OBJECTS.find((o) => o.object === item.object)!.icon} size={22} /> : <ShapeThumb shape={item.kind === "line" ? "line" : item.shape} />;

  /** An object, with what it becomes in PowerPoint said before it is added. */
  const objectTile = (entry: (typeof OBJECTS)[number]) => {
    const fidelity = pptxFidelity(entry.object);
    return (
      <div key={entry.object} className="dk-library__objecttile" title={`In PowerPoint: ${fidelity.detail}`}>
        {tile({ kind: "object", object: entry.object }, <Icon name={entry.icon} size={22} />, entry.label)}
        <StatusChip tone={fidelity.fidelity === "native" ? "neutral" : "waiting"} className="dk-library__fidelity">
          {fidelity.label}
        </StatusChip>
      </div>
    );
  };

  const quick = (title: string, keys: string[], empty: string) => (
    <section className="dk-library__section">
      <h4 className="dk-library__heading">{title}</h4>
      {keys.length ? (
        <div className="dk-library__grid dk-library__grid--small">
          {keys.map((key) => {
            const item = itemOf(key, brand);
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
          <div className="dk-library__grid">{OBJECTS.map(objectTile)}</div>
        </>
      ) : null}
    </>
  );

  const iconsPanel = (
    <>
      <div className="dk-library__chips" role="group" aria-label="Icon category">
        {["All", ...ICON_CATEGORIES].map((name) => (
          <button
            key={name}
            type="button"
            className={cx("dk-chipbutton", iconCategory === name && "dk-chipbutton--on")}
            aria-pressed={iconCategory === name}
            onClick={() => setIconCategory(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="dk-library__grid dk-library__grid--icons" data-testid="library-icons">
        {icons.map((name) => tile({ kind: "icon", name }, <IconThumb name={name} />))}
      </div>
      {icons.length === 0 ? <p className="dk-field__hint">No icon matches "{query}". Try a word like "user", "chart" or "time".</p> : null}
      <p className="dk-field__hint">
        {ICON_NAMES.length} icons, drawn as lines that take your colours. In PowerPoint they are editable shapes.
      </p>
    </>
  );

  const brandPanel = (
    <>
      {apply && document ? (
        <Button variant="primary" icon="upload" onClick={() => svgInput.current?.click()} data-testid="library-upload-svg">
          Upload an SVG icon
        </Button>
      ) : null}
      <input
        ref={svgInput}
        type="file"
        accept="image/svg+xml,.svg"
        aria-label="SVG icon file"
        tabIndex={-1}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadSvg(file);
        }}
      />
      {svgProblem ? (
        <p className="dk-field__hint dk-field__hint--error" role="alert" data-testid="library-svg-problem">
          {svgProblem}
        </p>
      ) : null}
      {brandNames.length ? (
        <div className="dk-library__grid dk-library__grid--icons" data-testid="library-brand">
          {brandNames.map((name) => (
            <div key={name} className="dk-library__brandtile">
              {tile({ kind: "icon", name, set: "brand" }, <IconThumb name={name} brand={brand[name]} />, name)}
              {apply && document ? (
                <IconButton icon="trash" size="sm" label={`Remove ${name} from the brand icons`} onClick={() => apply(removeBrandIconOperations(document, name), `Remove the ${name} icon`)} />
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="dk-field__hint">
          Your brand&apos;s own icons and logo marks. Upload an SVG and it is kept with the theme, so it travels to every deck that uses it
          and into a saved workspace theme.
        </p>
      )}
      <p className="dk-field__hint">Only the drawing is kept; anything else in the file is left behind.</p>
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
      <div className="dk-library__grid">{OBJECTS.map(objectTile)}</div>
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
          { value: "brand", label: "Brand", panel: brandPanel },
          { value: "media", label: "Media", panel: mediaPanel },
        ]}
      />
      {quick("Recent", saved.recent, "What you add appears here.")}
      {quick("Favourites", saved.favourites, "Star anything to keep it here.")}
    </aside>
  );
}

/** A file's text through FileReader, which every browser and test environment has. */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
