import { useRef, useState } from "react";
import type { ImageElement, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import { uploadAndReplaceImage } from "../../lib/insert-image";
import { Button, NumberField, Section, Segmented, Select } from "../../ui";
import { Hint } from "./controls";

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
