import React, { useEffect, useRef, useState } from 'react';
import { GenCanvas } from './GenView';
import { DEFAULT_GEN_PARAMS, type GenParams } from './gen/params';
import type { ProjectorFrame, ProjectorSource } from './preload';

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  // pos is the unit quad (0..1); flip y so row 0 of the image is the top.
  uv = vec2(pos.x, 1.0 - pos.y);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D tex;
out vec4 color;
void main() {
  color = vec4(texture(tex, uv).rgb, 1.0);
}`;

/**
 * Draws the RGBA frames main pushes for the A / B / VJ sources. Uploads straight
 * into a texture (no ImageData copy) and fits it into the display with
 * letterboxing, so a non-16:9 projector keeps the picture's aspect ratio.
 */
function FrameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
      }
      return sh;
    };
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let texW = 0;
    let texH = 0;

    // Backing store at device pixels so a 4K projector gets a sharp scale-up.
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!texW || !texH) return;
      // Contain-fit the frame into the canvas.
      const s = Math.min(canvas.width / texW, canvas.height / texH);
      const w = Math.round(texW * s);
      const h = Math.round(texH * s);
      gl.viewport(
        Math.round((canvas.width - w) / 2),
        Math.round((canvas.height - h) / 2),
        w,
        h,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    // Latest frame wins; drawn on the next animation frame, then acked so main
    // sends the next one (see projector.ts flow control).
    let pending: ProjectorFrame | null = null;
    let raf = 0;
    const onAnimationFrame = () => {
      raf = 0;
      const f = pending;
      pending = null;
      if (!f) return;
      if (f.width !== texW || f.height !== texH) {
        texW = f.width;
        texH = f.height;
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA8, texW, texH, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, f.data,
        );
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0, 0, 0, texW, texH,
          gl.RGBA, gl.UNSIGNED_BYTE, f.data,
        );
      }
      draw();
      window.api.projectorFrameDone();
    };
    const off = window.api.onProjectorFrame((f) => {
      pending = f;
      if (!raf) raf = requestAnimationFrame(onAnimationFrame);
    });
    draw();

    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, []);

  return <canvas ref={canvasRef} className="projcanvas" />;
}

/**
 * Root of the fullscreen projector window (index.html?projector=1). Shows only
 * the picture — no UI. Esc closes it.
 */
export default function ProjectorRoot() {
  const [source, setSource] = useState<ProjectorSource>('vj');
  const [genParams, setGenParams] = useState<GenParams>(DEFAULT_GEN_PARAMS);

  useEffect(() => {
    window.api.getStatus().then((s) => {
      setSource(s.projector.source);
      setGenParams(s.genParams);
    });
    const offSource = window.api.onProjectorSource(setSource);
    const offParams = window.api.onGenParams(setGenParams);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.api.closeProjector();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offSource();
      offParams();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="projstage">
      {source === 'gen' ? (
        <GenCanvas
          params={genParams}
          width={1920}
          height={1080}
          className="projgen"
        />
      ) : (
        // Remounted per source so a stale frame from the previous source is
        // never shown.
        <FrameCanvas key={source} />
      )}
    </div>
  );
}
