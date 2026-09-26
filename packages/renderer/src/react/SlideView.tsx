import { memo, type CSSProperties, type ReactNode } from "react";

import { flattenScene, type SceneNode, type SlideScene } from "../scene";
import { ElementContent, positionStyle } from "./elements";

/**
 * Slide renderer.
 *
 * Renders one scene at logical size. The slide root is scaled by a *single* CSS
 * transform (doc 04 §4.2), so every child stays in logical units and no element
 * is ever individually re-scaled to fit a viewport.
 */

export type RenderMode = "editor" | "present" | "export";

export interface SlideViewProps {
  scene: SlideScene;
  /**
   * "export" is not a cosmetic flag. Editor chrome is excluded structurally —
   * the subtree is never mounted — rather than hidden with CSS, because a CSS
   * guard that someone later overrides puts selection handles in a customer's
   * PDF (doc 04 §9.1).
   */
  mode?: RenderMode;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Show the safe area and out-of-bounds markers. Editor and debugging only. */
  showGuides?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function SlideView({
  scene,
  mode = "present",
  resolveAssetUrl,
  showGuides = false,
  className,
  style,
  children,
}: SlideViewProps): ReactNode {
  const nodes = flattenScene(scene);

  // Paint order is the zPath sort computed at scene-build time. Rendering in that
  // order and assigning z-index from the resulting index gives one global stacking
  // order across every element, which is what doc 04 §8.3 requires. The spacing of
  // 10 leaves room to insert without renumbering everything.
  const paintIndex = new Map(scene.paintOrder.map((id, i) => [id, i * 10]));

  const background = scene.background;

  return (
    <div
      className={className}
      data-deckastra-slide={scene.slideId}
      style={{
        position: "relative",
        width: scene.width,
        height: scene.height,
        overflow: "hidden",
        // Contain layout and paint so a slide can never affect anything outside
        // its own box, and so the browser can skip work for offscreen slides.
        contain: "layout paint",
        background: background?.gradient ?? background?.color ?? "transparent",
        ...style,
      }}
    >
      {/* Background layer (doc 04 §3.2). Separate from content so a full-bleed
          image and its scrim are not selectable objects a user deletes by accident. */}
      {background?.assetId ? (
        <div
          data-layer="background"
          style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }}
        >
          <img
            src={resolveAssetUrl?.(background.assetId)}
            alt=""
            draggable={false}
            // See `elements.tsx`: a headless render attributes a failed decode
            // to an asset by reading this back off the page.
            data-asset-id={background.assetId}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: background.blur ? `blur(${background.blur}px)` : undefined,
            }}
          />
        </div>
      ) : null}

      {background?.overlay ? (
        <div
          data-layer="background"
          style={{ position: "absolute", inset: 0, zIndex: 1, background: background.overlay, pointerEvents: "none" }}
          aria-hidden="true"
        />
      ) : null}

      {scene.fontFaces?.length ? <FontFaces faces={scene.fontFaces} resolveAssetUrl={resolveAssetUrl} /> : null}

      {nodes.map((node) => (
        <SceneNodeView
          key={node.id}
          node={node}
          zIndex={paintIndex.get(node.id) ?? 0}
          mode={mode}
          resolveAssetUrl={resolveAssetUrl}
        />
      ))}

      {showGuides && mode !== "export" && scene.safeArea ? (
        <div
          data-deckastra-chrome=""
          aria-hidden="true"
          style={{
            position: "absolute",
            left: scene.safeArea.left,
            top: scene.safeArea.top,
            right: scene.safeArea.right,
            bottom: scene.safeArea.bottom,
            border: "1px dashed rgba(120,180,255,0.5)",
            pointerEvents: "none",
            zIndex: 100000,
          }}
        />
      ) : null}

      {/* Chrome is never mounted in export mode. Not hidden — absent. */}
      {mode !== "export" ? children : null}
    </div>
  );
}

/**
 * One scene node, memoized on the node's identity (doc 04 §31.2).
 *
 * This is the single most load-bearing performance decision in the renderer. A
 * drag rebuilds the scene's node array every frame, but only the dragged node is
 * a new object — every other node is the same reference it was last frame. React
 * therefore skips them, and a 120-object slide costs one element's work per
 * frame instead of a hundred and twenty.
 *
 * Memoizing on deep equality of props would give up all of it: the comparison
 * would cost more than the render it avoids. The scene builder's discipline of
 * preserving node identity for untouched nodes is what makes the shallow
 * comparison correct, so the two have to change together.
 */
const SceneNodeView = memo(function SceneNodeView({
  node,
  zIndex,
  mode,
  resolveAssetUrl,
}: {
  node: SceneNode;
  zIndex: number;
  mode: RenderMode;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}): ReactNode {
  // `visible: false` is excluded from render AND from export, which is why a
  // fade-in must start from opacity 0 instead (doc 02 §8.2).
  if (node.flags.hidden) return null;

  return (
    <div
      data-element-id={node.id}
      data-layer={node.layer}
      data-role={node.semanticRole}
      style={positionStyle(node, zIndex, mode === "editor")}
      aria-label={node.a11y.label}
      role={node.a11y.role === "presentation" ? "presentation" : undefined}
    >
      {/* A group draws no content of its own — its children are separate scene
          nodes — but its wrapper still carries fill, stroke and radius, which is
          how a styled card renders at all. */}
      <ElementContent node={node} resolveAssetUrl={resolveAssetUrl} />
    </div>
  );
});

export interface ScaledSlideProps extends SlideViewProps {
  /** Rendered width in CSS pixels. Height follows from the slide aspect ratio. */
  width: number;
}

/**
 * A slide scaled to fit a given width.
 *
 * The scale is applied once, on the root. Scaling children individually is what
 * produces blurry glyphs and drifting geometry (doc 04 §4.3).
 */
export function ScaledSlide({ width, scene, style, ...rest }: ScaledSlideProps): ReactNode {
  const scale = width / scene.width;
  const height = scene.height * scale;

  return (
    <div style={{ width, height, position: "relative", overflow: "hidden", ...style }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        <SlideView scene={scene} {...rest} />
      </div>
    </div>
  );
}

/**
 * The deck's own fonts, declared where the slide is drawn.
 *
 * Resolved through the same `resolveAssetUrl` as pictures, so the editor gets
 * an authenticated URL and an export gets the bytes as a `data:` URL, and the
 * render host still fetches nothing. A face whose bytes did not arrive is
 * skipped: the text then draws in its fallback, which the export report names.
 */
function FontFaces({
  faces,
  resolveAssetUrl,
}: {
  faces: NonNullable<SlideScene["fontFaces"]>;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}): ReactNode {
  const rules = faces
    .map((face) => {
      const url = resolveAssetUrl?.(face.assetId, face.storageKey);
      if (!url) return "";
      const family = face.family.replace(/["\\\n]/g, "");
      return (
        `@font-face{font-family:"${family}";src:url("${url.replace(/["\\]/g, "")}");` +
        `font-weight:${/^\d{1,4}( \d{1,4})?$/.test(face.weight ?? "") ? face.weight : "100 900"};` +
        `font-style:${face.style === "italic" ? "italic" : "normal"};font-display:block}`
      );
    })
    .join("");
  return rules ? <style data-deckastra-fonts="">{rules}</style> : null;
}
