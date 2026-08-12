/**
 * The generative sketch for 汎用 (generic) mode.
 *
 * One pure function: given a 2D context, its size, the wall-clock time and the
 * GenParams, draw one full frame. No internal state, so the offscreen output
 * window and the small UI preview stay in phase simply by sharing `beatEpoch`.
 *
 * Everything is drawn with canvas primitives (gradients, paths, blend modes) —
 * no per-pixel JS — so a 1920x1080 frame stays cheap enough for 60 fps.
 */

import type { GenParams, Genre } from './params';

const TAU = Math.PI * 2;

// How hard the closing vignette bites, per preset. The dark presets want the
// full amount; the bright ones (kawaii) would turn muddy, and Minimal is mostly
// black already so a heavy vignette just eats its few marks.
const VIGNETTE: Record<Genre, number> = {
  techno: 0.55,
  house: 0.55,
  dnb: 0.55,
  hiphop: 0.55,
  ambient: 0.55,
  pop: 0.55,
  kawaii: 0.16,
};

/** Deterministic pseudo-random in [0,1) — same value for the same index. */
function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h.toFixed(1)}, ${s}%, ${l}%, ${a})`;
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
  /** Base hue. */
  hue: number;
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
  const beatMs = 60000 / Math.max(20, Math.min(300, p.bpm));
  const beat = (nowMs - p.beatEpoch) / beatMs;
  const phase = beat - Math.floor(beat);
  const barPhase = (beat / 4) % 1;
  const c: Clock = {
    beat,
    t: (nowMs - p.beatEpoch) / 1000,
    phase,
    env: Math.pow(1 - phase, 3),
    bar: Math.pow(1 - barPhase, 5),
    I: p.intensity,
    hue: p.hue,
  };

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
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

  // Shared finish: a subtle vignette keeps the edges from clipping to flat white
  // on projectors and gives every preset the same "one system" look.
  const vig = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.25,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.72,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, `rgba(0,0,0,${VIGNETTE[p.genre] ?? 0.55})`);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---- Techno: hard-edged tunnel of rings, strobe on the downbeat -------------

function drawTechno(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.hypot(w, h) / 2;
  const rings = 10 + Math.round(c.I * 10);
  const spin = c.beat * 0.12;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spin);
  ctx.lineWidth = 3 + c.I * 6;
  for (let i = rings; i > 0; i--) {
    // Each ring marches outward one slot per beat, so the tunnel "steps" in time.
    const k = (i + c.beat * 0.5) % rings;
    const r = Math.pow(k / rings, 2.2) * R * 1.35;
    if (r < 4) continue;
    const fade = 1 - k / rings;
    const l = 20 + fade * 45 + c.env * c.I * 25;
    ctx.strokeStyle = hsl(c.hue + k * 6, 85, l, 0.28 + fade * 0.6);
    ctx.beginPath();
    // Square rings read harder than circles — the techno look.
    ctx.rect(-r, (-r * h) / w, r * 2, (r * 2 * h) / w);
    ctx.stroke();
  }
  ctx.restore();

  // Centre core that punches on every beat.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.12 + c.env * 0.3));
  core.addColorStop(0, hsl(c.hue + 20, 100, 70, 0.55 + c.env * 0.45));
  core.addColorStop(1, hsl(c.hue, 100, 50, 0));
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);

  // Downbeat strobe bars.
  if (c.bar > 0.35) {
    const bars = 14;
    ctx.fillStyle = `rgba(255,255,255,${(c.bar - 0.35) * 0.5 * c.I})`;
    for (let i = 0; i < bars; i += 2) {
      ctx.fillRect(0, (i / bars) * h, w, h / bars);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---- House: warm orbiting blobs over a scrolling perspective grid -----------

function drawHouse(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  // Deep gradient backdrop, swelling over a 8-beat phrase.
  const swell = wave(c.beat, 8);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, hsl(c.hue + 300, 60, 6 + swell * 6));
  bg.addColorStop(1, hsl(c.hue + 20, 70, 10 + swell * 8));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Orbiting light blobs.
  ctx.globalCompositeOperation = 'lighter';
  const blobs = 3 + Math.round(c.I * 3);
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * TAU + c.beat * 0.16 + rnd(i) * TAU;
    const rr = Math.min(w, h) * (0.18 + 0.16 * Math.sin(c.beat * 0.11 + i));
    const x = w / 2 + Math.cos(a) * w * 0.28;
    const y = h / 2 + Math.sin(a * 1.3) * h * 0.26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr * (1 + c.env * 0.18 * c.I));
    const hu = c.hue + 30 + i * 26;
    g.addColorStop(0, hsl(hu, 90, 60, 0.5 + c.I * 0.3));
    g.addColorStop(0.5, hsl(hu, 90, 45, 0.16));
    g.addColorStop(1, hsl(hu, 90, 40, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Perspective floor grid scrolling one row per beat.
  const horizon = h * 0.62;
  ctx.strokeStyle = hsl(c.hue + 40, 90, 60, 0.35 + c.env * 0.25);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = -10; i <= 10; i++) {
    ctx.moveTo(w / 2 + i * (w / 12), h);
    ctx.lineTo(w / 2 + i * (w / 90), horizon);
  }
  const rows = 16;
  for (let i = 0; i < rows; i++) {
    const k = (i + (c.beat % 1)) / rows;
    const y = horizon + Math.pow(k, 2.6) * (h - horizon) * 1.6;
    if (y > h) continue;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

// ---- Drum & Bass: fast glitch slices + scanlines ---------------------------

function drawDnb(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  // 16th-note step index drives the glitch seed, so it re-rolls in tempo.
  const step = Math.floor(c.beat * 4);
  const sub = c.beat * 4 - step;
  const kick = Math.pow(1 - sub, 4);

  ctx.fillStyle = hsl(c.hue + 260, 45, 5);
  ctx.fillRect(0, 0, w, h);

  // Horizontal slices offset like a torn signal.
  const slices = 12 + Math.round(c.I * 22);
  for (let i = 0; i < slices; i++) {
    const r1 = rnd(step * 31 + i);
    const r2 = rnd(step * 17 + i * 7);
    const y = r1 * h;
    const sh = (0.01 + r2 * 0.07) * h;
    const off = (r2 - 0.5) * w * 0.5 * (0.3 + c.I);
    const hu = c.hue + (r1 < 0.5 ? 0 : 150) + r2 * 40;
    ctx.fillStyle = hsl(hu, 95, 20 + r2 * 45, 0.25 + r1 * 0.5);
    ctx.fillRect(off, y, w * (0.2 + r2 * 0.9), sh);
  }

  // Beat bar: a bright block sweeping left->right once per bar.
  const sweep = ((c.beat / 4) % 1) * (w + 200) - 100;
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(sweep - 120, 0, sweep + 120, 0);
  g.addColorStop(0, hsl(c.hue, 100, 50, 0));
  g.addColorStop(0.5, hsl(c.hue, 100, 65, 0.35 + c.I * 0.35));
  g.addColorStop(1, hsl(c.hue, 100, 50, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Kick flash.
  ctx.fillStyle = `rgba(255,255,255,${kick * 0.16 * c.I})`;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  // Scanlines.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);
}

// ---- Hip-Hop: slow bounce, chunky shapes, chromatic offset -----------------

function drawHipHop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, hsl(c.hue + 20, 45, 8));
  bg.addColorStop(1, hsl(c.hue - 20, 55, 12));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Diagonal stripes drifting half a beat per bar.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.42);
  ctx.translate(-w, -h);
  const stripeW = w / 9;
  for (let i = 0; i < 26; i++) {
    const x = ((i * stripeW + c.beat * stripeW * 0.25) % (w * 2)) + 0;
    ctx.fillStyle = hsl(c.hue + 30 + (i % 3) * 18, 65, 14 + (i % 2) * 6, 0.9);
    ctx.fillRect(x, 0, stripeW * 0.5, h * 2);
  }
  ctx.restore();

  // Big bouncing disc — "boom bap" on the half beat, with a chromatic split.
  const bounce = Math.pow(1 - ((c.beat * 2) % 1), 3);
  const R = Math.min(w, h) * (0.2 + bounce * 0.06 + c.I * 0.08);
  const cx = w / 2 + Math.sin(c.beat * 0.5) * w * 0.12;
  const cy = h / 2 - bounce * h * 0.05;
  const split = 6 + bounce * 22 * c.I;
  ctx.globalCompositeOperation = 'lighter';
  const parts: [number, number, number][] = [
    [-split, 0, c.hue],
    [split, 0, c.hue + 150],
    [0, -split * 0.5, c.hue + 60],
  ];
  for (const [dx, dy, hu] of parts) {
    ctx.fillStyle = hsl(hu, 90, 45, 0.55);
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, R, 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // Ring outline, punching once per bar.
  ctx.strokeStyle = hsl(c.hue + 40, 20, 92, 0.35 + c.bar * 0.45);
  ctx.lineWidth = 4 + c.bar * 12;
  ctx.beginPath();
  ctx.arc(cx, cy, R * (1.25 + c.bar * 0.35), 0, TAU);
  ctx.stroke();
}

// ---- Ambient: slow drifting nebula, no beat flashes ------------------------

function drawAmbient(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  ctx.fillStyle = hsl(c.hue + 220, 40, 5);
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'lighter';
  const clouds = 5 + Math.round(c.I * 4);
  for (let i = 0; i < clouds; i++) {
    const s = rnd(i) * TAU;
    // Everything moves on a very slow multiple of the tempo (16-beat phrases).
    const a = c.beat * 0.02 + s;
    const x = w * (0.5 + 0.34 * Math.sin(a * (0.6 + rnd(i + 9) * 0.5)));
    const y = h * (0.5 + 0.3 * Math.cos(a * (0.4 + rnd(i + 21) * 0.6)));
    const r = Math.min(w, h) * (0.25 + 0.22 * wave(c.beat, 16 + i * 3));
    const hu = c.hue + 180 + i * 22 + Math.sin(a) * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hsl(hu, 70, 45, 0.22 + c.I * 0.14));
    g.addColorStop(0.6, hsl(hu, 70, 30, 0.07));
    g.addColorStop(1, hsl(hu, 70, 25, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // A drifting star field for depth.
  for (let i = 0; i < 140; i++) {
    const x = ((rnd(i) * w + c.t * (4 + rnd(i + 3) * 10)) % (w + 20)) - 10;
    const y = rnd(i + 77) * h;
    const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(c.t * (0.5 + rnd(i + 5)) + i));
    ctx.fillStyle = hsl(c.hue + 200, 30, 90, tw * 0.5);
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---- Pop / EDM: confetti + a burst ring on every beat ----------------------

function drawPop(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const bg = ctx.createRadialGradient(
    w / 2,
    h / 2,
    0,
    w / 2,
    h / 2,
    Math.hypot(w, h) / 2,
  );
  bg.addColorStop(0, hsl(c.hue + 40, 70, 12 + c.env * 8 * c.I));
  bg.addColorStop(1, hsl(c.hue + 280, 60, 5));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Expanding rings — one born per beat, three alive at a time.
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 3; k++) {
    const age = c.phase + k; // in beats
    const life = age / 3;
    if (life >= 1) continue;
    const r = Math.pow(life, 0.6) * Math.hypot(w, h) * 0.55;
    ctx.strokeStyle = hsl(c.hue + k * 50 + c.beat * 6, 95, 62, (1 - life) * 0.65);
    ctx.lineWidth = (2 + c.I * 16) * (1 - life);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, TAU);
    ctx.stroke();
  }

  // Confetti falling and re-seeded each bar.
  const n = 60 + Math.round(c.I * 140);
  for (let i = 0; i < n; i++) {
    const speed = 0.25 + rnd(i) * 0.55;
    const y = ((rnd(i + 11) + c.beat * speed * 0.25) % 1.2 - 0.1) * h;
    const x = rnd(i + 3) * w + Math.sin(c.beat * 0.8 + i) * 24;
    const s = 5 + rnd(i + 7) * (10 + c.I * 16);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(c.beat * (1 + rnd(i + 5) * 3));
    ctx.fillStyle = hsl(c.hue + rnd(i + 13) * 200, 95, 65, 0.85);
    ctx.fillRect(-s / 2, -s / 4, s, s / 2);
    ctx.restore();
  }

  // Star polygon pulsing on the beat.
  const R = Math.min(w, h) * (0.16 + c.env * 0.06 + c.I * 0.05);
  ctx.strokeStyle = hsl(c.hue + 180, 100, 75, 0.4 + c.env * 0.5);
  ctx.lineWidth = 3 + c.env * 8;
  ctx.beginPath();
  const points = 5;
  for (let i = 0; i <= points * 2; i++) {
    const a = (i / (points * 2)) * TAU - Math.PI / 2 + c.beat * 0.1;
    const rr = i % 2 === 0 ? R : R * 0.45;
    const x = w / 2 + Math.cos(a) * rr;
    const y = h / 2 + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

// ---- Shape helpers (used by the presets below) -----------------------------

/** Heart outline centred on (0,0), `s` tall, as a path on the current context. */
function heartPath(ctx: CanvasRenderingContext2D, s: number) {
  // Parametric heart sampled as a polyline — always closes cleanly, and 40
  // segments is indistinguishable from curves at these sizes.
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

/** Four-pointed sparkle centred on (0,0), `s` across. */
function sparklePath(ctx: CanvasRenderingContext2D, s: number) {
  const r = s / 2;
  const w = s * 0.14;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(w, -w, r, 0);
  ctx.quadraticCurveTo(w, w, 0, r);
  ctx.quadraticCurveTo(-w, w, -r, 0);
  ctx.quadraticCurveTo(-w, -w, 0, -r);
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

// ---- Kawaii: pastel, hearts & sparkles, squash-and-stretch on the beat ------

function drawKawaii(ctx: CanvasRenderingContext2D, w: number, h: number, c: Clock) {
  const pulse = c.env * c.I;
  // Kawaii lives or dies on the palette, so the hue slider is *damped* here: it
  // shifts the look across pink -> lavender -> peach instead of sweeping the
  // whole wheel and landing on, say, olive.
  const kh = 300 + (c.hue / 360) * 90;
  // Pastel sky: pink at the top into mint at the bottom, brightening on the beat.
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, hsl(kh, 95, 84 + pulse * 5));
  bg.addColorStop(0.55, hsl(kh + 30, 90, 88 + pulse * 4));
  bg.addColorStop(1, hsl(kh + 210, 80, 86 + pulse * 4));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Big soft polka dots drifting upward, one row per 2 beats.
  const cols = 7;
  const dotR = w / cols / 3.4;
  for (let gy = -1; gy < 6; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const stagger = gy % 2 ? 0.5 : 0;
      const x = ((gx + stagger) / cols) * w + w / cols / 2;
      const y = ((gy + 1 - ((c.beat * 0.5) % 1)) / 5) * (h * 1.2) - h * 0.1;
      ctx.fillStyle = hsl(kh + 10 + ((gx + gy) % 3) * 40, 90, 92, 0.5);
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, TAU);
      ctx.fill();
    }
  }

  // A wavy ribbon across the middle.
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 10 + pulse * 8;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 12) {
    const y =
      h * 0.5 +
      Math.sin(x / (w / 3) + c.beat * 0.6) * h * 0.09 +
      Math.sin(x / (w / 7) - c.beat * 0.4) * h * 0.03;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Hearts and stars bouncing on the beat, with a squash-and-stretch wobble.
  const items = 6 + Math.round(c.I * 6);
  for (let i = 0; i < items; i++) {
    const r1 = rnd(i * 3 + 1);
    const r2 = rnd(i * 5 + 2);
    // Each item bounces on its own beat offset so they don't all land together.
    const off = r1;
    const bph = (c.beat + off) % 1;
    const bounce = Math.abs(Math.sin(bph * Math.PI));
    const x = (r1 * 0.86 + 0.07) * w + Math.sin(c.beat * 0.4 + i) * w * 0.02;
    const y = (r2 * 0.7 + 0.12) * h - bounce * h * 0.06;
    const s = (0.06 + r2 * 0.06) * Math.min(w, h) * (1 + c.I * 0.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(c.beat * 0.5 + i) * 0.25);
    // Squash on landing, stretch at the top of the bounce.
    ctx.scale(1 + (1 - bounce) * 0.14, 1 - (1 - bounce) * 0.14);
    const hu = kh + r1 * 70;
    ctx.fillStyle = hsl(hu, 95, 72);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 5;
    if (i % 3 === 0) starPath(ctx, s * 0.55);
    else heartPath(ctx, s);
    ctx.fill();
    ctx.stroke();
    // Highlight blob — the "つやつや" dot.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(-s * 0.16, -s * 0.16, s * 0.09, s * 0.06, -0.6, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Twinkling sparkles on the 8ths.
  const tw = 18 + Math.round(c.I * 26);
  for (let i = 0; i < tw; i++) {
    const ph = (c.beat * 2 + rnd(i + 41)) % 1;
    const a = Math.pow(1 - ph, 2);
    if (a < 0.05) continue;
    const s = (6 + rnd(i + 13) * 26) * (0.5 + a);
    ctx.save();
    ctx.translate(rnd(i + 7) * w, rnd(i + 29) * h);
    ctx.rotate(rnd(i + 3) * TAU);
    ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`;
    sparklePath(ctx, s);
    ctx.fill();
    ctx.restore();
  }
}
