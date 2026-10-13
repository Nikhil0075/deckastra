import { useRef, useState } from "react";
import type { ImageElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import { resolveImageMask } from "@deckastra/renderer";

import { uploadAndReplaceImage } from "../../lib/insert-image";
import { uploadAndAddCutout } from "../../lib/cutouts";
import {
  MASK_CHOICES,
  maskChoice,
  maskExportNote,
  maskWithChoice,
  maskWithOptions,
  maskWithPath,
  type MaskChoice,
} from "../../lib/image-mask";
import { Button, NumberField, Popover, Section, Segmented, Select, TextField, cx } from "../../ui";
import { ColorField, Hint } from "./controls";
import {
  treatmentExportNote,
  treatmentOperations,
  treatmentPercent,
  treatmentPreset,
  treatmentPresets,
  treatmentWith,
  type TreatmentAmount,
} from "../../lib/image-treatment";

/**
 * A picture: swap it for another (MA-21) and choose which part of it shows
 * (MA-22).
 *
 * Replacing keeps the element — its id, its place, its animation and its morph
 * pairings — and asks what the box should do when the new picture is a
 * different shape, rather than guessing. Repositioning writes the element's
 * `focalPoint`, which the editor, present mode and the PDF draw as CSS
 * `object-position`, and PowerPoint as the matching `srcRect`; the preview
 * shows the whole picture with the visible window marked, so it is clear what
 * is being cut away and nothing is lost by moving it.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

export function ImageSection({
  document,
  element,
  edit,
  disabled,
  resolveAssetUrl,
}: {
  document: PresentationDocument;
  element: ImageElement;
  edit: Edit;
  disabled: boolean;
  resolveAssetUrl: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const client = useWorkspaceClient();
  const input = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<"keep" | "match">("keep");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | undefined>();

  const asset = document.assets.find((candidate) => candidate.id === element.assetId) as
    | { storageKey?: string; width?: number; height?: number; fileName?: string }
    | undefined;
  const fit = element.fit ?? "cover";
  const focal = element.focalPoint ?? { x: 0.5, y: 0.5 };
  const url = resolveAssetUrl(element.assetId, asset?.storageKey);
  const set = (property: string, value: unknown, label: string) =>
    edit(setPropertyDeep(document, element.id, property, value), label, `inspector:${element.id}:${property}`);

  // The visible window, as a fraction of the whole picture, for the preview.
  const visible = visibleWindow(element.transform, asset, fit, focal);
  // Only `cover` crops, so only `cover` has a part of the picture to choose.
  const canReposition = fit === "cover";

  const replace = async (file: File) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const { operations, altTextNeedsReview } = await uploadAndReplaceImage(client, {
        document,
        elementId: element.id,
        file,
        box,
      });
      edit(operations, "Replace image");
      if (altTextNeedsReview) {
        setMessage({ tone: "info", text: "The alt text was written for the previous picture. Check that it still describes this one." });
      }
    } catch (caught) {
      // The storage quota is the likeliest refusal; saying so beats a picture
      // that silently stays the same.
      setMessage({ tone: "error", text: caught instanceof Error ? caught.message : "That picture could not be used." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Picture" defaultOpen meta={asset?.fileName}>
      <Select
        label="Fit"
        value={fit}
        options={[
          { value: "cover", label: "Fill the box (crop)" },
          { value: "contain", label: "Fit inside the box" },
          { value: "fill", label: "Stretch" },
          { value: "none", label: "Actual size" },
        ]}
        disabled={disabled}
        onChange={(v) => set("fit", v, "Change image fit")}
      />

      {url ? (
        <div className="dk-image-preview" data-testid="image-preview">
          <img src={url} alt="" draggable={false} />
          {visible ? (
            <span
              className="dk-image-preview__window"
              aria-hidden="true"
              style={{
                left: `${visible.x * 100}%`,
                top: `${visible.y * 100}%`,
                width: `${visible.width * 100}%`,
                height: `${visible.height * 100}%`,
              }}
            />
          ) : null}
        </div>
      ) : null}

      <MaskControls element={element} fit={fit} disabled={disabled} edit={edit} document={document} />
      <CutoutControls element={element} disabled={disabled} edit={edit} document={document} />
      <TreatmentControls element={element} disabled={disabled} edit={edit} document={document} />

      {canReposition ? (
        <>
          <div className="dk-grid2">
            <NumberField
              label="Across"
              ariaLabel="Horizontal position of the picture in its box"
              unit="%"
              value={Math.round(focal.x * 100)}
              min={0}
              max={100}
              integer
              disabled={disabled}
              onCommit={(v) => set("focalPoint", { x: v / 100, y: focal.y }, "Reposition image")}
            />
            <NumberField
              label="Down"
              ariaLabel="Vertical position of the picture in its box"
              unit="%"
              value={Math.round(focal.y * 100)}
              min={0}
              max={100}
              integer
              disabled={disabled}
              onCommit={(v) => set("focalPoint", { x: focal.x, y: v / 100 }, "Reposition image")}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || element.focalPoint === undefined}
            onClick={() => set("focalPoint", undefined, "Centre image")}
          >
            Centre the picture
          </Button>
          <Hint>0% shows the left or top edge of the picture, 100% the right or bottom. The outlined area is what the slide shows.</Hint>
        </>
      ) : (
        <Hint>The whole picture is shown with this fit, so there is nothing to reposition.</Hint>
      )}
      {element.crop ? (
        <Hint>This picture carries a crop from another tool. The editor does not draw that crop; it shows the whole picture.</Hint>
      ) : null}

      <span className="dk-label">Replace picture</span>
      <Segmented
        label="When the new picture is a different shape"
        size="sm"
        value={box}
        onChange={setBox}
        items={[
          { value: "keep", label: "Keep this box", disabled },
          { value: "match", label: "Match new shape", disabled },
        ]}
      />
      <Button size="sm" disabled={disabled || busy} onClick={() => input.current?.click()} data-testid="image-replace">
        {busy ? "Uploading…" : "Choose a picture…"}
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void replace(file);
        }}
      />
      {message ? (
        <p className={message.tone === "error" ? "dk-field__hint dk-field__hint--error" : "dk-field__hint"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * Which part of the picture a `cover` box shows, as fractions of the picture —
 * the same geometry as CSS `object-fit: cover` with `object-position`.
 * Undefined when the picture's size is unknown or it is shown whole.
 */
export function visibleWindow(
  box: { width: number; height: number },
  asset: { width?: number; height?: number } | undefined,
  fit: string,
  focal: { x: number; y: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (fit !== "cover" || !asset?.width || !asset.height) return undefined;
  const boxRatio = box.width / box.height;
  const imageRatio = asset.width / asset.height;
  if (imageRatio > boxRatio) {
    const width = boxRatio / imageRatio;
    return { x: (1 - width) * focal.x, y: 0, width, height: 1 };
  }
  const height = imageRatio / boxRatio;
  return { x: 0, y: (1 - height) * focal.y, width: 1, height };
}

/**
 * The picture's mask (2026-10-13): the outline the picture shows through.
 *
 * The outline belongs to the box, not the photograph, so changing it keeps the
 * fit and the focal point, and turning it leaves the photograph upright.
 * Every change writes the whole `mask` once, so it is one undo step.
 */
function MaskControls({
  document,
  element,
  fit,
  disabled,
  edit,
}: {
  document: PresentationDocument;
  element: ImageElement;
  fit: string;
  disabled: boolean;
  edit: Edit;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState<string | undefined>();
  const mask = element.mask;
  const choice = maskChoice(mask);
  const write = (next: typeof mask, label: string, key = "mask") =>
    edit(setPropertyDeep(document, element.id, "mask", next), label, `inspector:${element.id}:${key}`);
  const label =
    choice === "custom" ? "Custom outline" : choice === "compound" ? "Combined outline" : MASK_CHOICES.find((entry) => entry.value === choice)?.label ?? String(choice);
  const warning = resolveImageMask(mask, element.transform.width, element.transform.height).warning;
  const note = maskExportNote(mask, fit);
  const rotation = mask && mask.type !== "shapeRef" ? mask.rotation ?? 0 : 0;
  const inverted = Boolean(mask && mask.type !== "shapeRef" && mask.invert);

  return (
    <>
      <div className="dk-field">
        <span className="dk-label">Mask</span>
        <Popover
          label="Mask shapes"
          align="end"
          open={open}
          onOpenChange={setOpen}
          className="dk-visualpicker"
          trigger={(props) => (
            <button type="button" className="dk-input dk-visualpicker__trigger" aria-label={`Mask: ${label}`} disabled={disabled} data-testid="image-mask" {...props}>
              <span className="dk-visualpicker__thumb">
                <MaskThumb choice={choice} mask={mask} />
              </span>
              {label}
            </button>
          )}
        >
          <div className="dk-library__grid" role="listbox" aria-label="Mask shape">
            {MASK_CHOICES.map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="option"
                aria-selected={entry.value === choice}
                aria-label={entry.label}
                title={entry.label}
                data-testid={`image-mask-${entry.value}`}
                className={cx("dk-library__add", entry.value === choice && "dk-visualpicker__on")}
                onClick={() => {
                  setOpen(false);
                  if (entry.value !== choice) write(maskWithChoice(mask, entry.value), entry.value === "none" ? "Remove image mask" : "Mask image");
                }}
              >
                <MaskThumb choice={entry.value} />
                <span className="dk-library__caption">{entry.label}</span>
              </button>
            ))}
          </div>
        </Popover>
      </div>

      {mask && mask.type !== "shapeRef" ? (
        <>
          <div className="dk-grid2">
            <NumberField
              label="Turn"
              ariaLabel="Mask rotation. The picture stays upright."
              unit="°"
              value={Math.round(rotation)}
              min={-360}
              max={360}
              integer
              disabled={disabled}
              onCommit={(value) => write(maskWithOptions(mask, { rotation: value }), "Turn image mask", "mask-rotation")}
            />
          </div>
          <Segmented
            label="Show the picture"
            size="sm"
            value={inverted ? "outside" : "inside"}
            onChange={(value) => write(maskWithOptions(mask, { invert: value === "outside" }), "Invert image mask")}
            items={[
              { value: "inside", label: "Inside the outline", disabled },
              { value: "outside", label: "Outside it", disabled, "data-testid": "image-mask-invert" },
            ]}
          />
        </>
      ) : null}

      <details className="dk-details">
        <summary>Custom outline</summary>
        <TextField
          label="Path, 0 to 1 across the box"
          value={path}
          placeholder="M0,1 L0,0.4 C0,0 1,0 1,0.4 L1,1 Z"
          onChange={(value) => {
            setPath(value);
            setPathError(undefined);
          }}
          error={pathError}
          disabled={disabled}
          data-testid="image-mask-path"
        />
        <Button
          size="sm"
          disabled={disabled || !path.trim()}
          onClick={() => {
            const result = maskWithPath(mask, path);
            if ("error" in result) setPathError(result.error);
            else write(result.mask, "Mask image");
          }}
        >
          Use this outline
        </Button>
      </details>

      {warning ? <Hint>{warning}</Hint> : null}
      {note ? <Hint>{note}</Hint> : null}
    </>
  );
}

/** A mask choice drawn from the outline the renderer will use, at thumbnail size. */
function MaskThumb({ choice, mask }: { choice: MaskChoice; mask?: ImageElement["mask"] }) {
  const definition = choice === "custom" || choice === "compound" ? mask : maskWithChoice(undefined, choice);
  const resolved = resolveImageMask(definition, 44, 28).mask;
  return (
    <svg viewBox="-2 -2 48 32" aria-hidden="true" className="dk-library__art">
      {resolved ? (
        resolved.paths.map((d, index) => (
          <path key={index} d={d} fill="currentColor" fillOpacity={resolved.invert ? 0.15 : 0.5} stroke="currentColor" strokeWidth="1.5" />
        ))
      ) : (
        <rect width={44} height={28} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
      )}
    </svg>
  );
}

/**
 * A subject cut-out (2026-10-13): a transparent copy of the photograph stacked
 * over it, so a person or product can stand in front of what sits behind them.
 * Deckastra does not cut backgrounds out yet; this takes the transparent PNG
 * someone made and lines it up exactly over its source. And a soft edge, for
 * a cut-out that would otherwise read as pasted on.
 */
function CutoutControls({
  document,
  element,
  disabled,
  edit,
}: {
  document: PresentationDocument;
  element: ImageElement;
  disabled: boolean;
  edit: Edit;
}) {
  const client = useWorkspaceClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | undefined>();
  const asset = document.assets.find((candidate) => candidate.id === element.assetId) as { derivedFrom?: string; hasAlpha?: boolean } | undefined;
  const source = asset?.derivedFrom ? (document.assets.find((candidate) => candidate.id === asset.derivedFrom) as { fileName?: string } | undefined) : undefined;
  const isSubject = element.layerRole === "subject";

  const add = async (file: File) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await uploadAndAddCutout(client, { document, sourceElementId: element.id, file });
      edit(result.operations, "Add a cut-out");
      setMessage(
        result.opaque
          ? { tone: "info", text: "That picture has no transparent background, so it will hide the picture behind it. Use a PNG with its background removed." }
          : { tone: "info", text: "The cut-out sits exactly over this picture. Put decorations between them with Depth: Behind the subject." },
      );
    } catch (caught) {
      setMessage({ tone: "error", text: caught instanceof Error ? caught.message : "That picture could not be used." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <NumberField
        label="Soften edge"
        ariaLabel="Soften the picture's edge, in pixels"
        unit="px"
        value={Math.round(element.edgeFeather ?? 0)}
        min={0}
        max={200}
        integer
        disabled={disabled}
        onCommit={(value) => edit(setPropertyDeep(document, element.id, "edgeFeather", value > 0 ? value : undefined), "Soften picture edge", `inspector:${element.id}:edgeFeather`)}
      />
      {isSubject ? (
        <Hint>
          {source ? `A cut-out of ${source.fileName ?? "another picture"}. ` : "The subject of this slide. "}
          {asset?.hasAlpha === false ? "Its picture has no transparent background." : "Objects marked Behind the subject sit between it and the scene."}
        </Hint>
      ) : (
        <>
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => input.current?.click()} data-testid="image-add-cutout">
            {busy ? "Uploading…" : "Add a cut-out of this picture…"}
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void add(file);
            }}
          />
          <Hint>A PNG of the same photograph with its background removed. It is placed exactly over this one, as the subject.</Hint>
        </>
      )}
      {message ? (
        <p className={message.tone === "error" ? "dk-field__hint dk-field__hint--error" : "dk-field__hint"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </>
  );
}

const BLEND_MODES = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "luminosity", label: "Luminosity" },
  { value: "color", label: "Colour" },
] as const;

const SLIDERS: readonly { key: TreatmentAmount; label: string; min: number }[] = [
  { key: "exposure", label: "Brightness", min: -100 },
  { key: "contrast", label: "Contrast", min: -100 },
  { key: "saturation", label: "Saturation", min: -100 },
  { key: "monochrome", label: "Black and white", min: 0 },
  { key: "vignette", label: "Vignette", min: 0 },
  { key: "grain", label: "Grain", min: 0 },
];

/**
 * A picture's treatment (2026-10-13): a few looks to start from, then each
 * adjustment on its own, a duotone in theme or named colours, and how the
 * picture blends with what is behind it. Every change is one undo step, and
 * Original removes the treatment, because the photograph was never changed.
 */
function TreatmentControls({
  document,
  element,
  disabled,
  edit,
}: {
  document: PresentationDocument;
  element: ImageElement;
  disabled: boolean;
  edit: Edit;
}) {
  const current = element.treatment;
  const presets = treatmentPresets(document);
  const preset = treatmentPreset(document, element);
  const write = (next: ImageElement["treatment"], label: string, key: string) =>
    edit(treatmentOperations(document, element.id, next), label, `inspector:${element.id}:treatment:${key}`);
  const blend = (element.style?.blendMode as string | undefined) ?? "normal";
  const note = treatmentExportNote(current);
  const duotone = current?.duotone;

  return (
    <details className="dk-details" open={current !== undefined || blend !== "normal" ? true : undefined}>
      <summary>Treatment</summary>
      <Select
        label="Look"
        value={preset}
        data-testid="image-treatment"
        options={[
          ...presets.map((entry) => ({ value: entry.value, label: entry.label })),
          ...(preset === "custom" ? [{ value: "custom", label: "Custom" }] : []),
        ]}
        disabled={disabled}
        onChange={(value) => {
          const chosen = presets.find((entry) => entry.value === value);
          if (chosen) write(chosen.treatment ? treatmentWith(chosen.treatment, {}) : undefined, chosen.value === "none" ? "Remove picture treatment" : "Treat picture", "preset");
        }}
      />
      <div className="dk-grid2">
        {SLIDERS.map(({ key, label, min }) => (
          <NumberField
            key={key}
            label={label}
            ariaLabel={`${label} of the picture`}
            unit="%"
            value={treatmentPercent(element, key)}
            min={min}
            max={100}
            integer
            disabled={disabled}
            data-testid={`image-treatment-${key}`}
            onCommit={(value) => write(treatmentWith(current, { [key]: value / 100 }), `Change picture ${label.toLowerCase()}`, key)}
          />
        ))}
      </div>
      {duotone ? (
        <div className="dk-grid2">
          <ColorField
            label="Duotone shadows"
            value={duotone[0]}
            theme={document.theme}
            disabled={disabled}
            onChange={(value) => value && write(treatmentWith(current, { duotone: [value, duotone[1]!] }), "Change duotone", "duotone")}
          />
          <ColorField
            label="Duotone highlights"
            value={duotone[1]}
            theme={document.theme}
            disabled={disabled}
            onChange={(value) => value && write(treatmentWith(current, { duotone: [duotone[0]!, value] }), "Change duotone", "duotone")}
          />
        </div>
      ) : null}
      <Select
        label="Blend with what is behind"
        value={blend}
        options={BLEND_MODES.map((entry) => ({ value: entry.value, label: entry.label }))}
        disabled={disabled}
        data-testid="image-blend"
        onChange={(value) =>
          edit(setPropertyDeep(document, element.id, "style.blendMode", value === "normal" ? undefined : value), "Change blend mode", `inspector:${element.id}:blendMode`)
        }
      />
      {blend !== "normal" ? <Hint>PowerPoint has no blend modes, so the picture arrives there blending normally.</Hint> : null}
      {note ? <Hint>{note}</Hint> : null}
    </details>
  );
}
