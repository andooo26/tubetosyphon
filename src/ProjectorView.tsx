import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  EMPTY_DECK_STATS,
  mixAt,
  type ChannelId,
  type DeckFeed,
  type DeckStats,
  type OutputSettings,
  type ProjectorState,
  type VideoRect,
} from './shared';

// The projector window (index.html?projector=1): the app's output.
//
// Each deck is a live tab capture of its player <webview> (getUserMedia with a
// one-shot id from main) shown in a plain <video>. The crop to the drawn video
// and the fit to the display are CSS boxes, and the crossfade is the B deck's
// opacity over A — so per frame there is no JavaScript at all: decoding,
// scaling and blending are all done by the GPU compositor. That is what keeps
// this usable on weak PCs, where the old CPU pixel path saturated the main
// process at ~2 fps.

type StatsSink = Record<ChannelId, DeckStats>;

/**
 * Position `video` inside `clip` so that only the drawn-video region of the
 * captured viewport shows, contain-fitted and centred in the window.
 */
function layoutDeck(
  clip: HTMLDivElement,
  video: HTMLVideoElement,
  rect: VideoRect | null,
) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const fw = video.videoWidth;
  const fh = video.videoHeight;
  if (!fw || !fh || !W || !H) return;
  // Region of the frame to show (frame px). The capturer may letterbox the
  // viewport inside a fixed-size frame, so map the rect through that fit.
  let rx = 0;
  let ry = 0;
  let rw = fw;
  let rh = fh;
  if (rect && rect.viewW > 0 && rect.viewH > 0) {
    const k = Math.min(fw / rect.viewW, fh / rect.viewH);
    rx = (fw - rect.viewW * k) / 2 + rect.x * k;
    ry = (fh - rect.viewH * k) / 2 + rect.y * k;
    rw = rect.width * k;
    rh = rect.height * k;
  }
  const s = Math.min(W / rw, H / rh);
  const cw = rw * s;
  const ch = rh * s;
  Object.assign(clip.style, {
    left: `${(W - cw) / 2}px`,
    top: `${(H - ch) / 2}px`,
    width: `${cw}px`,
    height: `${ch}px`,
  });
  Object.assign(video.style, {
    left: `${-rx * s}px`,
    top: `${-ry * s}px`,
    width: `${fw * s}px`,
    height: `${fh * s}px`,
  });
}

function Deck({
  id,
  feed,
  output,
  stats,
  layerRef,
}: {
  id: ChannelId;
  feed: DeckFeed;
  output: OutputSettings;
  stats: StatsSink;
  layerRef?: React.Ref<HTMLDivElement>;
}) {
  const clipRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rectRef = useRef<VideoRect | null>(feed.rect);
  const frames = useRef(0);

  // Acquire (and keep) the capture stream for the current guest + settings.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    stats[id] = { ...EMPTY_DECK_STATS };
    if (feed.guestId == null) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const w = Math.round((output.height * 16) / 9);
    const h = output.height;

    const stop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const again = (ms: number) => {
      if (!cancelled) retry = setTimeout(start, ms);
    };
    async function start() {
      retry = null;
      try {
        const sourceId = await window.api.getDeckSourceId(id);
        if (!sourceId) throw new Error('no player to capture');
        // A fixed frame size makes Chromium render the capture at that size
        // (sharper than the on-screen pane) and letterbox the viewport into
        // it; layoutDeck() undoes the letterbox.
        const constraints = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: sourceId,
              minWidth: w,
              maxWidth: w,
              minHeight: h,
              maxHeight: h,
              maxFrameRate: output.fps,
            },
          },
        } as unknown as MediaStreamConstraints;
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stop();
        stream = s;
        const track = s.getVideoTracks()[0];
        // The guest went away (or the capture broke): get a fresh id.
        track?.addEventListener('ended', () => again(1000));
        video.srcObject = s;
        video.play().catch((): void => undefined);
        stats[id] = { ...stats[id], error: null };
      } catch (err) {
        stats[id] = {
          ...stats[id],
          error: err instanceof Error ? err.message : String(err),
        };
        again(2000);
      }
    }
    start();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      stop();
      video.srcObject = null;
    };
  }, [id, feed.guestId, output.height, output.fps]);

  // Re-layout when the crop rect, the frame size or the window size changes.
  useEffect(() => {
    rectRef.current = feed.rect;
    const clip = clipRef.current;
    const video = videoRef.current;
    if (clip && video) layoutDeck(clip, video, feed.rect);
  }, [feed.rect]);

  useEffect(() => {
    const clip = clipRef.current;
    const video = videoRef.current;
    if (!clip || !video) return;
    const relayout = () => layoutDeck(clip, video, rectRef.current);
    video.addEventListener('resize', relayout);
    window.addEventListener('resize', relayout);
    return () => {
      video.removeEventListener('resize', relayout);
      window.removeEventListener('resize', relayout);
    };
  }, []);

  // Count presented frames (diagnostics only: one callback per video frame,
  // no pixel access).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !('requestVideoFrameCallback' in video)) return;
    let handle = 0;
    const onFrame = () => {
      frames.current++;
      handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    const timer = setInterval(() => {
      stats[id] = {
        ...stats[id],
        fps: frames.current,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      frames.current = 0;
    }, 1000);
    return () => {
      video.cancelVideoFrameCallback(handle);
      clearInterval(timer);
    };
  }, [id]);

  return (
    <div className="projdeck" ref={layerRef}>
      <div
        className="projclip"
        ref={clipRef}
        style={{ visibility: feed.live ? 'visible' : 'hidden' }}
      >
        <video ref={videoRef} muted playsInline disablePictureInPicture />
      </div>
    </div>
  );
}

/**
 * Root of the fullscreen projector window. Shows only the picture — no UI.
 * Esc closes it.
 */
export default function ProjectorRoot() {
  const [state, setState] = useState<ProjectorState | null>(null);
  const bRef = useRef<HTMLDivElement | null>(null);
  const stats = useRef<StatsSink>({
    left: { ...EMPTY_DECK_STATS },
    right: { ...EMPTY_DECK_STATS },
  });

  useEffect(() => {
    window.api.getProjectorState().then(setState);
    const off = window.api.onProjectorState(setState);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.api.closeProjector();
    };
    window.addEventListener('keydown', onKey);
    const report = setInterval(
      () => window.api.reportProjectorStats({ ...stats.current }),
      1000,
    );
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
      clearInterval(report);
    };
  }, []);

  // Crossfade = B's opacity over A. A fade is animated here, per display
  // frame, from the same wall clock main uses for the UI fader.
  const alpha = state?.alpha ?? 0;
  const anim = state?.anim ?? null;
  // Layout effect: applied before paint, so B never flashes at full opacity.
  useLayoutEffect(() => {
    let raf = 0;
    const apply = () => {
      const b = bRef.current;
      if (!b) return;
      const now = Date.now();
      b.style.opacity = String(mixAt(alpha, anim, now));
      if (anim && now < anim.start + anim.dur) raf = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [alpha, anim, state !== null]);

  if (!state) return <div className="projstage" />;
  return (
    <div className="projstage">
      <Deck
        id="left"
        feed={state.decks.left}
        output={state.output}
        stats={stats.current}
      />
      <Deck
        id="right"
        feed={state.decks.right}
        output={state.output}
        stats={stats.current}
        layerRef={bRef}
      />
    </div>
  );
}
