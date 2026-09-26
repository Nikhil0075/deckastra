import { useRef, useState } from "react";
import type { BackgroundDefinition, Paint, PatchOperation } from "@deckastra/presentation-schema";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";

import { manifestOperations, uploadPicture } from "../../lib/insert-image";
import type { EditorApi } from "../../lib/useEditor";
import { Button, NumberField, Section, Segmented, Select } from "../../ui";
import { ColorField, Hint } from "./controls";
import { PaintField, paintPreview } from "./paint";

/**
 * The slide's background (Design tab review, 2026-09-26).
 *
 * The schema always had one (`BackgroundDefinition`: a paint, a picture with a
 * scrim and a blur) and nothing in the editor could set it, so every slide wore
 * whatever the generator or the theme gave it. Theme default is the absence of
 * a background, which the renderer draws in the theme's own background colour,
 * so a deck that is re-themed later follows the new theme.
 *
 * One patch per change, so each is one undo step, and "Apply to every slide"
 * is one patch across the deck.
 */
export function BackgroundSection({ editor, defaultOpen }: { editor: EditorApi; defaultOpen?: boolean }) {
  const client = useWorkspaceClient();
  const doc = editor.document;
  const slide = doc.slides[editor.slideIndex];
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (!slide) return null;

  const background = slide.background as BackgroundDefinition | undefined;
  const kind = !background ? "theme" : background.assetId ? "picture" : "paint";
  const pictures = doc.assets.filter((asset) => asset.type === "image");

  const write = (next: BackgroundDefinition | undefined, label: string, extra: PatchOperation[] = []) => {
    const path = `/slides/id:${slide.id}/background`;
    const operation: PatchOperation | undefined =
      next === undefined
        ? background === undefined
          ? undefined
          : { op: "remove", path }
        : { op: background === undefined ? "add" : "replace", path, value: next };
    const operations = [...extra, ...(operation ? [operation] : [])];
    if (operations.length > 0) editor.apply(operations, { label });
  };

  const choosePicture = (assetId: string, extra: PatchOperation[] = []) =>
    write({ assetId, fit: "cover", ...(background?.overlay ? { overlay: background.overlay } : {}) }, "Set background picture", extra);

  const upload = async (file: File) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const asset = await uploadPicture(client, file);
      choosePicture(asset.id, manifestOperations(editor.document, asset));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The picture could not be uploaded.");
    } finally {
      setBusy(false);
    }
  };

  const applyToAll = () => {
    const operations: PatchOperation[] = [];
    for (const other of doc.slides) {
      if (other.id === slide.id) continue;
      const path = `/slides/id:${other.id}/background`;
      if (background === undefined) {
        if (other.background !== undefined) operations.push({ op: "remove", path });
      } else {
        operations.push({ op: other.background === undefined ? "add" : "replace", path, value: structuredClone(background) });
      }
    }
    if (operations.length > 0) {
      editor.apply(operations, { label: "Use this background on every slide" });
      setMessage(`Applied to ${doc.slides.length - 1} other slide${doc.slides.length === 2 ? "" : "s"}.`);
    }
  };

  const summary =
    kind === "theme" ? "Theme" : kind === "picture" ? "Picture" : background?.paint?.type === "solid" ? "Colour" : "Gradient";

  return (
    <Section title="Slide background" meta={summary} defaultOpen={defaultOpen}>
      <span
        className="dk-background__preview"
        aria-hidden="true"
        style={{ background: kind === "theme" ? paintPreview(doc.theme, { type: "solid", color: "token:colors.background" }) : paintPreview(doc.theme, background?.paint as Paint | undefined) }}
      />
      <Segmented
        label="Background type"
        size="sm"
        value={kind}
        onChange={(next) => {
          if (next === kind) return;
          if (next === "theme") write(undefined, "Use the theme background");
          else if (next === "paint") write({ paint: { type: "solid", color: "token:colors.surface" } }, "Set background colour");
          else if (pictures[0]) choosePicture(pictures[0].id);
          else input.current?.click();
        }}
        items={[
          { value: "theme", label: "Theme" },
          { value: "paint", label: "Colour" },
          { value: "picture", label: "Picture" },
        ]}
      />

      {kind === "paint" ? (
        <PaintField
          label="Background"
          value={background?.paint as Paint | undefined}
          theme={doc.theme}
          data-testid="background-paint"
          onChange={(paint) => write(paint && paint.type !== "none" ? { ...background, paint } : undefined, "Change background")}
        />
      ) : null}

      {kind === "picture" ? (
        <>
          <Select
            label="Picture"
            value={background?.assetId ?? ""}
            options={pictures.map((asset) => ({ value: asset.id, label: (asset as { fileName?: string }).fileName ?? asset.id }))}
            onChange={(assetId) => choosePicture(assetId)}
          />
          <Segmented
            label="Picture fit"
            size="sm"
            value={background?.fit === "contain" ? "contain" : "cover"}
            onChange={(fit) => write({ ...background, fit }, "Change background fit")}
            items={[
              { value: "cover", label: "Fill" },
              { value: "contain", label: "Fit" },
            ]}
          />
          <ColorField
            label="Scrim"
            value={background?.overlay?.type === "solid" ? (background.overlay.color as string) : undefined}
            theme={doc.theme}
            allowNone
            onChange={(color) => {
              const next = { ...background } as BackgroundDefinition;
              if (color) next.overlay = { type: "solid", color };
              else delete next.overlay;
              write(next, color ? "Add a scrim over the picture" : "Remove the scrim");
            }}
          />
          <Hint>A scrim is a see-through colour over the picture, so text on it stays readable. Use a custom colour with transparency, such as #00000080.</Hint>
          <NumberField
            label="Blur"
            ariaLabel="Background picture blur"
            value={background?.blur ?? 0}
            min={0}
            max={60}
            unit="px"
            onCommit={(blur) => {
              const next = { ...background } as BackgroundDefinition;
              if (blur > 0) next.blur = blur;
              else delete next.blur;
              write(next, "Blur the background picture");
            }}
          />
        </>
      ) : null}

      <div className="dk-background__actions">
        <Button size="sm" variant="ghost" icon="upload" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Upload picture…"}
        </Button>
        <Button size="sm" variant="ghost" onClick={applyToAll} disabled={doc.slides.length < 2} data-testid="background-apply-all">
          Apply to every slide
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {message ? (
        <p className="dk-field__hint" role="status">
          {message}
        </p>
      ) : null}
    </Section>
  );
}
