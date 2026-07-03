/**
 * SyphonManager — wraps node-syphon's Metal server (main process only).
 *
 * Why main process: node-syphon is a native N-API addon. It must run in a
 * Node context (Electron main), and it needs a live CFRunLoop (the Electron
 * app run loop) for the Syphon server to announce itself to receivers. Publishing
 * from a bare `node -e` script does NOT work reliably for this reason.
 *
 * The prebuilt `syphon.node` links `@rpath/Syphon.framework` and node-syphon's
 * postinstall drops Syphon.framework into node_modules/node-syphon/dist/Frameworks
 * (rpath `@loader_path/../Frameworks`). So there is NO dependency on
 * /Library/Frameworks at dev time.
 */

// Electron's NativeImage.getBitmap() returns pixels in **BGRA** order (all platforms).
// node-syphon's Metal server uploads into an RGBA8 texture, so B and R must be
// swapped or red/blue will be inverted.
//
// I cannot visually verify colors in this environment, so this is a single toggle:
// if the received image looks blue-ish where it should be red, set this to `false`.
const SWIZZLE_BGRA_TO_RGBA = true;

type SyphonServerCtor = new (name: string) => {
  publishImageData(
    data: Uint8ClampedArray,
    imageRegion: { x: number; y: number; width: number; height: number },
    textureDimension: { width: number; height: number },
    flipped: boolean,
  ): void;
  dispose(): void;
  readonly hasClients: boolean;
  readonly name: string;
};

export class SyphonManager {
  private server: InstanceType<SyphonServerCtor> | null = null;
  private lastError: string | null = null;

  constructor(private readonly serverName = 'URLtoSyphon') {}

  /**
   * Lazily create the Syphon Metal server. Returns true on success.
   * On failure, `lastError` holds a human-readable message (never swallowed).
   */
  start(): boolean {
    if (this.server) return true;
    try {
      // Required late so a load failure produces a clear message instead of
      // crashing app startup.
      const { SyphonMetalServer } = require('node-syphon') as {
        SyphonMetalServer: SyphonServerCtor;
      };
      this.server = new SyphonMetalServer(this.serverName);
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError =
        `Failed to initialise Syphon (node-syphon). ` +
        `Is Syphon.framework present in node_modules/node-syphon/dist/Frameworks? ` +
        `Try 'npm rebuild node-syphon' or reinstall. Original error: ${
          err instanceof Error ? err.message : String(err)
        }`;
      this.server = null;
      return false;
    }
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  get error(): string | null {
    return this.lastError;
  }

  get hasClients(): boolean {
    try {
      return this.server?.hasClients ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Publish one frame. `bgra` is a width*height*4 BGRA buffer (as returned by
   * NativeImage.getBitmap()). Returns true if published.
   */
  publishBGRA(bgra: Uint8Array, width: number, height: number): boolean {
    if (!this.server) return false;
    const expected = width * height * 4;
    if (bgra.length < expected) {
      this.lastError = `Frame buffer too small: got ${bgra.length}, need ${expected}`;
      return false;
    }

    let out = bgra;
    if (SWIZZLE_BGRA_TO_RGBA) {
      out = new Uint8Array(expected);
      for (let i = 0; i < expected; i += 4) {
        out[i] = bgra[i + 2]; // R <- B
        out[i + 1] = bgra[i + 1]; // G
        out[i + 2] = bgra[i]; // B <- R
        out[i + 3] = bgra[i + 3]; // A
      }
    }

    try {
      this.server.publishImageData(
        new Uint8ClampedArray(out.buffer, out.byteOffset, expected),
        { x: 0, y: 0, width, height },
        { width, height },
        // flipped=true: Electron's bitmap is top-left origin but Syphon/Metal
        // textures are bottom-left origin, so the image must be flipped
        // vertically or it comes out upside-down in the receiver.
        true,
      );
      return true;
    } catch (err) {
      this.lastError = `Syphon publish failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return false;
    }
  }

  dispose(): void {
    try {
      this.server?.dispose();
    } catch {
      /* ignore */
    }
    this.server = null;
  }
}
