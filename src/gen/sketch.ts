/**
 * The generative sketch for 汎用 (generic) mode.
 *
 * One pure function: given a 2D context, its size, the wall-clock time and the
 * GenParams, draw one full frame. No internal state, so the offscreen output
 * window and the small UI preview stay in phase simply by sharing `beatEpoch`.
 *
 * Art direction — every preset is built like a screen-printed club flyer:
 * a fixed 2–4 ink palette on a stock (see palette.ts), flat shapes, halftone
 * and line screens instead of gradients, deliberate misregistration, cropped
 * condensed type, and asymmetric composition with real negative space.
 * Explicitly avoided: neon glow, additive "lighter" blooms, rainbow hue
 * sweeps, centred radial symmetry and vignettes — the house style of every
 * generative demo, which is exactly why it reads as generic.
 */

import type { GenParams } from './params';
import { PALETTES, ink, paperColor, tintShift, type Palette } from './palette';
import {
  condensed,
  grain,
  halftone,
  label,
  lineScreen,
  misregister,
  pad2,
  regMark,
} from './print';

const TAU = Math.PI * 2;

/** Deterministic pseudo-random in [0,1) — same value for the same index. */
function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Smooth 0..1 triangle-ish wave over `period` beats. */
function wave(beat: number, period: number): number {
  return 0.5 - 0.5 * Math.cos((beat / period) * TAU);
}

interface Clock {
  /** Fractional beats since the epoch. */
  beat: number;
  /** Seconds since the epoch. */
  t: number;
  /** 0..1 position inside the current beat. */
  phase: number;
  /** Percussive envelope: 1 on the beat, decaying to 0 before the next. */
  env: number;
  /** Envelope on the downbeat (every 4th beat) only. */
  bar: number;
  /** 0..1 intensity. */
  I: number;
  /** Tempo, for presets that set it as type. */
  bpm: number;
  /** This preset's palette, and the tint rotation applied to its spot inks. */
  pal: Palette;
  shift: number;
}

/** Spot ink helper bound to the current clock. */
function c1(c: Clock, i: number, alpha = 1): string {
  return ink(c.pal, i, c.shift, alpha);
}

/**
 * Draw one frame. `nowMs` is a wall-clock timestamp (Date.now()); `p.beatEpoch`
 * anchors the beat grid to the same clock.
 */
export function drawGen(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nowMs: number,
  p: GenParams,
): void {
  const bpm = Math.max(20, Math.min(300, p.bpm));
  const beatMs = 60000 / bpm;
  const beat = (nowMs - p.beatEpoch) / beatMs;
  const phase = beat - Math.floor(beat);
  const barPhase = (beat / 4) % 1;
  const pal = PALETTES[p.genre] ?? PALETTES.techno;
  const c: Clock = {
    beat,
    t: (nowMs - p.beatEpoch) / 1000,
    phase,
    env: Math.pow(1 - phase, 3),
    bar: Math.pow(1 - barPhase, 5),
    I: p.intensity,
    bpm,
    pal,
    shift: tintShift(p.hue),
  };

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = paperColor(pal, c.shift);
  ctx.fillRect(0, 0, w, h);

  switch (p.genre) {
    case 'techno':
      drawTechno(ctx, w, h, c);
      break;
    case 'house':
      drawHouse(ctx, w, h, c);
      break;
    case 'dnb':
      drawDnb(ctx, w, h, c);
      break;
    case 'hiphop':
      drawHipHop(ctx, w, h, c);
      break;
    case 'ambient':
      drawAmbient(ctx, w, h, c);
      break;
    case 'pop':
      drawPop(ctx, w, h, c);
      break;
    case 'kawaii':
      drawKawaii(ctx, w, h, c);
      break;
  }

  // Shared finish: paper grain only. No vignette — a dark ring around every
  // frame is the tell that all of these came out of the same generator.
  grain(ctx, w, h, pal.light ? 0.5 : 0.75, Math.floor(c.beat * 8));
  ctx.restore();
}

// ---- Techno: step-sequencer grid, Swiss left column, hard downbeat ---------

function drawTechno(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const m = w * 0.06; // margin
  const step = Math.floor(c.beat * 4) % 16;
  const bar = Math.floor(c.beat / 4) % 4;

  // Type column, left-aligned, hanging off the top margin.
  label(ctx, 'techno', m, h * 0.16, w * 0.013, c1(c, 1, 0.9));
  ctx.fillStyle = c1(c, 0);
  condensed(ctx, w * 0.115);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(Math.round(c.bpm)), m - w * 0.004, h * 0.3);
  condensed(ctx, w * 0.02);
  ctx.fillStyle = c1(c, 1, 0.55);
  ctx.fillText(`BPM · BAR ${pad2(bar + 1)}/04 · STEP ${pad2(step + 1)}`, m, h * 0.35);

  // Rule under the type block, drawn to the bleed.
  ctx.fillStyle = c1(c, 1, 0.25);
  ctx.fillRect(m, h * 0.4, w - m * 2, Math.max(1, h * 0.0018));

  // 16 x 4 step grid. The playhead column is solid; everything else is a hairline
  // cell, so the frame is mostly empty and the moving part carries it.
  const gx = m;
  const gy = h * 0.48;
  const gw = w - m * 2;
  const gh = h * 0.34;
  const cols = 16;
  const rows = 4;
  const cw = gw / cols;
  const chh = gh / rows;
  const pad = cw * 0.12;
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const on = x === step;
      // A fixed but irregular pattern of "programmed" steps, re-rolled per bar.
      const prog = rnd(x * 7 + y * 31 + bar * 13) < 0.18 + c.I * 0.22;
      const rx = gx + x * cw + pad;
      const ry = gy + y * chh + pad;
      const rw = cw - pad * 2;
      const rh = chh - pad * 2;
      if (on) {
        ctx.fillStyle = c1(c, 0);
        ctx.fillRect(rx, ry, rw, rh);
      } else if (prog) {
        ctx.fillStyle = c1(c, 0, 0.32);
        ctx.fillRect(rx, ry, rw, rh);
      } else {
        ctx.strokeStyle = c1(c, 1, 0.16);
        ctx.lineWidth = Math.max(1, w * 0.0012);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }
  }

  // Downbeat: a solid red bar slams in from the right edge, one beat long.
  if (c.bar > 0.25) {
    const k = (c.bar - 0.25) / 0.75;
    ctx.fillStyle = c1(c, 2);
    ctx.fillRect(w - gw * k - m, h * 0.86, gw * k, h * 0.045);
  }

  label(ctx, 'tube to syphon', m, h * 0.94, w * 0.0095, c1(c, 1, 0.35));
}

// ---- House: overlapping halftone discs, warm inks, slow drift --------------

function drawHouse(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const swell = wave(c.beat, 16);
  // Three discs, weighted to the lower left, sizes deliberately unequal.
  const discs: [number, number, number, number][] = [
    [0.36, 0.58, 0.30, 0],
    [0.55, 0.46, 0.22, 1],
    [0.46, 0.68, 0.14, 2],
  ];
  const rulings = [26, 16, 10];

  for (let i = 0; i < discs.length; i++) {
    const [fx, fy, fr, inkIdx] = discs[i];
    const drift = 0.012 * Math.sin(c.beat * 0.08 + i * 2.1);
    const x = w * (fx + drift);
    const y = h * (fy - drift * 0.6);
    const r = Math.min(w, h) * fr * (1 + swell * 0.05 + c.env * 0.012 * c.I);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    const pat = halftone(
      ctx,
      ink(c.pal, inkIdx, c.shift),
      rulings[i],
      // Capped: past ~0.5 the dots touch and the screen turns into a
      // checkerboard instead of reading as a tint.
      Math.min(0.5, 0.2 + c.I * 0.3 + swell * 0.1),
    );
    if (pat) {
      ctx.save();
      // Rotate the screen angle per ink, like separate plates.
      ctx.translate(x, y);
      ctx.rotate(i * 0.35 + c.beat * 0.004);
      ctx.fillStyle = pat;
      ctx.fillRect(-r * 1.6, -r * 1.6, r * 3.2, r * 3.2);
      ctx.restore();
    }
    ctx.restore();
    // Thin containing rule so the disc reads as a drawn shape, not a blur.
    ctx.strokeStyle = ink(c.pal, inkIdx, c.shift, 0.7);
    ctx.lineWidth = Math.max(1, w * 0.0016);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  }

  // Horizon rule + type, upper right, against all that mass in the lower left.
  const m = w * 0.06;
  ctx.fillStyle = ink(c.pal, 2, c.shift, 0.5);
  ctx.fillRect(m, h * 0.3, w - m * 2, Math.max(1, h * 0.0016));
  ctx.textAlign = 'right';
  label(ctx, 'house', w - m, h * 0.24, w * 0.013, ink(c.pal, 2, c.shift, 0.9));
  condensed(ctx, w * 0.05);
  ctx.fillStyle = ink(c.pal, 0, c.shift);
  ctx.fillText(`${Math.round(c.bpm)}`, w - m, h * 0.215);
  ctx.textAlign = 'left';
}

// ---- Drum & Bass: sliced condensed type, CMY misregistration ---------------

function drawDnb(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const step = Math.floor(c.beat * 4);
  const sub = Math.pow(1 - (c.beat * 4 - step), 3);
  const word = String(Math.round(c.bpm));

  // One huge numeral, cropped by the frame, sliced into bands that jump on 16ths.
  condensed(ctx, h * 0.78);
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(word).width;
  const bx = w * 0.5 - tw / 2 + w * 0.04; // pushed off-centre
  const by = h * 0.52;
  const bands = 9;
  for (let i = 0; i < bands; i++) {
    const y0 = (i / bands) * h;
    const bh = h / bands + 1;
    const jump = (rnd(step * 17 + i * 5) - 0.5) * w * 0.09 * (0.35 + c.I);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, w, bh);
    ctx.clip();
    misregister(
      ctx,
      w * 0.004 + sub * w * 0.006,
      0,
      ink(c.pal, 0, c.shift),
      ink(c.pal, 1, c.shift),
      (g) => {
        condensed(g, h * 0.78);
        g.textBaseline = 'middle';
        g.fillText(word, bx + jump, by);
      },
    );
    ctx.restore();
  }

  // Hairline rules between the bands — makes the slicing look specified.
  ctx.fillStyle = ink(c.pal, 2, c.shift, 0.22);
  for (let i = 1; i < bands; i++) {
    ctx.fillRect(0, (i / bands) * h, w, 1);
  }

  const m = w * 0.05;
  ctx.textBaseline = 'alphabetic';
  label(ctx, `drum & bass · ${pad2((step % 16) + 1)}/16`, m, h * 0.09, w * 0.011,
    ink(c.pal, 2, c.shift, 0.8));
  regMark(ctx, w - m, h * 0.09, w * 0.014, ink(c.pal, 2, c.shift, 0.7));
  regMark(ctx, m * 0.7, h * 0.93, w * 0.014, ink(c.pal, 2, c.shift, 0.5));
}

// ---- Hip-Hop: cream poster stock, black type, one red block ----------------

function drawHipHop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  // The half-beat "boom bap" jogs the whole composition a few px, like a press
  // slipping — motion without any easing curve.
  const hit = Math.pow(1 - ((c.beat * 2) % 1), 5);
  const jog = hit * w * 0.006;
  ctx.save();
  ctx.translate(jog, -jog * 0.5);

  const m = w * 0.06;
  const bar = Math.floor(c.beat / 4) % 4;

  // Red block, snapping to one of four positions on the bar.
  const slots = [0.08, 0.34, 0.52, 0.2];
  ctx.fillStyle = c1(c, 1);
  ctx.fillRect(w * 0.52, h * slots[bar], w * 0.42, h * (0.26 + c.I * 0.12));

  // Halftone disc, overlapping the block, bleeding off the right edge.
  const dx = w * 0.86;
  const dy = h * 0.62;
  const dr = Math.min(w, h) * 0.3;
  ctx.save();
  ctx.beginPath();
  ctx.arc(dx, dy, dr, 0, TAU);
  ctx.clip();
  const pat = halftone(ctx, c1(c, 0), 14, Math.min(0.48, 0.22 + c.I * 0.3));
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(dx - dr, dy - dr, dr * 2, dr * 2);
  }
  ctx.restore();

  // Giant bar numeral, cropped hard by the left edge.
  ctx.fillStyle = c1(c, 0);
  condensed(ctx, h * 0.72);
  ctx.textBaseline = 'middle';
  ctx.fillText(pad2(bar + 1), -w * 0.02, h * 0.55);

  // Annotation stack, bottom left.
  ctx.textBaseline = 'alphabetic';
  label(ctx, 'hip-hop', m, h * 0.14, w * 0.013, c1(c, 0, 0.9));
  ctx.fillStyle = c1(c, 0, 0.6);
  condensed(ctx, w * 0.018);
  ctx.fillText(`${Math.round(c.bpm)} BPM`, m, h * 0.175);
  ctx.fillStyle = c1(c, 0, 0.85);
  ctx.fillRect(m, h * 0.19, w * 0.12, Math.max(1, h * 0.004));
  ctx.restore();
}

// ---- Ambient: breathing line screen, one soft disc, near monochrome --------

function drawAmbient(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  // Line spacing breathes over a 16-beat phrase; two overlaid screens at slightly
  // different rulings give a slow moiré that never repeats on the eye.
  const breathe = wave(c.beat, 16);
  const rulings = [
    9 + Math.round(breathe * 5),
    13 + Math.round((1 - breathe) * 6),
  ];
  for (let i = 0; i < rulings.length; i++) {
    const pat = lineScreen(
      ctx,
      ink(c.pal, i, c.shift, 0.5 + c.I * 0.25),
      rulings[i],
      1,
    );
    if (!pat) continue;
    ctx.save();
    ctx.translate(0, (c.t * (2 + i * 3)) % rulings[i]);
    ctx.fillStyle = pat;
    ctx.fillRect(0, -rulings[i], w, h + rulings[i] * 2);
    ctx.restore();
  }

  // A single disc knocked out of the field, drifting off-centre.
  const x = w * (0.62 + 0.03 * Math.sin(c.beat * 0.03));
  const y = h * (0.44 + 0.03 * Math.cos(c.beat * 0.023));
  const r = Math.min(w, h) * (0.24 + breathe * 0.03);
  // Knocked out to the stock, not to black — a hole in the ink, not a void.
  ctx.fillStyle = paperColor(c.pal, c.shift);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = ink(c.pal, 0, c.shift, 0.45);
  ctx.lineWidth = Math.max(1, w * 0.0012);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();

  const m = w * 0.06;
  label(ctx, 'ambient', m, h * 0.9, w * 0.011, ink(c.pal, 0, c.shift, 0.55));
}

// ---- Pop: flat pop-art shapes with an offset second ink --------------------

function drawPop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const m = w * 0.07;
  const swap = Math.floor(c.beat) % 2 === 0;
  const off = w * 0.012 + c.env * w * 0.006 * c.I;

  // Halftone field across the lower band.
  const pat = halftone(ctx, c1(c, 0, 0.8), 20, 0.18 + c.I * 0.3);
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);
  }

  // A disc and a square trading places every beat, each printed twice out of
  // register so the shapes have an edge instead of a glow.
  const a = { x: w * (swap ? 0.36 : 0.66), y: h * 0.44, r: Math.min(w, h) * 0.21 };
  const b = { x: w * (swap ? 0.68 : 0.34), y: h * 0.5, s: Math.min(w, h) * 0.3 };

  misregister(
    ctx,
    off,
    off * 0.6,
    c1(c, 2),
    c1(c, 0),
    (g) => {
      g.beginPath();
      g.arc(a.x, a.y, a.r, 0, TAU);
      g.fill();
    },
    'multiply',
  );
  misregister(
    ctx,
    -off,
    off * 0.5,
    c1(c, 0),
    c1(c, 1),
    (g) => {
      g.fillRect(b.x - b.s / 2, b.y - b.s / 2, b.s, b.s);
    },
    'multiply',
  );

  // Frame rule + type, top left, hanging outside the shapes.
  ctx.strokeStyle = c1(c, 1, 0.9);
  ctx.lineWidth = Math.max(2, w * 0.003);
  ctx.strokeRect(m * 0.5, m * 0.5, w - m, h - m);
  label(ctx, 'pop', m, h * 0.15, w * 0.014, c1(c, 1));
  ctx.fillStyle = c1(c, 1, 0.75);
  condensed(ctx, w * 0.018);
  ctx.fillText(`${Math.round(c.bpm)} BPM · ${pad2((Math.floor(c.beat) % 4) + 1)}/04`,
    m, h * 0.19);
}

// ---- Kawaii: Y2K sticker sheet — flat inks, hard black outlines ------------

function drawKawaii(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const outline = c1(c, 2);
  const m = w * 0.05;

  // Checkerboard band across the lower third — flat, no gradient anywhere.
  const cell = w / 16;
  const scroll = (c.beat * cell * 0.5) % (cell * 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, h * 0.66, w, h * 0.34);
  ctx.clip();
  for (let x = -2; x < 18; x++) {
    for (let y = 0; y < 6; y++) {
      if ((x + y) % 2) continue;
      ctx.fillStyle = c1(c, 1, 0.85);
      ctx.fillRect(x * cell - scroll, h * 0.66 + y * cell, cell, cell);
    }
  }
  ctx.restore();
  ctx.fillStyle = outline;
  ctx.fillRect(0, h * 0.66 - h * 0.008, w, h * 0.008);

  // Halftone blush behind the stickers, upper left.
  const pat = halftone(ctx, c1(c, 0, 0.9), 18, 0.3);
  if (pat) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(w * 0.26, h * 0.3, Math.min(w, h) * 0.26, 0, TAU);
    ctx.clip();
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Stickers: flat fill, thick black outline, hard offset shadow. No highlights,
  // no soft edges — die-cut vinyl, not an airbrush.
  const items = 5 + Math.round(c.I * 2);
  for (let i = 0; i < items; i++) {
    const r1 = rnd(i * 3 + 1);
    const r2 = rnd(i * 5 + 2);
    const bounce = Math.abs(Math.sin(((c.beat + r1) % 1) * Math.PI));
    // Jittered grid rather than pure random placement: keeps the sheet evenly
    // covered without the clumps and holes a random scatter always produces.
    // Cell 0 is left empty for the caption, so type and stickers never collide.
    const cols = 4;
    const gi = i + 1;
    const gxi = gi % cols;
    const gyi = Math.floor(gi / cols);
    const x = ((gxi + 0.2 + r1 * 0.6) / cols) * w;
    const y = ((gyi + 0.2 + r2 * 0.55) / 2) * h * 0.6 + h * 0.05 - bounce * h * 0.04;
    const s = (0.09 + r2 * 0.06) * Math.min(w, h);
    const kind = i % 3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((r1 - 0.5) * 0.5);
    const paint = (fill: string, dx: number, dy: number) => {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillStyle = fill;
      ctx.strokeStyle = outline;
      ctx.lineWidth = s * 0.085;
      ctx.lineJoin = 'round';
      if (kind === 0) heartPath(ctx, s);
      else if (kind === 1) starPath(ctx, s * 0.5);
      else flowerPath(ctx, s * 0.46);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    paint(outline, s * 0.06, s * 0.07); // hard shadow copy
    paint(c1(c, i % 2 === 0 ? 0 : 3), 0, 0);
    ctx.restore();
  }

  // Type, set small and low — the sheet's caption.
  label(ctx, 'kawaii', m, h * 0.14, w * 0.014, outline);
  ctx.fillStyle = outline;
  condensed(ctx, w * 0.016);
  ctx.fillText(`${Math.round(c.bpm)} BPM`, m, h * 0.175);
}

// ---- Shapes ----------------------------------------------------------------

/** Heart outline centred on (0,0), `s` tall. */
function heartPath(ctx: CanvasRenderingContext2D, s: number) {
  const k = s / 32;
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * TAU;
    const x = 16 * Math.pow(Math.sin(t), 3) * k;
    const y =
      -(13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t)) *
      k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** `points`-pointed star centred on (0,0), outer radius `R`. */
function starPath(
  ctx: CanvasRenderingContext2D,
  R: number,
  points = 5,
  inner = 0.45,
) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * TAU - Math.PI / 2;
    const rr = i % 2 === 0 ? R : R * inner;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Five-petal flower — the other half of the sticker sheet. */
function flowerPath(ctx: CanvasRenderingContext2D, R: number) {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU - Math.PI / 2;
    const px = Math.cos(a) * R * 0.6;
    const py = Math.sin(a) * R * 0.6;
    ctx.moveTo(px + R * 0.42, py);
    ctx.arc(px, py, R * 0.42, 0, TAU);
  }
  ctx.closePath();
}
