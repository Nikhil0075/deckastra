/**
 * Fitting a slide to whatever it is being shown on (doc 04 §4.2).
 *
 * One number for both axes, always. The deck is projected at whatever aspect
 * ratio the room's hardware happens to have — a 16:10 projector, a 4:3 screen in
 * a lecture theatre, a laptop panel while the presenter rehearses — and the only
 * honest answer to a mismatch is to letterbox: scale by the tighter axis and
 * leave the rest black.
 *
 * The alternatives are worse in ways that only show up in the room. Scaling each
 * axis separately stretches every glyph and every circle, and nobody notices
 * until the slide is six feet wide. Fitting elements individually to the viewport
 * — rather than one transform on the root — is what produces the blurry text and
 * drifting geometry §4.2 exists to forbid.
 *
 * Named and extracted because it is a *rule*, not an expression: present mode,
 * the presenter's preview of the next slide, and any future second-display path
 * all have to agree, and three `Math.min` calls in three files are three places
 * for one of them to become a `Math.max`.
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface DisplayFit {
  /** The single factor to apply to the root. */
  scale: number;
  /** The rendered size, so the caller can centre it. */
  width: number;
  height: number;
  /** Black bars, in CSS pixels. One of these is always zero. */
  letterbox: { x: number; y: number };
}

/**
 * How to place `slide` inside `available`.
 *
 * A zero or negative surface returns a zero scale rather than an Infinity or a
 * NaN: a container that has not been measured yet is an ordinary first-render
 * state, and the caller draws nothing until it has a size.
 */
export function fitToDisplay(slide: Viewport, available: Viewport): DisplayFit {
  if (
    available.width <= 0 ||
    available.height <= 0 ||
    slide.width <= 0 ||
    slide.height <= 0
  ) {
    return { scale: 0, width: 0, height: 0, letterbox: { x: 0, y: 0 } };
  }

  const scale = Math.min(available.width / slide.width, available.height / slide.height);
  const width = slide.width * scale;
  const height = slide.height * scale;

  return {
    scale,
    width,
    height,
    letterbox: {
      x: Math.max(0, (available.width - width) / 2),
      y: Math.max(0, (available.height - height) / 2),
    },
  };
}
