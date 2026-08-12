/**
 * Parameters for the "汎用" (generic) generative-graphics mode.
 *
 * No video source: the visuals are drawn from scratch on a canvas and driven by
 * a musical clock (BPM + a beat epoch) plus a genre preset. Both the offscreen
 * output window and the in-app preview render from these same values, so what
 * the user sees is what Syphon receives.
 */

export type Genre = 'techno' | 'house' | 'dnb' | 'hiphop' | 'ambient' | 'pop';

export interface GenParams {
  bpm: number;
  genre: Genre;
  /** 0..1 — how busy/bright the sketch is (layer count, flash strength). */
  intensity: number;
  /** 0..359 — base hue; each genre derives its palette from it. */
  hue: number;
  /** ms timestamp of "beat 0". Tap tempo / Sync resets it to re-align the phase. */
  beatEpoch: number;
}

// Typical tempo per genre — picked when the user switches genre so the visuals
// are in a sensible range without touching the BPM field.
export const GENRES: { value: Genre; label: string; bpm: number }[] = [
  { value: 'techno', label: 'Techno', bpm: 132 },
  { value: 'house', label: 'House', bpm: 124 },
  { value: 'dnb', label: 'Drum & Bass', bpm: 174 },
  { value: 'hiphop', label: 'Hip-Hop', bpm: 90 },
  { value: 'ambient', label: 'Ambient', bpm: 70 },
  { value: 'pop', label: 'Pop / EDM', bpm: 128 },
];

export const MIN_BPM = 40;
export const MAX_BPM = 240;

export const DEFAULT_GEN_PARAMS: GenParams = {
  bpm: 132,
  genre: 'techno',
  intensity: 0.6,
  hue: 205,
  beatEpoch: 0, // 0 => "start of stream"; the renderer substitutes its own start
};

export function clampGenParams(p: Partial<GenParams>, base: GenParams): GenParams {
  const bpm = typeof p.bpm === 'number' && isFinite(p.bpm) ? p.bpm : base.bpm;
  const intensity =
    typeof p.intensity === 'number' && isFinite(p.intensity)
      ? p.intensity
      : base.intensity;
  const hue = typeof p.hue === 'number' && isFinite(p.hue) ? p.hue : base.hue;
  const genre = GENRES.some((g) => g.value === p.genre)
    ? (p.genre as Genre)
    : base.genre;
  const beatEpoch =
    typeof p.beatEpoch === 'number' && isFinite(p.beatEpoch)
      ? p.beatEpoch
      : base.beatEpoch;
  return {
    bpm: Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)),
    genre,
    intensity: Math.min(1, Math.max(0, intensity)),
    hue: ((hue % 360) + 360) % 360,
    beatEpoch,
  };
}
