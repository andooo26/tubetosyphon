import { protocol } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Clip } from './shared';

// ---- Local media for deck C ---------------------------------------------------
// Clips are served to the renderers over a private u2s-media:// scheme instead
// of file:// (the UI is an http:// page in dev, which may not load file URLs,
// and the scheme only exposes files the user explicitly added). Range requests
// are honoured so <video> can seek and loop without re-reading the whole file.

export const MEDIA_SCHEME = 'u2s-media';

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
export const MEDIA_EXTENSIONS = [...VIDEO_EXT, ...IMAGE_EXT];

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const ext = (p: string) => path.extname(p).slice(1).toLowerCase();

/** A registered clip: the public Clip plus the path only main knows. */
export interface ClipEntry extends Clip {
  path: string;
}

export function makeClip(filePath: string): ClipEntry | null {
  const e = ext(filePath);
  if (!MEDIA_EXTENSIONS.includes(e)) return null;
  const id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return {
    id,
    path: filePath,
    name: path.basename(filePath),
    url: `${MEDIA_SCHEME}://clip/${id}`,
    kind: VIDEO_EXT.includes(e) ? 'video' : 'image',
  };
}

/** Must run before app 'ready'. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
    },
  ]);
}

/** Serve registered clips (looked up by id) on the default session. */
export function handleMediaScheme(lookup: (id: string) => ClipEntry | null): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const id = new URL(req.url).pathname.replace(/^\//, '');
    const clip = lookup(id);
    if (!clip) return new Response('not found', { status: 404 });
    let size: number;
    try {
      size = (await fs.promises.stat(clip.path)).size;
    } catch {
      return new Response('not found', { status: 404 });
    }
    const type = MIME[ext(clip.path)] ?? 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    let start = 0;
    let end = size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
      }
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }
    }
    const body = Readable.toWeb(
      fs.createReadStream(clip.path, { start, end }),
    ) as unknown as ReadableStream;
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    };
    if (m && (m[1] || m[2])) {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      return new Response(body, { status: 206, headers });
    }
    return new Response(body, { status: 200, headers });
  });
}
