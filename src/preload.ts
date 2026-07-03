import { contextBridge, ipcRenderer, clipboard } from 'electron';

export interface AppStatus {
  running: boolean;
  capturing: boolean;
  hasClients: boolean;
  fps: number;
  serverName: string;
  error: string | null;
  testFrame: boolean;
  hideControls: boolean;
}

const api = {
  startOutput: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:start-output'),
  stopOutput: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:stop-output'),
  testFrame: (on: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:test-frame', on),
  setHideControls: (on: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-hide-controls', on),
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
