/**
 * SpoutManager — the Windows counterpart of SyphonManager (main process only).
 *
 * Publishes CPU frames through our own minimal Spout sender addon
 * (native/spout, built from the vendored Spout2 SDK by scripts/build-spout.js).
 * Same surface as SyphonManager so main.ts drives both through FrameOutput.
 *
 * Differences from Syphon:
 * - DX11 textures are top-left origin like Electron's bitmaps: no flip.
 * - Spout has no notion of connected receivers, so hasClients is null (unknown).
 */

import { app } from 'electron';
import path from 'node:path';
import type { FrameOutput } from './output';

interface SpoutAddon {
  createSender(name: string): object;
  sendImage(
    sender: object,
    rgba: Uint8Array,
    width: number,
    height: number,
  ): boolean;
  releaseSender(sender: object): void;
}

// In dev the addon sits in its node-gyp build dir. When packaged it is staged
// by build-native-bundle.js into Resources/node_modules (see forge.config.ts).
function addonPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'node_modules', 'spout-addon', 'spout.node')
    : path.join(app.getAppPath(), 'native', 'spout', 'build', 'Release', 'spout.node');
}

let addon: SpoutAddon | null = null;
function loadAddon(): SpoutAddon {
  // A native .node addon at a runtime path can only be loaded with require().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (!addon) addon = require(addonPath()) as SpoutAddon;
  return addon;
}

export class SpoutManager implements FrameOutput {
  private sender: object | null = null;
  private lastError: string | null = null;
  // BGRA -> RGBA scratch for publishBGRA, grown on demand (see SyphonManager).
  private swizzleBuf: Uint8Array | null = null;

  constructor(private readonly serverName = 'URLtoSyphon') {}

  start(): boolean {
    if (this.sender) return true;
    try {
      this.sender = loadAddon().createSender(this.serverName);
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError =
        `Failed to initialise Spout (native/spout). ` +
        `Was it built? Run 'npm run build:spout' (needs the Visual Studio ` +
        `Build Tools). Original error: ${
          err instanceof Error ? err.message : String(err)
        }`;
      this.sender = null;
      return false;
    }
  }

  get isRunning(): boolean {
    return this.sender !== null;
  }

  get error(): string | null {
    return this.lastError;
  }

  get hasClients(): boolean | null {
    return null;
  }

  publishBGRA(bgra: Uint8Array, width: number, height: number): boolean {
    if (!this.sender) return false;
    const expected = width * height * 4;
    if (bgra.length < expected) {
      this.lastError = `Frame buffer too small: got ${bgra.length}, need ${expected}`;
      return false;
    }
    if (!this.swizzleBuf || this.swizzleBuf.length < expected) {
      this.swizzleBuf = new Uint8Array(expected);
    }
    const out = this.swizzleBuf;
    for (let i = 0; i < expected; i += 4) {
      out[i] = bgra[i + 2]; // R <- B
      out[i + 1] = bgra[i + 1]; // G
      out[i + 2] = bgra[i]; // B <- R
      out[i + 3] = bgra[i + 3]; // A
    }
    return this.send(out, width, height);
  }

  publishRGBA(rgba: Uint8Array, width: number, height: number): boolean {
    if (!this.sender) return false;
    const expected = width * height * 4;
    if (rgba.length < expected) {
      this.lastError = `Frame buffer too small: got ${rgba.length}, need ${expected}`;
      return false;
    }
    return this.send(rgba, width, height);
  }

  private send(rgba: Uint8Array, width: number, height: number): boolean {
    if (!this.sender) return false;
    try {
      return loadAddon().sendImage(this.sender, rgba, width, height);
    } catch (err) {
      this.lastError = `Spout publish failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return false;
    }
  }

  dispose(): void {
    try {
      if (this.sender) loadAddon().releaseSender(this.sender);
    } catch {
      /* ignore */
    }
    this.sender = null;
    this.swizzleBuf = null;
  }
}
