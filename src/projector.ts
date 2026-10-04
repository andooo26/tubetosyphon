import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

// ---- Projector output -----------------------------------------------------
// A frameless fullscreen window on a chosen display (projector) that shows one
// of the outputs: A / B / the VJ mix, or the generative sketch.
//
// A / B / VJ frames are the same finished RGBA buffers that go to Syphon/Spout;
// main pushes them over IPC (~2.5ms per 1080p frame) and the window draws them
// with WebGL. Flow control: at most one frame in flight — frames that arrive
// while the window is still drawing are dropped, so a slow projector window
// never builds up an IPC backlog.
//
// The generative source needs no frames at all: the window renders the same
// GenCanvas (same params + wall clock) itself, like the UI preview does.

export type ProjectorSource = 'left' | 'right' | 'vj' | 'gen';

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
  source: ProjectorSource;
  fps: number; // frames actually drawn by the projector window (A / B / VJ)
  displays: DisplayInfo[];
}

let win: BrowserWindow | null = null;
let displayId: number | null = null;
let source: ProjectorSource = 'left';
let inFlight = false;
let inFlightSince = 0;
// A lost ack (e.g. the window reloaded mid-frame) must not stall the feed.
const ACK_TIMEOUT_MS = 500;

let framesThisSecond = 0;
let lastFpsStamp = Date.now();
let measuredFps = 0;

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

export function projectorStatus(): ProjectorStatus {
  return {
    open: !!win && !win.isDestroyed(),
    displayId,
    source,
    // No acks for a while = no frames arriving: don't show a stale figure.
    fps: Date.now() - lastFpsStamp > 2000 ? 0 : measuredFps,
    displays: listDisplays(),
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
  inFlight = false;
  measuredFps = 0;

  w.once('ready-to-show', () => {
    w.show();
    // macOS: "simple" fullscreen covers the display (menu bar included)
    // without creating a new Space, so there is no slide animation and the
    // window stays put on the projector.
    if (process.platform === 'darwin') w.setSimpleFullScreen(true);
    else w.setFullScreen(true);
  });
  w.webContents.on('did-finish-load', () => {
    inFlight = false;
  });
  w.on('closed', () => {
    if (win === w) {
      win = null;
      displayId = null;
      measuredFps = 0;
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
  measuredFps = 0;
}

export function setProjectorSource(next: ProjectorSource): void {
  source = next;
  inFlight = false;
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:projector-source', source);
  }
}

/** The source currently on the projector, or null when it is closed. */
export function activeProjectorSource(): ProjectorSource | null {
  return win && !win.isDestroyed() ? source : null;
}

/** Close the window if its display was unplugged. */
export function handleDisplayRemoved(id: number): void {
  if (id === displayId) closeProjector();
}

/**
 * Offer one finished RGBA frame from `from`. Ignored unless the projector is
 * open and showing that source, and dropped while the previous one is drawing.
 */
export function projectFrame(
  from: ProjectorSource,
  rgba: Uint8Array,
  width: number,
  height: number,
): void {
  if (from !== source || !win || win.isDestroyed()) return;
  const now = Date.now();
  if (inFlight && now - inFlightSince < ACK_TIMEOUT_MS) return;
  inFlight = true;
  inFlightSince = now;
  // send() serialises (copies) synchronously, so the caller may reuse rgba.
  win.webContents.send('app:projector-frame', {
    data: rgba.subarray(0, width * height * 4),
    width,
    height,
  });
}

/** The window finished drawing the last frame. Returns true once per second
 * when the fps figure changed (so the caller can push a status update). */
export function projectorFrameDone(): boolean {
  inFlight = false;
  framesThisSecond++;
  const now = Date.now();
  if (now - lastFpsStamp >= 1000) {
    const changed = measuredFps !== framesThisSecond;
    measuredFps = framesThisSecond;
    framesThisSecond = 0;
    lastFpsStamp = now;
    return changed;
  }
  return false;
}

/** Forward generative params so a 'gen' projector stays in sync. */
export function sendToProjector(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
