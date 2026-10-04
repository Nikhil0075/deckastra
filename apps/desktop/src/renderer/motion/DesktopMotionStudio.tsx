import { useMemo, useState } from "react";
import {
  newId,
  walkElements,
  type AnimationTrack,
  type PatchOperation,
  type PresentationDocument,
  type PresentationElement,
} from "@deckastra/presentation-schema";
import { PRESETS, PRESET_NAMES, compileTimeline, type PresetDefinition } from "@deckastra/animation-engine";
import { flattenScene } from "@deckastra/renderer";
import {
  duplicateSlideWithMagicMoveAction,
  MotionModePanel,
  type MotionAuthoringExtension,
  type MotionAuthoringPanelProps,
} from "@deckastra/editor-ui";
import { Button, Section, Segmented, StatusChip } from "@deckastra/editor-ui/ui";

import "./desktop-motion.css";

type Category = "entrance" | "emphasis" | "loop" | "exit";
type When = "slideEnter" | "click" | "withPrevious" | "afterPrevious";
type Speed = "quick" | "normal" | "slow";

const SPEED_MS: Record<Speed, number> = { quick: 240, normal: 420, slow: 700 };
const CATEGORY_LABEL: Record<Category, string> = {
  entrance: "Entrance",
  emphasis: "Emphasis",
  loop: "Loop",
  exit: "Exit",
};

const STYLES = {
  Calm: { transition: "fade", transitionMs: 350, preset: "fade", durationMs: 420 },
  Crisp: { transition: "slide", transitionMs: 300, preset: "slide", durationMs: 280 },
  Playful: { transition: "push", transitionMs: 450, preset: "scale", durationMs: 420, loop: "float" },
  Cinematic: { transition: "zoom", transitionMs: 700, preset: "blurReveal", durationMs: 700, loop: "kenBurns" },
  Keynote: { transition: "fade", transitionMs: 350, preset: "maskReveal", durationMs: 500, preserveMorph: true },
} as const;

function pathFor(slideId: string, property: string): string {
  return `/slides/id:${slideId}/${property}`;
}

function writeProperty(slide: PresentationDocument["slides"][number], property: string, value: unknown): PatchOperation {
  return {
    op: Object.prototype.hasOwnProperty.call(slide, property) ? "replace" : "add",
    path: pathFor(slide.id, property),
    value,
  } as PatchOperation;
}

function trigger(type: When): AnimationTrack["trigger"] {
  if (type === "click") return { type: "click" };
  return { type };
}

function plainText(element: PresentationElement): string {
  if (element.type !== "text") return "";
  const content = (element as { content?: { blocks?: { spans?: { text?: string }[] }[] } }).content;
  return (content?.blocks ?? []).flatMap((block) => block.spans ?? []).map((span) => span.text ?? "").join(" ");
}

function segmentCount(text: string, granularity: "word" | "grapheme"): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: "word" | "grapheme" }) => { segment(value: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
  if (!Segmenter) return granularity === "word" ? text.trim().split(/\s+/).filter(Boolean).length : Array.from(text).length;
  const parts = [...new Segmenter(undefined, { granularity }).segment(text)];
  return granularity === "word" ? parts.filter((part) => part.isWordLike).length : parts.length;
}

function effectLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function tracksFor(
  element: PresentationElement,
  preset: string,
  when: When,
  speed: Speed,
  preview = false,
): AnimationTrack[] {
  const definition = PRESETS[preset];
  const loop = definition?.category === "loop";
  const exit = definition?.category === "exit";
  const durationMs = loop ? Math.max(1800, SPEED_MS[speed] * 6) : SPEED_MS[speed];
  const baseClip = () => ({
    id: newId("clp"),
    preset,
    startMs: 0,
    durationMs,
    easing: loop ? "easeInOut" : "emphasized",
    ...(loop ? {
      repeat: -1,
      direction: (["spin", "marquee", "shimmer"].includes(preset) ? "normal" : "alternate") as "normal" | "alternate",
      restOffset: 0,
    } : {}),
    ...(exit ? { fill: "forwards" as const } : {}),
  });

  const text = plainText(element);
  const granular = preset === "byWord" ? "word" : preset === "byLetter" || preset === "typewriter" ? "grapheme" : null;
  if (granular && text) {
    const count = segmentCount(text, granular);
    return [{
      id: newId("anm"),
      targetId: element.id,
      trigger: trigger(preview ? "slideEnter" : when),
      clips: [{
        ...baseClip(),
        presetParams: { segmentCount: Math.min(count, 160) },
      }],
    }];
  }

  return [{
    id: newId("anm"),
    targetId: element.id,
    ...(["glow", "shimmer", "gradientDrift"].includes(preset) ? { subTarget: `effect/${preset}` } : {}),
    trigger: trigger(preview ? "slideEnter" : when),
    clips: [baseClip()],
  }];
}

function defaultPreset(element: PresentationElement, category: Category): string {
  if (category === "loop") return element.type === "image" ? "kenBurns" : "float";
  if (category === "exit") return "fadeOut";
  if (category === "emphasis") return element.type === "shape" ? "pop" : "pulse";
  switch (element.type) {
    case "text": return "byWord";
    case "image": return "fade";
    case "icon":
    case "line":
    case "diagram": return "drawPath";
    case "chart":
    case "table":
    case "group": return "staggerReveal";
    case "shape": return "scale";
    default: return "fade";
  }
}

function styleOperations(document: PresentationDocument, name: keyof typeof STYLES): PatchOperation[] {
  const style = STYLES[name];
  const operations: PatchOperation[] = [];
  document.slides.forEach((slide, slideIndex) => {
    const existing = slide.animations ?? [];
    const animated = new Set(existing.map((track) => track.targetId));
    const additions: AnimationTrack[] = slide.elements
      .filter((element) => !animated.has(element.id))
      .map((element, index) => ({
      id: newId("anm"),
      targetId: element.id,
      trigger: index === 0 ? { type: "slideEnter" } : { type: "afterPrevious" },
      clips: [{ id: newId("clp"), preset: style.preset, startMs: 0, durationMs: style.durationMs, easing: "emphasized" }],
    }));
    if ("loop" in style) {
      const hasLoop = existing.some((track) => track.clips.some((clip) => clip.repeat === -1));
      const ambient = slide.elements.find((element) => name === "Cinematic"
        ? element.type === "image" && element.transform.width * element.transform.height >= document.viewport.width * document.viewport.height * 0.12
        : element.semanticRole === "decoration" || element.type === "image");
      if (ambient && !hasLoop && !animated.has(ambient.id)) additions.push(...tracksFor(ambient, style.loop, "slideEnter", "slow"));
    }
    if (additions.length) operations.push(writeProperty(slide, "animations", [...existing, ...additions]));
    // A style fills an unset transition; explicit authoring, especially a saved
    // Magic Move pairing, is never overwritten.
    if (slideIndex > 0 && !slide.transition) {
      operations.push(writeProperty(slide, "transition", {
        type: style.transition,
        durationMs: style.transitionMs,
        easing: "easeInOut",
        ...(style.transition === "slide" ? { direction: "left" } : {}),
      }));
    }
  });
  return operations;
}

function removeAllMotion(document: PresentationDocument): PatchOperation[] {
  return document.slides.flatMap((slide) => [
    ...(slide.animations ? [{ op: "remove", path: pathFor(slide.id, "animations") } as PatchOperation] : []),
    ...(slide.transition ? [{ op: "remove", path: pathFor(slide.id, "transition") } as PatchOperation] : []),
  ]);
}

function selectedElement(props: MotionAuthoringPanelProps): PresentationElement | undefined {
  const id = props.editor.selection.primaryId;
  if (!id) return undefined;
  const slide = props.editor.document.slides[props.editor.slideIndex];
  return slide ? [...walkElements(slide.elements)].find((entry) => entry.element.id === id)?.element : undefined;
}

export function DesktopMotionPanel(props: MotionAuthoringPanelProps) {
  const { editor } = props;
  const slide = editor.document.slides[editor.slideIndex];
  const selected = selectedElement(props);
  const [category, setCategory] = useState<Category>("entrance");
  const [when, setWhen] = useState<When>("slideEnter");
  const [speed, setSpeed] = useState<Speed>("normal");
  const [copied, setCopied] = useState<AnimationTrack[] | null>(null);

  const catalog = useMemo(() => Object.values(PRESETS)
    .filter((preset) => preset.category === category)
    .sort((a, b) => {
      if (!selected) return a.name.localeCompare(b.name);
      const preferred = defaultPreset(selected, category);
      return Number(b.name === preferred) - Number(a.name === preferred) || a.name.localeCompare(b.name);
    }), [category, selected]);

  const timeline = useMemo(() => slide && props.scene.slides[editor.slideIndex]
    ? compileTimeline(props.scene.slides[editor.slideIndex]!, slide.animations ?? [])
    : null, [slide, props.scene.slides, editor.slideIndex]);

  const applyPreset = (preset: string) => {
    if (!slide || !selected) return;
    const tracks = tracksFor(selected, preset, when, speed);
    editor.apply([writeProperty(slide, "animations", [...(slide.animations ?? []), ...tracks])], {
      label: `Add ${preset}`,
    });
    props.preview(undefined);
  };

  const copyMotion = () => {
    if (!slide || !selected) return;
    setCopied(structuredClone((slide.animations ?? []).filter((track) => track.targetId === selected.id)));
  };
  const pasteMotion = (targets: PresentationElement[]) => {
    if (!copied?.length) return;
    const additions = new Map<string, AnimationTrack[]>();
    for (const target of targets) {
      const targetSlide = editor.document.slides.find((candidate) => [...walkElements(candidate.elements)].some((entry) => entry.element.id === target.id));
      if (!targetSlide) continue;
      for (const original of copied) {
        const track = structuredClone(original);
        track.id = newId("anm");
        track.targetId = target.id;
        track.clips = track.clips.map((clip) => ({ ...clip, id: newId("clp") }));
        const pending = additions.get(targetSlide.id) ?? [];
        pending.push(track);
        additions.set(targetSlide.id, pending);
      }
    }
    const operations = [...additions].map(([slideId, tracks]) => {
      const targetSlide = editor.document.slides.find((candidate) => candidate.id === slideId)!;
      return writeProperty(targetSlide, "animations", [...(targetSlide.animations ?? []), ...tracks]);
    });
    if (operations.length) editor.apply(operations, { label: "Paste motion" });
  };

  const magicMove = () => {
    const action = duplicateSlideWithMagicMoveAction(editor.document, editor.slideIndex);
    if (!action) return;
    editor.apply(action.operations, { label: action.label });
    editor.setSlideIndex(action.index);
  };

  const fixExtraLoops = () => {
    if (!slide) return;
    const loopTracks = (slide.animations ?? []).filter((track) => track.clips.some((clip) => clip.repeat === -1));
    const operations = loopTracks.slice(2).map((track) => ({ op: "remove", path: `${pathFor(slide.id, "animations")}/id:${track.id}` } as PatchOperation));
    if (operations.length) editor.apply(operations, { label: "Keep two ambient loops" });
  };

  const removeProblemLoop = (clipId?: string) => {
    if (!slide || !clipId) return;
    const next = (slide.animations ?? []).flatMap((track) => {
      const clips = track.clips.filter((clip) => clip.id !== clipId);
      return clips.length ? [{ ...track, clips }] : [];
    });
    editor.apply([writeProperty(slide, "animations", next)], { label: "Remove costly loop" });
  };

  const makeAutomaticMotionFinite = () => {
    if (!slide?.animations) return;
    const animations = slide.animations.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (["click", "hover", "marker"].includes(track.trigger.type)) return clip;
        const iterations = clip.repeat === -1 ? Infinity : (clip.repeat ?? 0) + 1;
        if (iterations !== Infinity && clip.durationMs * iterations <= 5_000) return clip;
        return { ...clip, durationMs: Math.min(clip.durationMs, 5_000), repeat: 0 };
      }),
    }));
    editor.apply([writeProperty(slide, "animations", animations)], { label: "Stop automatic loops" });
  };

  if (!slide) return null;
  return (
    <div className="dk-modepanel dk-desktop-motion" data-testid="desktop-motion-studio">
      <Section title="Motion style" defaultOpen>
        <div className="dk-desktop-motion__styles">
          {(Object.keys(STYLES) as (keyof typeof STYLES)[]).map((name) => (
            <button key={name} className="dk-desktop-motion__style" data-testid={`motion-style-${name.toLowerCase()}`}
              onClick={() => editor.apply(styleOperations(editor.document, name), { label: `Motion style: ${name}` })}>
              <strong>{name}</strong><span>{effectLabel(STYLES[name].preset)}</span>
            </button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={() => {
          const operations = removeAllMotion(editor.document);
          if (operations.length) editor.apply(operations, { label: "Remove all motion" });
        }}>Remove all motion</Button>
      </Section>

      <Section title="Selected object" defaultOpen>
        {!selected ? <p className="dk-muted">Select an object to choose an effect.</p> : (
          <>
            <Button size="sm" variant="secondary" onClick={() => applyPreset(defaultPreset(selected, category))}>
              Apply suggested: {effectLabel(defaultPreset(selected, category))}
            </Button>
            <Segmented label="Effect category" value={category} size="sm" items={(Object.keys(CATEGORY_LABEL) as Category[]).map((value) => ({ value, label: CATEGORY_LABEL[value] }))} onChange={setCategory} />
            <Segmented label="When" value={when} className="dk-desktop-motion__when" size="sm" onChange={setWhen} items={[
              { value: "slideEnter", label: "On slide start" }, { value: "click", label: "On click" },
              { value: "withPrevious", label: "With previous" }, { value: "afterPrevious", label: "After previous" },
            ]} />
            <Segmented label="Speed" value={speed} data-testid="motion-speed" size="sm" onChange={setSpeed} items={[
              { value: "quick", label: "Quick" }, { value: "normal", label: "Normal" }, { value: "slow", label: "Slow" },
            ]} />
            <div className="dk-desktop-motion__gallery">
              {catalog.map((preset: PresetDefinition) => (
                <button key={preset.name} className="dk-desktop-motion__effect" data-preset={preset.name} data-category={preset.category} data-testid={`effect-tile-${preset.name}`}
                  onMouseEnter={() => props.preview(tracksFor(selected, preset.name, "slideEnter", speed, true))}
                  onMouseLeave={() => props.preview(undefined)} onFocus={() => props.preview(tracksFor(selected, preset.name, "slideEnter", speed, true))}
                  onBlur={() => props.preview(undefined)} onClick={() => applyPreset(preset.name)}>
                  <span className="dk-desktop-motion__effect-preview" aria-hidden="true"><i /></span>
                  <strong>{effectLabel(preset.name)}</strong><small>{preset.description}</small>
                </button>
              ))}
            </div>
            <div className="dk-desktop-motion__actions">
              <Button size="sm" variant="secondary" onClick={copyMotion}>Copy motion</Button>
              <Button size="sm" variant="secondary" disabled={!copied} onClick={() => pasteMotion([selected])}>Paste motion</Button>
              <Button size="sm" variant="secondary" disabled={!copied || !selected.semanticRole} onClick={() => {
                const similar = editor.document.slides.flatMap((candidate) => [...walkElements(candidate.elements)].map((entry) => entry.element))
                  .filter((element) => element.id !== selected.id && element.semanticRole === selected.semanticRole);
                pasteMotion(similar);
              }}>Apply to all similar</Button>
            </div>
          </>
        )}
      </Section>

      <Section title="Magic Move" defaultOpen>
        <Button size="sm" variant="primary" icon="duplicate" onClick={magicMove} data-testid="duplicate-magic-move">Duplicate and Magic Move</Button>
      </Section>

      <Section title="Motion check" defaultOpen>
        {!timeline?.warnings.length ? <p className="dk-muted">No motion issues on this slide.</p> : (
          <ul className="dk-desktop-motion__check">
            {timeline.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>
              <StatusChip tone={warning.code === "W140" || warning.code === "W141" ? "waiting" : "neutral"}>{warning.code}</StatusChip>
              <span>{warning.message}</span>
              {warning.code === "W140" ? <Button size="sm" variant="secondary" onClick={fixExtraLoops}>Keep two</Button> : null}
              {warning.code === "W141" ? <Button size="sm" variant="secondary" onClick={() => removeProblemLoop(warning.clipId)}>Remove loop</Button> : null}
              {warning.code === "W142" ? <Button size="sm" variant="secondary" onClick={makeAutomaticMotionFinite}>Make finite</Button> : null}
            </li>)}
          </ul>
        )}
      </Section>
      <MotionModePanel
        embedded
        editor={editor}
        presentationId={props.presentationId}
        scene={props.scene}
        resolveAssetUrl={props.resolveAssetUrl}
      />
    </div>
  );
}

function DesktopMotionOverlay({ editor, scene }: Omit<MotionAuthoringPanelProps, "preview">) {
  const slide = editor.document.slides[editor.slideIndex];
  const slideScene = scene.slides[editor.slideIndex];
  if (!slide || !slideScene) return null;
  const order = new Map<string, { index: number; loop: boolean }>();
  (slide.animations ?? []).forEach((track, index) => {
    const current = order.get(track.targetId);
    order.set(track.targetId, {
      index: current?.index ?? index + 1,
      loop: Boolean(current?.loop || track.clips.some((clip) => clip.repeat === -1)),
    });
  });
  if (!order.size) return null;
  return <div data-deckastra-chrome="" aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 100001 }}>
    {flattenScene(slideScene).flatMap((node) => {
      const badge = order.get(node.id);
      if (!badge) return [];
      return <span key={node.id} data-motion-badge={node.id} style={{
        position: "absolute", left: node.bounds.x - 10, top: node.bounds.y - 10,
        minWidth: 22, height: 22, padding: "0 6px", borderRadius: 11,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
        background: "var(--dk-blue)", color: "var(--dk-on-blue)", font: "600 12px/1 system-ui", boxShadow: "none",
      }}>
        {badge.index}{badge.loop ? <span data-motion-loop="">∞</span> : null}
      </span>;
    })}
  </div>;
}

export const desktopMotionAuthoring: MotionAuthoringExtension = {
  Panel: DesktopMotionPanel,
  CanvasOverlay: DesktopMotionOverlay,
  presetNames: PRESET_NAMES,
};
