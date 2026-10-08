/**
 * The generative sketch for 汎用 (generic) mode.
 *
 * One pure function: given a 2D context, its size, the wall-clock time and the
 * GenParams, draw one full frame. No internal state, so the projector layer
 * and the small UI preview stay in phase simply by sharing `beatEpoch`.
 *
 * Art direction — screen-printed club graphics in motion: a fixed 2–4 ink
 * palette on a stock (palette.ts), flat shapes, halftone and line screens
 * instead of gradients, deliberate misregistration, asymmetric composition.
 *
 * No type, no readouts. These frames go to a projector, so burning the tempo or
 * a bar counter into the image is a HUD, not a visual — the beat has to be
 * legible from the movement itself.
 *
 * Motion rules (this is what separates it from a screensaver):
 *   - Everything is cut or eased against the beat grid; nothing drifts freely.
 *   - Hits use easeOutExpo (fast attack, long settle), never linear.
 *   - Elements are staggered by index so a bar reads as a sequence, not a pulse.
 *   - Each preset has one element on the beat, one on the bar, and one slow
 *     phrase-length move, so there is always motion at three time scales.
 */

import type { GenParams } from './params';
import { PALETTES, ink, paperColor, tintShift, type Palette } from './palette';
import { grain, halftone, lineScreen, misregister } from './print';

const TAU = Math.PI * 2;

/**
 * Three-input hash. Every random choice runs through this rather than
 * Math.random(), so the projector and the on-screen preview draw
 * identical frames from the same (seed, phrase, index).
 */
function hash3(a: number, b: number, i: number): number {
  const x = Math.sin(a * 374.761 + b * 668.265 + i * 127.113 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** How many beats a "scene" lasts before every seeded choice re-rolls. */
const PHRASE_BEATS = 8;

/** Smooth 0..1 triangle-ish wave over `period` beats. */
function wave(beat: number, period: number): number {
  return 0.5 - 0.5 * Math.cos((beat / period) * TAU);
}

// Easing. A hit that decays with easeOutExpo reads as struck; the same hit on a
// linear ramp reads as a slider being dragged.
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** 0..1 progress of `beat` through a `len`-beat cycle, offset by `delay` beats. */
function stagger(beat: number, len: number, delay: number): number {
  return Math.min(1, Math.max(0, ((beat % len) - delay) / (len - delay || 1)));
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
  /** 0..1 intensity. Above ~0.6 the director starts cutting and strobing. */
  I: number;
  /** This preset's palette, and the tint rotation applied to its spot inks. */
  pal: Palette;
  shift: number;
  /** Index of the current 8-beat scene. */
  phrase: number;
  /** Random, stable for this whole scene — layout choices that shouldn't flicker. */
  rand: (i: number) => number;
  /** Random for an arbitrary index (e.g. a 16th-note step), mixed with the seed. */
  noise: (a: number, i: number) => number;
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
  const rawBeat = (nowMs - p.beatEpoch) / beatMs;
  const pal = PALETTES[p.genre] ?? PALETTES.techno;
  const I = p.intensity;
  const seed = p.seed;
  const phrase = Math.floor(rawBeat / PHRASE_BEATS);

  // ---- Director -----------------------------------------------------------
  // A layer above the presets that behaves like someone playing the visuals:
  // it cuts the camera, freezes the clock, shakes on hits and strobes. All of it
  // is hashed off (seed, scene) so it is repeatable, and all of it scales with
  // Intensity — at 0 the presets play straight, at 1 they get worked.

  // Cut the camera every N beats; faster when Intensity is up.
  const cutEvery = I > 0.72 ? 2 : I > 0.45 ? 4 : I > 0.2 ? 8 : 16;
  const cutIdx = Math.floor(rawBeat / cutEvery);
  const camPick = hash3(seed, cutIdx, 91);
  const camOn = camPick < 0.15 + I * 0.6;

  // Stutter: for one beat in a scene the clock is quantised to 16ths, so the
  // motion machine-guns instead of flowing. Only at higher intensities.
  const stutterBeat = Math.floor(hash3(seed, phrase, 17) * PHRASE_BEATS);
  const stuttering =
    I > 0.5 && Math.floor(rawBeat % PHRASE_BEATS) === stutterBeat;
  const beat = stuttering ? Math.floor(rawBeat * 4) / 4 : rawBeat;

  const phase = beat - Math.floor(beat);
  const barPhase = (beat / 4) % 1;
  const c: Clock = {
    beat,
    t: (nowMs - p.beatEpoch) / 1000,
    phase,
    env: Math.pow(1 - phase, 3),
    bar: Math.pow(1 - barPhase, 5),
    I,
    pal,
    shift: tintShift(p.hue),
    phrase,
    rand: (i: number) => hash3(seed, phrase, i),
    noise: (a: number, i: number) => hash3(seed, a, i),
  };

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  // Paper goes down untransformed so a zoomed or mirrored camera can never
  // expose a bare corner.
  ctx.fillStyle = paperColor(pal, c.shift);
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  if (camOn) {
    // Only mirrors, 180° flips and zoom-ins: every one of them still covers the
    // full frame, so no transform can reveal an edge.
    const kind = Math.floor(hash3(seed, cutIdx, 33) * 4);
    if (kind === 0) ctx.scale(-1, 1);
    else if (kind === 1) ctx.scale(1, -1);
    else if (kind === 2) ctx.rotate(Math.PI);
    const zoom = 1 + hash3(seed, cutIdx, 55) * 0.5 * I;
    ctx.scale(zoom, zoom);
    // Push the framing off centre so a zoom crops somewhere specific.
    ctx.translate(
      (hash3(seed, cutIdx, 77) - 0.5) * w * 0.12 * I,
      (hash3(seed, cutIdx, 88) - 0.5) * h * 0.12 * I,
    );
  }
  // Hit shake, direction re-rolled every beat.
  const shake = c.env * I * I * 0.02;
  ctx.translate(
    (hash3(seed, Math.floor(beat), 5) - 0.5) * w * shake,
    (hash3(seed, Math.floor(beat), 6) - 0.5) * h * shake,
  );
  ctx.translate(-w / 2, -h / 2);

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
    case 'hyperpop':
      drawHyperpop(ctx, w, h, c);
      break;
  }

  ctx.restore(); // end camera

  // Strobe. Two flavours, both full-strength and both about one frame long at
  // 60fps — a partial-alpha flash just greys the picture out.
  if (I > 0.45) {
    const strobeRate = I > 0.8 ? 4 : I > 0.62 ? 2 : 1; // hits per beat
    const sp = (beat * strobeRate) % 1;
    const chance = hash3(seed, Math.floor(beat * strobeRate), 41);
    // ~5% of each hit's window, so even at full intensity the picture is on
    // screen the overwhelming majority of the time. A longer duty cycle stops
    // reading as a strobe and starts hiding the visual behind flat colour.
    if (sp < 0.05 && chance < (I - 0.45) * 1.4) {
      // Mostly the negative flash; the solid ink flood is the rarer, harder hit.
      if (chance > 0.12) {
        // Negative: reads as a camera flash on dark stock and as ink on light.
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#fff';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = ink(pal, 0, c.shift);
      }
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // Shared finish: paper grain only. No vignette — a dark ring around every
  // frame is the tell that all of these came out of the same generator.
  grain(ctx, w, h, pal.light ? 0.5 : 0.75, Math.floor(c.beat * 8));
  ctx.restore();
}

// ---- Techno: matrix sweep with a decaying trail, red slab on the downbeat ---

function drawTechno(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const cols = 16;
  const rows = 8;
  const cw = w / cols;
  const ch = h / rows;
  const pad = cw * 0.14;
  const step = Math.floor(c.beat * 4);
  const sub = c.beat * 4 - step;

  // Playhead sweeps one column per 16th. Columns behind it decay over four
  // steps, so the movement leaves a trail instead of a single blinking line.
  for (let x = 0; x < cols; x++) {
    // How many steps ago this column was hit (wrapping).
    const age = (((step - x) % cols) + cols) % cols;
    const trail = age === 0 ? 1 - sub * 0.15 : Math.max(0, 1 - age / 4);
    for (let y = 0; y < rows; y++) {
      // Fixed programme per column: which rows light up when it is hit.
      const on = c.rand(x * 13 + y * 71) < 0.18 + c.I * 0.5;
      const rx = x * cw + pad;
      const ry = y * ch + pad;
      const rw = cw - pad * 2;
      const rh = ch - pad * 2;
      if (on && trail > 0.02) {
        ctx.fillStyle = c1(c, 0, 0.15 + trail * 0.85);
        ctx.fillRect(rx, ry, rw, rh);
      } else {
        ctx.strokeStyle = c1(c, 1, 0.08);
        ctx.lineWidth = Math.max(1, w * 0.001);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }
  }

  // Every beat one row lights up whole, cell by cell, then drops out — a row
  // inversion in the sequencer's own vocabulary. (A continuous bar sweeping the
  // width just looked like a progress meter.)
  const rowIdx = Math.floor(c.beat) % rows;
  const reveal = easeOutExpo(Math.min(1, c.phase * 4)); // fills left to right
  const fade = Math.max(0, 1 - Math.max(0, c.phase - 0.35) / 0.4);
  if (fade > 0.02) {
    for (let x = 0; x < cols; x++) {
      if (x / cols > reveal) break;
      ctx.fillStyle = c1(c, 1, 0.85 * fade);
      ctx.fillRect(x * cw + pad, rowIdx * ch + pad, cw - pad * 2, ch - pad * 2);
    }
  }

  // Downbeat: a red slab wipes in from the right and retracts over the bar.
  const wipe = 1 - easeOutExpo(Math.min(1, (1 - Math.pow(c.bar, 0.2)) * 1.4));
  if (wipe > 0.01) {
    ctx.fillStyle = c1(c, 2);
    ctx.fillRect(w * (1 - wipe), h * 0.5 - ch * 0.5, w * wipe, ch);
  }

  // Phrase-length move: a hairline frame that steps outward every 8 beats.
  const k = stagger(c.beat, 8, 0);
  const inset = (0.02 + easeInOutCubic(k) * 0.05) * w;
  ctx.strokeStyle = c1(c, 0, 0.35);
  ctx.lineWidth = Math.max(1, w * 0.0015);
  ctx.strokeRect(inset, inset * (h / w) * 1.2, w - inset * 2, h - inset * (h / w) * 2.4);
}

// ---- House: orbiting halftone discs, bar wipe, phrase-length swell ---------

function drawHouse(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const swell = wave(c.beat, 16);
  const discs: [number, number, number, number][] = [
    [0.34, 0.56, 0.31, 0],
    [0.57, 0.44, 0.23, 1],
    [0.47, 0.7, 0.15, 2],
  ];
  const rulings = [26, 16, 10];

  for (let i = 0; i < discs.length; i++) {
    const [fx0, fy0, fr0, inkIdx] = discs[i];
    // Re-composed every scene: positions and sizes jitter, so the same three
    // discs never sit in the same arrangement twice.
    const fx = fx0 + (c.rand(i * 3) - 0.5) * 0.22;
    const fy = fy0 + (c.rand(i * 3 + 1) - 0.5) * 0.16;
    const fr = fr0 * (0.75 + c.rand(i * 3 + 2) * 0.6);
    // Each disc orbits its own small circle, staggered a beat apart, so the
    // group is never in phase with itself.
    const a = c.beat * 0.16 + (i * TAU) / 3;
    const orbit = 0.035 + i * 0.012;
    const x = w * (fx + Math.cos(a) * orbit);
    const y = h * (fy + Math.sin(a) * orbit * 1.4);
    // Beat pop, staggered by index: disc 0 on the beat, 1 an eighth later, etc.
    const pop = easeOutExpo(Math.min(1, Math.max(0, (c.phase - i * 0.12) * 6)));
    const r =
      Math.min(w, h) * fr * (1 + swell * 0.05 + (1 - pop) * 0.05 * c.I);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    const pat = halftone(
      ctx,
      ink(c.pal, inkIdx, c.shift),
      rulings[i],
      Math.min(0.5, 0.2 + c.I * 0.3 + swell * 0.1),
    );
    if (pat) {
      ctx.save();
      ctx.translate(x, y);
      // Each plate's screen turns at its own rate — the moiré between them is
      // the slow-burning part of the motion.
      ctx.rotate(i * 0.35 + c.beat * (0.01 + i * 0.006));
      ctx.fillStyle = pat;
      ctx.fillRect(-r * 1.6, -r * 1.6, r * 3.2, r * 3.2);
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = ink(c.pal, inkIdx, c.shift, 0.7);
    ctx.lineWidth = Math.max(1, w * 0.0016);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  }

  // A solid bar sweeps the full width once per 4 bars, cutting across everything.
  const sweep = easeInOutCubic(stagger(c.beat, 16, 12));
  if (sweep > 0 && sweep < 1) {
    ctx.fillStyle = ink(c.pal, 2, c.shift, 0.85);
    ctx.fillRect(w * sweep - w * 0.02, 0, w * 0.02, h);
  }

  // Horizon rule, riding the swell.
  ctx.fillStyle = ink(c.pal, 2, c.shift, 0.35);
  ctx.fillRect(0, h * (0.3 + swell * 0.02), w, Math.max(1, h * 0.0016));
}

// ---- Drum & Bass: sliced slabs, CMY misregistration, 16th-note jumps -------

function drawDnb(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const step = Math.floor(c.beat * 4);
  const sub = Math.pow(1 - (c.beat * 4 - step), 3);

  // One heavy mark — a disc, a column and a wedge locked together — rather than
  // a stack of bars. The slicing below only reads as torn if the shape it cuts
  // through has vertical edges to displace.
  const spin = easeInOutCubic(stagger(c.beat, 4, 2)) * (Math.PI / 6);
  const paint = (g: CanvasRenderingContext2D) => {
    g.save();
    g.translate(w * 0.5, h * 0.5);
    g.rotate(-0.18 + spin);
    const R = Math.min(w, h) * 0.34;
    g.beginPath();
    g.arc(-R * 0.35, 0, R, 0, TAU);
    g.fill();
    g.fillRect(-R * 0.2, -R * 1.25, R * 0.55, R * 2.5); // column
    g.beginPath(); // wedge
    g.moveTo(R * 0.5, -R * 1.1);
    g.lineTo(R * 1.7, 0);
    g.lineTo(R * 0.5, R * 1.1);
    g.closePath();
    g.fill();
    g.restore();
  };

  const bands = 9;
  for (let i = 0; i < bands; i++) {
    const jump =
      (c.noise(step, i * 5) - 0.5) * w * 0.06 * (0.3 + c.I * 3.2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, (i / bands) * h, w, h / bands + 1);
    ctx.clip();
    ctx.translate(jump, 0);
    misregister(
      ctx,
      w * 0.004 + sub * w * 0.008,
      0,
      ink(c.pal, 0, c.shift),
      ink(c.pal, 1, c.shift),
      paint,
    );
    ctx.restore();
  }

  // Hairlines between the bands — makes the tearing look specified rather than
  // accidental.
  ctx.fillStyle = ink(c.pal, 2, c.shift, 0.18);
  for (let i = 1; i < bands; i++) {
    ctx.fillRect(0, (i / bands) * h, w, 1);
  }

  // A hard vertical shutter that jumps to a new column every 8th note.
  const shutter = c.noise(Math.floor(c.beat * 2), 7);
  ctx.fillStyle = ink(c.pal, 2, c.shift, 0.9 * sub);
  ctx.fillRect(w * shutter, 0, Math.max(2, w * 0.004), h);

  // Phrase move: the whole frame is squeezed by two shutters closing every 8 beats.
  const close = easeInOutCubic(stagger(c.beat, 8, 6)) * 0.06 * w;
  ctx.fillStyle = paperColor(c.pal, c.shift);
  ctx.fillRect(0, 0, close, h);
  ctx.fillRect(w - close, 0, close, h);
}

// ---- Hip-Hop: cream stock, heavy shapes snapping on the half beat ----------

function drawHipHop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  // The half-beat jogs the whole composition, like a press slipping.
  const hit = Math.pow(1 - ((c.beat * 2) % 1), 5);
  ctx.save();
  ctx.translate(hit * w * 0.006, -hit * w * 0.003);

  const bar = Math.floor(c.beat / 4) % 4;
  const beatIdx = Math.floor(c.beat) % 4;

  // Red block slides between four positions, one per beat, easing out hard.
  const slots = [0.1, 0.36, 0.2, 0.5];
  const rot = Math.floor(c.rand(2) * 4); // scene picks where the cycle starts
  const from = slots[(beatIdx + 3 + rot) % 4];
  const to = slots[(beatIdx + rot) % 4];
  const slide = from + (to - from) * easeOutExpo(Math.min(1, c.phase * 2.2));
  ctx.fillStyle = c1(c, 1);
  ctx.fillRect(w * 0.5, h * slide, w * 0.44, h * (0.24 + c.I * 0.1));

  // Black disc, bleeding off the right edge, scaling in steps once per bar.
  const dr = Math.min(w, h) * (0.26 + bar * 0.02);
  const dx = w * 0.84;
  const dy = h * 0.6;
  ctx.fillStyle = c1(c, 0);
  ctx.beginPath();
  ctx.arc(dx, dy, dr, 0, TAU);
  ctx.fill();

  // Halftone disc knocked over it, offset the other way.
  ctx.save();
  ctx.beginPath();
  ctx.arc(dx - dr * 0.5, dy - dr * 0.3, dr * 0.8, 0, TAU);
  ctx.clip();
  const pat = halftone(ctx, c1(c, 0), 14, Math.min(0.48, 0.22 + c.I * 0.3));
  if (pat) {
    ctx.fillStyle = paperColor(c.pal, c.shift);
    ctx.fillRect(dx - dr * 1.4, dy - dr * 1.2, dr * 2, dr * 2);
    ctx.fillStyle = pat;
    ctx.fillRect(dx - dr * 1.4, dy - dr * 1.2, dr * 2, dr * 2);
  }
  ctx.restore();

  // Heavy left bar, growing across the bar then cutting back — the composition's
  // metronome.
  const grow = easeOutExpo(stagger(c.beat, 4, 0));
  ctx.fillStyle = c1(c, 0);
  ctx.fillRect(0, h * 0.12, w * (0.06 + grow * 0.3), h * 0.1);

  // Slow move: a thin rule crossing the frame over 8 beats.
  const cross = easeInOutCubic(stagger(c.beat, 8, 0));
  ctx.fillStyle = c1(c, 0, 0.8);
  ctx.fillRect(0, h * (0.05 + cross * 0.9), w, Math.max(1, h * 0.003));
  ctx.restore();
}

// ---- Ambient: breathing line screen, discs knocked out of the field --------

function drawAmbient(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
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

  // Two discs knocked out of the field, drifting on very long cycles — the only
  // preset with no beat-rate event, which is the point.
  const discs: [number, number, number, number][] = [
    [0.62, 0.44, 0.24, 0.03],
    [0.26, 0.62, 0.1, -0.017],
  ];
  for (let i = 0; i < discs.length; i++) {
    const [fx, fy, fr, sp] = discs[i];
    const x = w * (fx + 0.03 * Math.sin(c.beat * sp));
    const y = h * (fy + 0.03 * Math.cos(c.beat * sp * 0.77));
    const r = Math.min(w, h) * (fr + breathe * 0.03);
    ctx.fillStyle = paperColor(c.pal, c.shift);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = ink(c.pal, 0, c.shift, 0.4);
    ctx.lineWidth = Math.max(1, w * 0.0012);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  }

  // A band of field re-appears inside the big disc once per 32 beats, sweeping
  // through it — the whole piece's single event.
  const sweep = stagger(c.beat, 32, 24);
  if (sweep > 0 && sweep < 1) {
    const x = w * (0.62 - 0.24) + easeInOutCubic(sweep) * w * 0.48;
    ctx.save();
    ctx.beginPath();
    ctx.arc(w * 0.62, h * 0.44, Math.min(w, h) * 0.24, 0, TAU);
    ctx.clip();
    const pat = lineScreen(ctx, ink(c.pal, 1, c.shift, 0.6), rulings[0], 1);
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(x - w * 0.06, 0, w * 0.12, h);
    }
    ctx.restore();
  }
}

// ---- Pop: flat shapes trading places, printed out of register --------------

function drawPop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const m = w * 0.07;
  const off = w * 0.012 + c.env * w * 0.006 * c.I;
  const beatIdx = Math.floor(c.beat) % 2;
  // The swap eases across the first third of the beat, then holds — a cut with
  // a bit of travel, rather than a constant slide.
  const k = easeInOutCubic(Math.min(1, c.phase * 3));
  const t = beatIdx === 0 ? k : 1 - k;

  const pat = halftone(ctx, c1(c, 0, 0.8), 20, 0.18 + c.I * 0.3);
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);
  }

  const travel = 0.22 + c.rand(4) * 0.3;
  const flip = c.rand(5) < 0.5 ? 1 : -1;
  const ax = w * (0.5 + flip * (0.16 - travel * t));
  const bx = w * (0.5 - flip * (0.16 - travel * t));
  const ar = Math.min(w, h) * (0.15 + c.rand(6) * 0.1 + c.env * 0.02 * c.I);
  const bs = Math.min(w, h) * (0.24 + c.rand(7) * 0.12);

  misregister(
    ctx,
    off,
    off * 0.6,
    c1(c, 2),
    c1(c, 0),
    (g) => {
      g.beginPath();
      g.arc(ax, h * 0.44, ar, 0, TAU);
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
      g.save();
      g.translate(bx, h * 0.5);
      // The square counter-rotates a quarter turn per bar, so the two shapes are
      // never doing the same thing.
      g.rotate(easeInOutCubic(stagger(c.beat, 4, 2)) * (Math.PI / 2));
      g.fillRect(-bs / 2, -bs / 2, bs, bs);
      g.restore();
    },
    'multiply',
  );

  // Frame rule, stepping inward on the downbeat and easing back.
  const pull = easeOutExpo(Math.min(1, (1 - c.bar) * 2)) * w * 0.012;
  ctx.strokeStyle = c1(c, 1, 0.9);
  ctx.lineWidth = Math.max(2, w * 0.003);
  ctx.strokeRect(m * 0.5 + pull, m * 0.5 + pull, w - m - pull * 2, h - m - pull * 2);
}

// ---- Kawaii: Y2K sticker sheet — flat inks, hard black outlines ------------

function drawKawaii(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const outline = c1(c, 2);

  // Checkerboard band scrolls a cell every two beats, in steps rather than
  // smoothly — it should feel switched, not slid.
  const cell = w / 16;
  const scroll = Math.floor(c.beat * 2) * cell * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, h * 0.66, w, h * 0.34);
  ctx.clip();
  for (let x = -2; x < 18; x++) {
    for (let y = 0; y < 6; y++) {
      if ((x + y) % 2) continue;
      ctx.fillStyle = c1(c, 1, 0.85);
      ctx.fillRect(x * cell - (scroll % (cell * 2)), h * 0.66 + y * cell, cell, cell);
    }
  }
  ctx.restore();
  ctx.fillStyle = outline;
  ctx.fillRect(0, h * 0.66 - h * 0.008, w, h * 0.008);

  // Halftone blush, breathing over a bar.
  const blush = Math.min(w, h) * (0.24 + wave(c.beat, 4) * 0.03);
  const pat = halftone(ctx, c1(c, 0, 0.9), 18, 0.3);
  if (pat) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(w * 0.24, h * 0.32, blush, 0, TAU);
    ctx.clip();
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Stickers on a jittered grid, each bouncing on its own beat offset and
  // squashing on landing.
  const items = 6 + Math.round(c.I * 2);
  for (let i = 0; i < items; i++) {
    const r1 = c.rand(i * 3 + 1);
    const r2 = c.rand(i * 5 + 2);
    const bph = (c.beat + r1) % 1;
    const bounce = Math.abs(Math.sin(bph * Math.PI));
    const land = easeOutExpo(Math.min(1, bph * 5)); // squash right after impact
    const cols = 4;
    const gxi = i % cols;
    const gyi = Math.floor(i / cols);
    const x = ((gxi + 0.2 + r1 * 0.6) / cols) * w;
    const y =
      ((gyi + 0.2 + r2 * 0.55) / 2) * h * 0.56 + h * 0.05 - bounce * h * 0.11;
    const s = (0.09 + r2 * 0.06) * Math.min(w, h);
    const kind = i % 3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((r1 - 0.5) * 0.5 + Math.sin(c.beat * 0.5 + i) * 0.12);
    ctx.scale(1 + (1 - land) * 0.16, 1 - (1 - land) * 0.16);
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

  // Phrase move: a big star crosses the sheet every 8 beats, spinning.
  const cross = stagger(c.beat, 8, 4);
  if (cross > 0 && cross < 1) {
    const e = easeInOutCubic(cross);
    ctx.save();
    ctx.translate(-w * 0.1 + e * w * 1.2, h * 0.5 - Math.sin(e * Math.PI) * h * 0.18);
    ctx.rotate(e * TAU);
    ctx.fillStyle = c1(c, 3);
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.min(w, h) * 0.014;
    ctx.lineJoin = 'round';
    starPath(ctx, Math.min(w, h) * 0.09);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ---- Hyperpop / 音割れ: a waveform driven past its ceiling ------------------
//
// The whole preset is built on one idea: clipping. A waveform is pushed until it
// hits a hard ceiling and squares off, the clipped samples turn peak-red, and
// everything else in the frame — the RGB split, the shapes, the cuts — is the
// distortion that follows from being too loud. That is what the music is doing,
// so it is what the picture does.

function drawHyperpop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const step = Math.floor(c.beat * 4); // 16ths: this genre lives on them
  const sub = c.beat * 4 - step;
  const hit = easeOutExpo(Math.min(1, sub * 3));
  const cy = h * 0.5;

  // Candy bands behind everything, re-cut every 16th.
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    if (c.noise(step, i * 13) > 0.35 + c.I * 0.3) continue;
    const by = c.noise(step, i * 7) * h;
    const bh = h * (0.02 + c.noise(step, i * 11) * 0.09);
    ctx.fillStyle = c1(c, i % 3, 0.18 + c.I * 0.22);
    ctx.fillRect(0, by, w, bh);
  }

  // ---- The waveform -------------------------------------------------------
  // Gain rides the beat and the Intensity control; past 1.0 the signal simply
  // cannot get louder, it can only get squarer.
  // Deliberately over unity: the signal is meant to be past the ceiling most of
  // the time, hardest right after each 16th, so the flat tops come and go in
  // rhythm instead of sitting there.
  const gain = (0.8 + c.I * 2.6) * (0.5 + (1 - hit) * 1.6);
  const ceiling = h * 0.32;
  const N = 128;
  const barW = w / N;
  const seedA = c.rand(1) * 10 + 1;
  const seedB = c.rand(2) * 7 + 1;

  const sample = (i: number) => {
    const x = i / N;
    // A few detuned partials plus per-16th noise: musical, not a sine.
    const s =
      Math.sin(x * TAU * seedA + c.beat * 3.1) * 0.55 +
      Math.sin(x * TAU * seedB * 2.3 - c.beat * 5.7) * 0.3 +
      (c.noise(step, i) - 0.5) * 0.5 * c.I;
    return s * gain * ceiling;
  };

  const drawWave = (g: CanvasRenderingContext2D, dx: number) => {
    for (let i = 0; i < N; i++) {
      const v = sample(i);
      const a = Math.min(Math.abs(v), ceiling);
      g.fillRect(dx + i * barW, cy - a, barW * 0.86, a * 2);
    }
  };

  // RGB split: three inks, three offsets, screened together. On a black ground
  // the overlaps go white, which is exactly how a blown-out mix looks.
  const split = w * (0.006 + c.I * 0.022) * (0.3 + (1 - hit));
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let k = 0; k < 3; k++) {
    ctx.fillStyle = c1(c, k);
    drawWave(ctx, (k - 1) * split);
  }
  ctx.restore();

  // Clipped samples get a peak-red cap at the rail — the "overs" on a meter.
  // Only the flat top is red; painting the whole bar would bury the waveform.
  ctx.fillStyle = c1(c, 3);
  const cap = ceiling * 0.16;
  let clipped = 0;
  for (let i = 0; i < N; i++) {
    if (Math.abs(sample(i)) < ceiling) continue;
    clipped++;
    ctx.fillRect(i * barW, cy - ceiling, barW * 0.86, cap);
    ctx.fillRect(i * barW, cy + ceiling - cap, barW * 0.86, cap);
  }

  // The ceiling itself, and — once enough of the signal is flat-topped — the
  // rails light up. No text, just the two lines the waveform is stuck against.
  const over = clipped / N;
  ctx.fillStyle = over > 0.25 ? c1(c, 3) : c1(c, 2, 0.55);
  const railH = Math.max(2, h * (0.004 + over * 0.02));
  ctx.fillRect(0, cy - ceiling - railH, w, railH);
  ctx.fillRect(0, cy + ceiling, w, railH);

  // ---- Shapes popping on the 16ths ---------------------------------------
  // Three stay alive at a time, each scaling down from an overshoot with a hard
  // black keyline, so the frame is always mid-impact somewhere.
  for (let k = 0; k < 3; k++) {
    const s0 = step - k;
    const age = (sub + k) / 3;
    if (age >= 1) continue;
    if (c.noise(s0, 3) > 0.45 + c.I * 0.45) continue;
    const x = c.noise(s0, 1) * w;
    const y = c.noise(s0, 2) * h;
    const size =
      Math.min(w, h) * (0.11 + c.noise(s0, 4) * 0.2) * (1.7 - easeOutExpo(age) * 0.7);
    const kind = Math.floor(c.noise(s0, 5) * 4);
    ctx.save();
    ctx.translate(x, y);
    // Angles snap to 45° steps: shapes read as struck rather than scattered.
    ctx.rotate(Math.floor(c.noise(s0, 6) * 8) * (Math.PI / 4));
    ctx.globalAlpha = 1 - age * 0.35;
    ctx.fillStyle = c1(c, Math.floor(c.noise(s0, 7) * 3));
    ctx.strokeStyle = '#000';
    ctx.lineWidth = size * 0.09;
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 8;
    if (kind === 0) shardPath(ctx, size);
    else if (kind === 1) boltPath(ctx, size);
    else if (kind === 2) bladePath(ctx, size);
    else starPath(ctx, size * 0.55, 4, 0.16); // a spike star, not a sparkle
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // Hard diagonal slashes across the frame — the sharpest mark available, and
  // the one thing that crosses the whole composition.
  const slashes = 1 + Math.round(c.I * 1.5);
  for (let i = 0; i < slashes; i++) {
    if (c.noise(step, 30 + i) > 0.14 + c.I * 0.26) continue;
    const sx = c.noise(step, 40 + i) * w;
    const lean = (c.noise(step, 50 + i) - 0.5) * w * 0.55;
    // Kept thin and tapered: a cut, not a wedge. Wider than this and the slash
    // starts competing with the waveform for the frame.
    const tw = w * (0.002 + c.noise(step, 60 + i) * 0.008);
    const pick = c.noise(step, 70 + i);
    ctx.fillStyle = pick < 0.45 ? c1(c, 3) : pick < 0.75 ? c1(c, 1) : '#fff';
    ctx.beginPath();
    ctx.moveTo(sx, -h * 0.05);
    ctx.lineTo(sx + tw * 1.6, -h * 0.05);
    ctx.lineTo(sx + lean + tw, h * 1.05);
    ctx.lineTo(sx + lean, h * 1.05);
    ctx.closePath();
    ctx.fill();
  }

  // Datamosh: one horizontal slab of the frame is torn sideways per 16th.
  if (c.I > 0.3 && c.noise(step, 21) < 0.15 + c.I * 0.45) {
    const my = c.noise(step, 22) * h * 0.8;
    const mh = h * (0.04 + c.noise(step, 23) * 0.14);
    const md = (c.noise(step, 24) - 0.5) * w * 0.3 * c.I;
    // drawImage from the canvas onto itself stays on the GPU; getImageData here
    // would force a full readback every frame it fires.
    ctx.drawImage(ctx.canvas, 0, my, w, mh, md, my, w, mh);
  }
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

/** A long tapered spike, tip up. */
function shardPath(ctx: CanvasRenderingContext2D, s: number) {
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.62);
  ctx.lineTo(s * 0.2, s * 0.16);
  ctx.lineTo(0, s * 0.5);
  ctx.lineTo(-s * 0.2, s * 0.16);
  ctx.closePath();
}

/** Lightning bolt. */
function boltPath(ctx: CanvasRenderingContext2D, s: number) {
  ctx.beginPath();
  ctx.moveTo(s * 0.1, -s * 0.55);
  ctx.lineTo(-s * 0.3, s * 0.08);
  ctx.lineTo(-s * 0.04, s * 0.08);
  ctx.lineTo(-s * 0.16, s * 0.55);
  ctx.lineTo(s * 0.3, -s * 0.1);
  ctx.lineTo(s * 0.02, -s * 0.1);
  ctx.closePath();
}

/** Angular X — two crossed blades. */
function bladePath(ctx: CanvasRenderingContext2D, s: number) {
  const a = s * 0.5;
  const b = s * 0.12;
  ctx.beginPath();
  ctx.moveTo(-a, -a + b);
  ctx.lineTo(-a + b, -a);
  ctx.lineTo(0, -b);
  ctx.lineTo(a - b, -a);
  ctx.lineTo(a, -a + b);
  ctx.lineTo(b, 0);
  ctx.lineTo(a, a - b);
  ctx.lineTo(a - b, a);
  ctx.lineTo(0, b);
  ctx.lineTo(-a + b, a);
  ctx.lineTo(-a, a - b);
  ctx.lineTo(-b, 0);
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
