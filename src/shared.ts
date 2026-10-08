// Types + small helpers shared by the main process, the preload and both
// renderer roots (control UI and projector).

/**
 * Session partition used by both player <webview>s and the Google login window.
 * Sharing one partition means a single login (cookies) applies to both players.
 */
export const PLAYER_PARTITION = 'persist:player';

export type ChannelId = 'left' | 'right';
export const CHANNELS: readonly ChannelId[] = ['left', 'right'];

// YouTube playback-quality target. 'auto' lets YouTube's ABR decide; 'highest'
// forces the best available; the rest are YouTube's own quality-level ids and
// mean "best available at or below this level".
export type Quality =
  | 'auto'
  | 'highest'
  | 'hd2160'
  | 'hd1440'
  | 'hd1080'
  | 'hd720'
  | 'large'
  | 'medium';

/**
 * Where the video pixels are drawn inside a player's viewport (guest CSS px),
 * plus the viewport size it was measured against. The projector crops the
 * captured viewport to this region so a video is never letterboxed twice.
 */
export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewW: number;
  viewH: number;
}

/** What the projector needs to show one deck. */
export interface DeckFeed {
  /** Player webContents to capture; changes when the <webview> is recreated. */
  guestId: number | null;
  /** False on a YouTube browse page (home/search): the deck shows black. */
  live: boolean;
  /** Crop region, or null to show the whole viewport. */
  rect: VideoRect | null;
}

/** A crossfade in progress: alpha runs from `from` to `to` over `dur` ms. */
export interface MixAnim {
  from: number;
  to: number;
  start: number; // Date.now() at the start
  dur: number;
}

/** Capture size/rate of each deck feed (the projector's picture quality). */
export interface OutputSettings {
  height: 1080 | 720;
  fps: 60 | 30;
}

export const DEFAULT_OUTPUT: OutputSettings = { height: 1080, fps: 60 };

/** Everything the projector window renders from (pushed by main on change). */
export interface ProjectorState {
  decks: Record<ChannelId, DeckFeed>;
  alpha: number; // 0 = A (left), 1 = B (right)
  anim: MixAnim | null;
  output: OutputSettings;
}

/** Per-deck figures the projector reports back once a second. */
export interface DeckStats {
  fps: number; // frames actually presented by the projector
  width: number; // capture size
  height: number;
  error: string | null;
}

export type ProjectorStats = Record<ChannelId, DeckStats>;

export const EMPTY_DECK_STATS: DeckStats = {
  fps: 0,
  width: 0,
  height: 0,
  error: null,
};

export interface DisplayInfo {
  id: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface ProjectorStatus {
  open: boolean;
  displayId: number | null;
  displays: DisplayInfo[];
  stats: ProjectorStats;
}

export interface DeckStatus {
  live: boolean;
  hideControls: boolean;
  quality: Quality;
}

export interface AppStatus {
  left: DeckStatus;
  right: DeckStatus;
  alpha: number;
  fading: boolean;
  projector: ProjectorStatus;
  output: OutputSettings;
}

/** The crossfade position at `now` (smoothstep easing while a fade runs). */
export function mixAt(alpha: number, anim: MixAnim | null, now: number): number {
  if (!anim) return alpha;
  const t = anim.dur > 0 ? Math.min(1, Math.max(0, (now - anim.start) / anim.dur)) : 1;
  const e = t * t * (3 - 2 * t);
  return anim.from + (anim.to - anim.from) * e;
}
