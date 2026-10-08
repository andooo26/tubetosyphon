import { contextBridge, ipcRenderer, clipboard } from 'electron';
import type { GenParams } from './gen/params';
import type { LoginState } from './login';
import type {
  AppStatus,
  Blend,
  CSource,
  ChannelId,
  OutputSettings,
  ProjectorState,
  ProjectorStats,
  Quality,
} from './shared';

export type { LoginState };

type Result = Promise<{ ok: boolean; error?: string }>;
type Fader = 'mix' | 'c';

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  // ---- Control UI ----
  registerGuest: (channel: ChannelId, contentsId: number): Result =>
    ipcRenderer.invoke('app:register-guest', channel, contentsId),
  setHideControls: (channel: ChannelId, on: boolean): Result =>
    ipcRenderer.invoke('app:set-hide-controls', channel, on),
  setQuality: (channel: ChannelId, quality: Quality): Result =>
    ipcRenderer.invoke('app:set-quality', channel, quality),
  /** Set a fader: 'mix' = the A/B crossfade, 'c' = deck C's opacity. */
  setLevel: (which: Fader, value: number): Result =>
    ipcRenderer.invoke('app:set-level', which, value),
  fade: (which: Fader, target: number, durationMs: number): Result =>
    ipcRenderer.invoke('app:fade', which, target, durationMs),
  setC: (patch: { source?: CSource; blend?: Blend; clipId?: string }): Result =>
    ipcRenderer.invoke('app:c-set', patch),
  setGen: (patch: Partial<GenParams>): Result => ipcRenderer.invoke('app:c-gen', patch),
  /** Pick video/image files for deck C (native file dialog). */
  addClips: (): Result => ipcRenderer.invoke('app:c-add-clips'),
  removeClip: (id: string): Result => ipcRenderer.invoke('app:c-remove-clip', id),
  setOutput: (patch: Partial<OutputSettings>): Result =>
    ipcRenderer.invoke('app:set-output', patch),
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('app:get-status'),
  onStatus: (cb: (s: AppStatus) => void) => subscribe('app:status', cb),
  readClipboard: (): string => clipboard.readText(),
  /** Open the dedicated Google login window (shared player session). */
  googleLogin: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('app:google-login'),
  googleLogout: (): Promise<LoginState> => ipcRenderer.invoke('app:google-logout'),
  getLoginState: (): Promise<LoginState> => ipcRenderer.invoke('app:get-login-state'),
  onLoginState: (cb: (s: LoginState) => void) => subscribe('app:login-state', cb),
  /** Open the fullscreen projector window on a display (moves it if open). */
  openProjector: (displayId: number): Result =>
    ipcRenderer.invoke('app:projector-open', displayId),
  closeProjector: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('app:projector-close'),

  // ---- Used by the projector window itself ----
  getProjectorState: (): Promise<ProjectorState> =>
    ipcRenderer.invoke('app:projector-get-state'),
  onProjectorState: (cb: (s: ProjectorState) => void) =>
    subscribe('app:projector-state', cb),
  /** One-shot tab-capture id for a deck's player (null if it has none). */
  getDeckSourceId: (channel: ChannelId): Promise<string | null> =>
    ipcRenderer.invoke('app:projector-source-id', channel),
  reportProjectorStats: (stats: ProjectorStats): void =>
    ipcRenderer.send('app:projector-stats', stats),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
