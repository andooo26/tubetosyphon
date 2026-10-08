import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import {
  EMPTY_DECK_STATS,
  type DisplayInfo,
  type ProjectorState,
  type ProjectorStats,
  type ProjectorStatus,
} from './shared';

// ---- Projector output -----------------------------------------------------
// A frameless fullscreen window on a chosen display: the app's output.
//
// No pixels pass through the main process. The window captures both player
// <webview>s itself with Chromium's tab capture (getUserMedia with a media
// source id from webContents.getMediaSourceId) and crossfades the two live
// <video>s with CSS opacity, so capture, scaling and mixing all stay on the
// GPU/compositor. Main only pushes the small ProjectorState (which guests,
// crop rects, fader) and receives fps figures back.

let win: BrowserWindow | null = null;
let displayId: number | null = null;
let stats: ProjectorStats = { left: EMPTY_DECK_STATS, right: EMPTY_DECK_STATS };
let statsStamp = 0;

export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primaryId,
  }));
}

export function isProjectorOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function projectorContents(): Electron.WebContents | null {
  return win && !win.isDestroyed() ? win.webContents : null;
}

export function projectorStatus(): ProjectorStatus {
  const open = isProjectorOpen();
  // No report for a while = the window is gone or stuck: don't show stale fps.
  const fresh = open && Date.now() - statsStamp < 2500;
  return {
    open,
    displayId,
    displays: listDisplays(),
    stats: fresh ? stats : { left: EMPTY_DECK_STATS, right: EMPTY_DECK_STATS },
  };
}

/** Open (or move) the projector window onto `id`. */
export function openProjector(
  id: number,
  load: (win: BrowserWindow, search: string) => void,
  onClosed: () => void,
): { ok: boolean; error?: string } {
  const display = screen.getAllDisplays().find((d) => d.id === id);
  if (!display) return { ok: false, error: 'Display not found' };

  // Re-targeting an open window: close and reopen on the new display. Moving a
  // fullscreen window across displays is unreliable on both platforms.
  closeProjector();

  const b = display.bounds;
  const w = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    title: 'Projector',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // May sit behind other windows on a shared display; keep drawing anyway.
      backgroundThrottling: false,
    },
  });
  win = w;
  displayId = id;
  statsStamp = 0;

  w.once('ready-to-show', () => {
    w.show();
    // macOS: "simple" fullscreen covers the display (menu bar included)
    // without creating a new Space, so there is no slide animation.
    if (process.platform === 'darwin') w.setSimpleFullScreen(true);
    else w.setFullScreen(true);
  });
  w.on('closed', () => {
    if (win === w) {
      win = null;
      displayId = null;
    }
    onClosed();
  });

  load(w, 'projector=1');
  return { ok: true };
}

export function closeProjector(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  displayId = null;
}

/** Close the window if its display was unplugged. */
export function handleDisplayRemoved(id: number): void {
  if (id === displayId) closeProjector();
}

export function sendProjectorState(state: ProjectorState): void {
  const wc = projectorContents();
  if (wc) wc.send('app:projector-state', state);
}

/** Store the figures the window reports. True when they changed. */
export function setProjectorStats(next: ProjectorStats): boolean {
  statsStamp = Date.now();
  const changed = JSON.stringify(next) !== JSON.stringify(stats);
  stats = next;
  return changed;
}
