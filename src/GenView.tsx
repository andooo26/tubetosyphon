import React, { useEffect, useRef } from 'react';
import { drawGen } from './gen/sketch';
import type { GenParams } from './gen/params';

/**
 * The generative (汎用) canvas for deck C.
 *
 * Rendered by the projector at the output size, and optionally small in the
 * control window as a preview. Both draw from the same GenParams and the same
 * wall clock, so the preview really is what goes out. Mount it only while it
 * is visible: every mounted canvas redraws once per display frame.
 */
export function GenCanvas({
  params,
  width,
  height,
  className,
}: {
  params: GenParams;
  width: number;
  height: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read params from a ref inside the rAF loop so changing them never restarts
  // the loop (a restart would visibly hitch the animation).
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    let raf = 0;
    const loop = () => {
      drawGen(ctx, canvas.width, canvas.height, Date.now(), paramsRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
    />
  );
}
