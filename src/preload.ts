import { contextBridge, ipcRenderer, clipboard } from 'electron';

export type ChannelId = 'left' | 'right';

export interface ChannelStatus {
  running: boolean;
  capturing: boolean;
  hasClients: boolean;
  fps: number;
  serverName: string;
  error: string | null;
  testFrame: boolean;
  hideControls: boolean;
}

export interface AppStatus {
  left: ChannelStatus;
  right: ChannelStatus;
}

const api = {
  registerGuest: (
    channel: ChannelId,
    contentsId: number,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('app:register-guest', channel, contentsId),
  startOutput: (channel: ChannelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:start-output', channel),
  stopOutput: (channel: ChannelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:stop-output', channel),
  testFrame: (
    channel: ChannelId,
    on: boolean,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:test-frame', channel, on),
  setHideControls: (
    channel: ChannelId,
    on: boolean,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-hide-controls', channel, on),
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('app:get-status'),
  onStatus: (cb: (s: AppStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: AppStatus) => cb(s);
    ipcRenderer.on('app:status', listener);
    return () => {
      ipcRenderer.removeListener('app:status', listener);
    };
  },
  readClipboard: (): string => clipboard.readText(),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
