import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { colorRamp, hexToHsv, hsvToHex, hueHex, type Hsv } from "../../lib/color-math";
import { cx } from "../../ui";

/**
 * Choosing a colour by looking at it (colour ramp, 2026-09-26).
 *
 * A square of brightness against vividness, a hue strip under it, and a ramp of
 * the current colour from light to dark. Typing "#1E4BD2" is how a developer
 * picks a colour; a person picks the blue that looks right. The hex field stays
 * beside this for whoever has a brand guide open.
 *
 * Dragging previews locally and commits once, on release, so a drag across the
 * square is one Undo step rather than two hundred. The arrow keys move the
 * handle and commit each step, which is what a keyboard user expects: the
 * square is a two-dimensional slider (Shift moves further).
 */
export interface ColorRampProps {
  label: string;
  /** A hex; anything else (a token that does not resolve) starts the picker at grey. */
  value: string | undefined;
  onCommit: (hex: string) => void;
  disabled?: boolean;
  /**
   * Offer an opacity strip. The result is then an 8-digit hex when it is not
   * fully opaque — what the schema already stores for a translucent colour, and
   * what a glass card is made of.
   */
  alpha?: boolean;
}

function alphaOf(hex: string | undefined): number {
  const match = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(hex ?? "");
  return match ? parseInt(match[1]!, 16) / 255 : 1;
}

function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return byte >= 255 ? hex : `${hex}${byte.toString(16).padStart(2, "0").toUpperCase()}`;
}

const START: Hsv = { h: 220, s: 0.6, v: 0.8 };

export function ColorRamp({ label, value, onCommit, disabled, alpha: withOpacity }: ColorRampProps) {
  const [hsv, setHsv] = useState<Hsv>(() => (value && hexToHsv(value)) || START);
  const [opacity, setOpacity] = useState(() => alphaOf(value));
  const dragging = useRef(false);
  const area = useRef<HTMLDivElement>(null);

  // A new value from outside (another control, undo) moves the handle, unless
  // this picker is the one being dragged.
  useEffect(() => {
    if (dragging.current || !value) return;
    const next = hexToHsv(value);
    setOpacity(alphaOf(value));
    if (next && hsvToHex(next) !== hsvToHex(hsv)) {
      // Keep the hue when the colour is a grey: a grey has no hue, and resetting
      // it to red on every grey would move the strip under the person's hand.
      setHsv(next.s === 0 ? { ...next, h: hsv.h } : next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const current = hsvToHex(hsv);
  const commit = (next: Hsv, nextOpacity = opacity) => {
    const hex = withOpacity ? withAlpha(hsvToHex(next), nextOpacity) : hsvToHex(next);
    if (hex !== (value ?? "").toUpperCase()) onCommit(hex);
  };

  const fromPointer = (event: PointerEvent<HTMLDivElement>): Hsv => {
    const rect = area.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
    return { h: hsv.h, s, v };
  };

  const onAreaKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const delta = move[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = { h: hsv.h, s: Math.min(1, Math.max(0, hsv.s + delta[0])), v: Math.min(1, Math.max(0, hsv.v + delta[1])) };
    setHsv(next);
    commit(next);
  };

  const ramp = colorRamp(current);

  return (
    <div className={cx("dk-ramp", disabled && "dk-ramp--disabled")} data-testid="color-ramp">
      <div
        ref={area}
        className="dk-ramp__area"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label}: brightness and vividness`}
        aria-valuetext={`${Math.round(hsv.s * 100)}% vivid, ${Math.round(hsv.v * 100)}% bright`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.v * 100)}
        style={{
          // The square is drawn from the hue: white to it across, and black up
          // from the bottom. Inline, because it is a picture of this colour,
          // not chrome, and the palette gate rightly allows no colour in CSS.
          backgroundImage: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex(hsv.h)})`,
        }}
        onPointerDown={(event) => {
          if (disabled) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setHsv(fromPointer(event));
        }}
        onPointerMove={(event) => {
          if (dragging.current) setHsv(fromPointer(event));
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          const next = fromPointer(event);
          setHsv(next);
          commit(next);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={onAreaKey}
      >
        <span
          className="dk-ramp__handle"
          aria-hidden="true"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }}
        />
      </div>

      <input
        type="range"
        className="dk-ramp__hue"
        aria-label={`${label}: hue`}
        min={0}
        max={359}
        value={Math.round(hsv.h)}
        disabled={disabled}
        style={{
          backgroundImage:
            "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
        }}
        onChange={(event) => setHsv({ ...hsv, h: Number(event.target.value) })}
        // Committed when the strip is let go of, or a key has moved it.
        onPointerUp={() => commit(hsv)}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" || event.key.startsWith("Page")) commit(hsv);
        }}
      />

      {withOpacity ? (
        <input
          type="range"
          className="dk-ramp__hue dk-ramp__alpha"
          aria-label={`${label}: opacity`}
          min={0}
          max={100}
          value={Math.round(opacity * 100)}
          disabled={disabled}
          style={{
            // A checkerboard under the colour fading in: what "see-through" looks like.
            backgroundImage: `linear-gradient(to right, transparent, ${current}), repeating-conic-gradient(#bbb 0 25%, #fff 0 50%)`,
            backgroundSize: "100% 100%, 12px 12px",
          }}
          onChange={(event) => setOpacity(Number(event.target.value) / 100)}
          onPointerUp={() => commit(hsv)}
          onKeyUp={(event) => {
            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") commit(hsv);
          }}
        />
      ) : null}

      <div className="dk-ramp__steps" role="group" aria-label={`${label}: lighter and darker`}>
        {ramp.map((step, index) => (
          <button
            key={`${index}-${step}`}
            type="button"
            className={cx("dk-swatch", "dk-ramp__step", index === 4 && "dk-swatch--selected")}
            aria-label={index === 4 ? `This colour, ${step}` : `${index < 4 ? "Lighter" : "Darker"} ${step}`}
            title={step}
            disabled={disabled}
            style={{ background: step }}
            onClick={() => {
              const next = hexToHsv(step);
              if (!next) return;
              setHsv(next);
              commit(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}
