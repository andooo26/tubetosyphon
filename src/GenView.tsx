import React, { useEffect, useRef } from 'react';
import { drawGen } from './gen/sketch';
import { DEFAULT_GEN_PARAMS, type GenParams } from './gen/params';

/**
 * The generative canvas for 汎用 (generic) mode.
 *
 * Rendered twice: full-size (1920x1080) inside the hidden offscreen window whose
 * painted frames become the Syphon output, and small inside the main window as a
 * live preview. Both draw from the same GenParams and the same wall clock, so
 * the preview really is what goes out.
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

/**
 * Root of the offscreen output window (index.html?gen=1). Fills the window with
 * a 1920x1080 canvas and follows the params pushed from the main process.
 */
export default function GenWindowRoot() {
  const [params, setParams] = React.useState<GenParams>(DEFAULT_GEN_PARAMS);

  useEffect(() => {
    window.api.getStatus().then((s) => setParams(s.genParams));
    return window.api.onGenParams(setParams);
  }, []);

  return (
    <div className="genstage">
      <GenCanvas params={params} width={1920} height={1080} className="genfull" />
    </div>
  );
}
