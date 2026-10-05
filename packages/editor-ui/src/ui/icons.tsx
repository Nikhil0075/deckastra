import type { SVGProps } from "react";

/**
 * The icon set, drawn from primitive geometry — line, square, circle, triangle —
 * at one stroke weight on a 16px grid. Local rather than a package: the set is
 * small, the Bauhaus rule is "basic shapes only", and a library brings a
 * thousand icons in someone else's hand.
 *
 * Every icon is decorative (`aria-hidden`). The *control* carries the name —
 * `IconButton` requires a label for exactly that reason.
 */

export type IconName = keyof typeof PATHS;

const PATHS = {
  select: <path d="M4 2.5 12.5 9 8.5 9.6 6.4 13.5Z" fill="currentColor" stroke="none" />,
  text: <path d="M3 3.5h10M8 3.5v10M6 13.5h4" />,
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  ellipse: <circle cx="8" cy="8" r="5.5" />,
  line: <path d="M3 13 13 3" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" />
      <circle cx="6" cy="6.5" r="1.25" />
      <path d="m2.5 12 4-4 3 3 1.5-1.5 2.5 2.5" />
    </>
  ),
  upload: <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />,
  chart: <path d="M3 13.5V8M6.5 13.5V4M10 13.5V6.5M13.5 13.5V2.5" />,
  diagram: (
    <>
      <rect x="6" y="2" width="4" height="3.5" />
      <rect x="2" y="10.5" width="4" height="3.5" />
      <rect x="10" y="10.5" width="4" height="3.5" />
      <path d="M8 5.5V8M4 10.5V8h8v2.5" />
    </>
  ),
  table: <path d="M2.5 3h11v10h-11ZM2.5 6.5h11M2.5 10h11M6.5 3v10" />,
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  // A pipette, tip at bottom left: the colour is taken from where it points.
  eyedropper: <path d="M2.5 13.5 3.5 10l5.5-5.5 2.5 2.5L6 12.5ZM9 4.5l1.5-1.5a1.4 1.4 0 0 1 2 2L11 6.5M8 3.5l4.5 4.5" />,
  // A square root over x: reads as maths at 16px where a sigma reads as a letter.
  equation: <path d="M1.5 9 3.5 8l2 5 3-10.5h6M9.5 6.5l3.5 4M13 6.5l-3.5 4" />,
  undo: <path d="M5 3.5 2.5 6 5 8.5M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />,
  redo: <path d="m11 3.5 2.5 2.5L11 8.5M13.5 6H6a3.5 3.5 0 0 0 0 7h4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  close: <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />,
  check: <path d="m3 8.5 3 3 7-7" />,
  bold: <path d="M5 3h4a2.5 2.5 0 0 1 0 5H5ZM5 8h4.5a2.5 2.5 0 0 1 0 5H5Z" strokeWidth="1.75" />,
  italic: <path d="M7 3h5M4 13h5M10 3 6 13" />,
  underline: <path d="M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9" />,
  listBullet: (
    <>
      <circle cx="3.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" />
    </>
  ),
  listNumbered: <path d="M3 3.5h1v3M2.5 9h2l-2 3h2M6.5 4.5h7M6.5 8h7M6.5 11.5h7" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" />
      <path d="M10.5 5.5v-3h-8v8h3" />
    </>
  ),
  chevronDown: <path d="m4 6 4 4 4-4" />,
  chevronUp: <path d="m4 10 4-4 4 4" />,
  chevronRight: <path d="m6 4 4 4-4 4" />,
  chevronLeft: <path d="m10 4-4 4 4 4" />,
  play: <path d="M4.5 3v10l8-5Z" fill="currentColor" stroke="none" />,
  pause: <path d="M5 3.5v9M11 3.5v9" strokeWidth="2" />,
  stop: <rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" />,
  more: (
    <>
      <circle cx="8" cy="3.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  drag: <path d="M3 5.5h10M3 8h10M3 10.5h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  // A four-point star — distinct from `settings`, which is the sunburst.
  ai: <path d="M8 1.5 9.5 6.5 14.5 8 9.5 9.5 8 14.5 6.5 9.5 1.5 8 6.5 6.5Z" />,
  motion: <path d="M2.5 8h5M5.5 4.5h6M4 11.5h9.5" />,
  present: <path d="M2.5 3h11v8h-11ZM8 11v2.5M5 13.5h6" />,
  share: (
    <>
      <circle cx="4" cy="8" r="1.75" />
      <circle cx="12" cy="4" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <path d="m5.6 7.2 4.8-2.4M5.6 8.8l4.8 2.4" />
    </>
  ),
  download: <path d="M8 3v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM2.5 2.5l11 11" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0" />
    </>
  ),
  warning: <path d="M8 2.5 14 13.5H2ZM8 6.5v3.5M8 11.5v.5" />,
  history: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </>
  ),
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  grid: <path d="M2.5 2.5h4.5v4.5H2.5ZM9 2.5h4.5v4.5H9ZM2.5 9h4.5v4.5H2.5ZM9 9h4.5v4.5H9Z" />,
  list: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  comment: <path d="M2.5 3h11v7.5H7L4 13v-2.5H2.5Z" />,
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
    </>
  ),
  signOut: (
    <>
      <path d="M6.5 2.5h-4v11h4" />
      <path d="M10 5l3 3-3 3M13 8H6" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />,
  duplicate: <path d="M5.5 5.5h8v8h-8ZM10.5 5.5v-3h-8v8h3" />,
  external: <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />,
  /* Languages, narration and sound (integration plan 01). Same primitives:
     circles, lines, one triangle. */
  language: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" />
    </>
  ),
  mic: <path d="M6 3a2 2 0 0 1 4 0v4.5a2 2 0 0 1-4 0ZM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M5.5 14h5" />,
  sound: <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5ZM11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" />,
  mute: <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5ZM10.5 6l3.5 4M14 6l-3.5 4" />,
  narration: <path d="M2.5 3h7v5.5H5.5L3 11V8.5h-.5ZM11.5 5.5v4M13.5 4v7" />,
  /* Half a disc: light and dark, the chrome theme's switch. */
  theme: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 0 0 11Z" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Rendered edge in px. The drawing grid is always 16. */
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className="dk-icon"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];
