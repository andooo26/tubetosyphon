/**
 * Ink palettes for the generative presets.
 *
 * Deliberately NOT a hue wheel. Each preset gets a fixed 3–4 ink palette chosen
 * for that music, the way a screen-printed flyer is specified: one ground plus a
 * couple of spot inks. No blue-violet gradients, no rainbow sweeps, no neon glow
 * — those are the defaults every generator lands on, and they read as generic.
 *
 * Colours are stored as HSL triples so the UI's tint control can rotate the spot
 * inks a little without dissolving the palette (see `ink()`).
 */

import type { Genre } from './params';

export type Hsl = [h: number, s: number, l: number];

export interface Palette {
  /** The ground the preset prints on. */
  paper: Hsl;
  /** Spot inks, most important first. */
  inks: Hsl[];
  /** True when the ground is light — presets use it to pick contrast. */
  light: boolean;
}

export const PALETTES: Record<Genre, Palette> = {
  // Acid lime on true black with a signal red — the classic flyer two-colour.
  techno: {
    paper: [0, 0, 4],
    inks: [
      [72, 100, 52],
      [40, 8, 92],
      [6, 88, 54],
    ],
    light: false,
  },
  // Warm analogue: burnt orange and dusty pink on a brown-black ground.
  house: {
    paper: [22, 26, 8],
    inks: [
      [26, 92, 58],
      [342, 62, 66],
      [44, 55, 86],
    ],
    light: false,
  },
  // Two-ink misregistration: cyan and magenta, print-registration style.
  dnb: {
    paper: [0, 0, 5],
    inks: [
      [186, 92, 52],
      [330, 88, 58],
      [0, 0, 96],
    ],
    light: false,
  },
  // Cream poster stock, black type, one red block.
  hiphop: {
    paper: [38, 30, 87],
    inks: [
      [0, 0, 8],
      [8, 78, 48],
      [38, 24, 72],
    ],
    light: true,
  },
  // Muted, near-monochrome. Pale sand and slate; nothing saturated.
  ambient: {
    paper: [212, 18, 11],
    inks: [
      [200, 16, 74],
      [32, 26, 66],
      [212, 14, 22],
    ],
    light: false,
  },
  // Pop-art print: yellow stock, vermilion and black.
  pop: {
    paper: [48, 86, 88],
    inks: [
      [8, 82, 54],
      [0, 0, 10],
      [204, 62, 46],
    ],
    light: true,
  },
  // Y2K sticker sheet: pastel pink stock, hot pink + sky, hard black outline.
  kawaii: {
    paper: [340, 62, 90],
    inks: [
      [338, 84, 66],
      [196, 72, 70],
      [0, 0, 12],
      [48, 92, 74],
    ],
    light: true,
  },
};

/** The tint control rotates spot inks by at most ±40°, so a palette bends but never breaks. */
export function tintShift(hue: number): number {
  return ((hue - 205) / 360) * 90;
}

/** `i`-th spot ink of `pal`, tinted and optionally alpha'd. */
export function ink(pal: Palette, i: number, shift = 0, alpha = 1): string {
  const [h, s, l] = pal.inks[i % pal.inks.length];
  return `hsla(${(((h + shift) % 360) + 360) % 360}, ${s}%, ${l}%, ${alpha})`;
}

/** Ground colour. Tinted at a quarter strength so the stock stays neutral. */
export function paperColor(pal: Palette, shift = 0, alpha = 1): string {
  const [h, s, l] = pal.paper;
  return `hsla(${(((h + shift * 0.25) % 360) + 360) % 360}, ${s}%, ${l}%, ${alpha})`;
}
