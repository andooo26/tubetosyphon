/**
 * Platform frame output: Syphon on macOS, Spout on Windows. main.ts publishes
 * every source (channels, VJ mix, generative) through this interface, so the
 * capture/mix code is identical on both platforms.
 */

import { SyphonManager } from './syphon';
import { SpoutManager } from './spout';

export interface FrameOutput {
  /** Lazily create the native server. On failure `error` explains why. */
  start(): boolean;
  readonly isRunning: boolean;
  readonly error: string | null;
  /** Whether a receiver is connected; null when the protocol can't tell (Spout). */
  readonly hasClients: boolean | null;
  publishBGRA(bgra: Uint8Array, width: number, height: number): boolean;
  publishRGBA(rgba: Uint8Array, width: number, height: number): boolean;
  dispose(): void;
}

export type OutputProtocol = 'Syphon' | 'Spout';

export const OUTPUT_PROTOCOL: OutputProtocol =
  process.platform === 'win32' ? 'Spout' : 'Syphon';

export function createOutput(name: string): FrameOutput {
  return OUTPUT_PROTOCOL === 'Spout'
    ? new SpoutManager(name)
    : new SyphonManager(name);
}
