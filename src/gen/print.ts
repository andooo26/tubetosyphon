/**
 * Print toolkit — the shared texture vocabulary the presets draw with.
 *
 * The techniques here (halftone screens, paper grain, deliberate ink
 * misregistration) are what screen-printed and riso'd club flyers actually
 * look like. They are also cheap: patterns are built once
 * per canvas and cached, so a full-frame texture costs one fillRect instead of
 * tens of thousands of arcs.
 */

const TAU = Math.PI * 2;

interface Cache {
  grain?: CanvasPattern | null;
  halftone: Map<string, CanvasPattern | null>;
  lines: Map<string, CanvasPattern | null>;
}

// Patterns belong to the canvas that created them, so cache per context.
const caches = new WeakMap<CanvasRenderingContext2D, Cache>();

function cacheFor(ctx: CanvasRenderingContext2D): Cache {
  let c = caches.get(ctx);
  if (!c) {
    c = { halftone: new Map(), lines: new Map() };
    caches.set(ctx, c);
  }
  return c;
}

function tile(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const c = cv.getContext('2d');
  return c ? [cv, c] : null;
}

/** Monochrome noise tile — the paper grain every ink layer sits on. */
function grainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cache = cacheFor(ctx);
  if (cache.grain !== undefined) return cache.grain;
  const t = tile(128);
  if (!t) return (cache.grain = null);
  const [cv, tc] = t;
  const img = tc.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 26;
  }
  tc.putImageData(img, 0, 0);
  cache.grain = ctx.createPattern(cv, 'repeat');
  return cache.grain;
}

/**
 * Lay paper grain over the whole frame. `jitter` shifts the tile so the noise
 * crawls slightly instead of sitting frozen on top of the animation.
 */
export function grain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  strength = 1,
  jitter = 0,
) {
  const p = grainPattern(ctx);
  if (!p) return;
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.globalCompositeOperation = 'overlay';
  ctx.translate(-((jitter * 37) % 128), -((jitter * 53) % 128));
  ctx.fillStyle = p;
  ctx.fillRect(0, 0, w + 128, h + 128);
  ctx.restore();
}

/**
 * A 45°-screened halftone dot field as a repeating pattern. `cell` is the screen
 * ruling in px and `fill` (0..1) is the dot area — small dots read as a light
 * tint, fat ones as a solid.
 */
export function halftone(
  ctx: CanvasRenderingContext2D,
  color: string,
  cell: number,
  fill: number,
): CanvasPattern | null {
  const key = `${color}|${cell}|${fill.toFixed(2)}`;
  const cache = cacheFor(ctx);
  const hit = cache.halftone.get(key);
  if (hit !== undefined) return hit;
  const t = tile(cell);
  let pat: CanvasPattern | null = null;
  if (t) {
    const [cv, tc] = t;
    const r = (cell / 2) * Math.sqrt(Math.min(1, Math.max(0, fill)));
    tc.fillStyle = color;
    // Two dots on the diagonal give the classic 45° screen angle.
    for (const [x, y] of [
      [0.25, 0.25],
      [0.75, 0.75],
    ]) {
      tc.beginPath();
      tc.arc(x * cell, y * cell, r, 0, TAU);
      tc.fill();
    }
    pat = ctx.createPattern(cv, 'repeat');
  }
  cache.halftone.set(key, pat);
  return pat;
}

/** A horizontal line screen — the other classic print texture. */
export function lineScreen(
  ctx: CanvasRenderingContext2D,
  color: string,
  cell: number,
  weight: number,
): CanvasPattern | null {
  const key = `${color}|${cell}|${weight}`;
  const cache = cacheFor(ctx);
  const hit = cache.lines.get(key);
  if (hit !== undefined) return hit;
  const t = tile(cell);
  let pat: CanvasPattern | null = null;
  if (t) {
    const [cv, tc] = t;
    tc.fillStyle = color;
    tc.fillRect(0, 0, cell, Math.max(1, weight));
    pat = ctx.createPattern(cv, 'repeat');
  }
  cache.lines.set(key, pat);
  return pat;
}

/**
 * Draw `paint` twice, offset, as two inks — the misregistration you get when a
 * two-colour press is a hair out of alignment. One of the fastest ways to make
 * flat vector shapes stop looking computer-generated.
 *
 * `blend` must match the stock: 'multiply' on light paper (ink darkens it),
 * 'screen' on a dark ground (ink adds light). Using screen on light stock blows
 * the shapes out to white, which is how the effect gets mistaken for a glow.
 */
export function misregister(
  ctx: CanvasRenderingContext2D,
  dx: number,
  dy: number,
  inkA: string,
  inkB: string,
  paint: (ctx: CanvasRenderingContext2D) => void,
  blend: 'multiply' | 'screen' = 'screen',
) {
  ctx.save();
  ctx.globalCompositeOperation = blend;
  ctx.translate(-dx, -dy);
  ctx.fillStyle = inkA;
  ctx.strokeStyle = inkA;
  paint(ctx);
  ctx.translate(dx * 2, dy * 2);
  ctx.fillStyle = inkB;
  ctx.strokeStyle = inkB;
  paint(ctx);
  ctx.restore();
}
