import { app, screen, type BrowserWindow } from 'electron';
import { perfHistory, startPerf } from './perf';

// ---- Scenario benchmark (opt-in, for diagnosing slow machines) --------------
// U2S_BENCH=vjproj reproduces "VJ mode + projector" with both players showing a
// full-viewport animated canvas (stands in for video: repaints every frame),
// the fader mid-way (worst case: a real blend every tick), and the projector
// on a secondary display (or the primary one if there is no other). It runs
// for U2S_BENCH_SECONDS (default 20), prints a summary line and exits.
// Optional: U2S_BENCH_ALPHA (default 0.5), U2S_BENCH_PROJECTOR=0 to skip it.

// A page that repaints its whole viewport every animation frame.
const TEST_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<body style="margin:0;background:#000;overflow:hidden">' +
      '<canvas id=c style="width:100vw;height:100vh;display:block"></canvas>' +
      '<script>const g=c.getContext("2d");let i=0;' +
      'function fit(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio}' +
      'fit();addEventListener("resize",fit);' +
      '(function f(){const w=c.width,h=c.height;' +
      'g.fillStyle="hsl("+(i%360)+",70%,40%)";g.fillRect(0,0,w,h);' +
      'g.fillStyle="#fff";g.fillRect((i*7)%w,0,w/10,h);i++;' +
      'requestAnimationFrame(f)})()</script></body>',
  );

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export async function runBench(win: BrowserWindow): Promise<void> {
  const seconds = Number(process.env.U2S_BENCH_SECONDS ?? 20);
  const alpha = Number(process.env.U2S_BENCH_ALPHA ?? 0.5);
  const useProjector = process.env.U2S_BENCH_PROJECTOR !== '0';
  const primary = screen.getPrimaryDisplay().id;
  const projDisplay =
    screen.getAllDisplays().find((d) => d.id !== primary)?.id ?? primary;

  startPerf();
  await new Promise<void>((r) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => r());
    else r();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Drive the real UI through its own preload API, exactly as a user would.
  const script = `(async () => {
    const page = ${JSON.stringify(TEST_PAGE)};
    for (const wv of document.querySelectorAll('webview')) {
      // Load, then reload so the guest is registered before the page loads
      // (registration happens on the first dom-ready).
      let r = new Promise(x => wv.addEventListener('dom-ready', x, { once: true }));
      wv.setAttribute('src', page);
      await r;
      await new Promise(x => setTimeout(x, 300));
      r = new Promise(x => wv.addEventListener('dom-ready', x, { once: true }));
      wv.reload();
      await r;
    }
    await window.api.setMode('vj');
    await window.api.setVjAlpha(${alpha});
    await window.api.setProjectorSource('vj');
    ${useProjector ? `await window.api.openProjector(${projDisplay});` : ''}
    return true;
  })()`;
  await win.webContents.executeJavaScript(script);

  const warmup = 3;
  await new Promise((r) => setTimeout(r, (seconds + warmup) * 1000));
  const samples = perfHistory.slice(warmup) as {
    jsMsPerSec: number;
    lag: { avg: number; max: number };
    cpu: Record<string, number>;
    sections: Record<string, { perSec: number; msPerSec: number; avg: number; max: number }>;
  }[];

  // Median per metric across the measured seconds.
  const names = new Set<string>();
  for (const s of samples) for (const n of Object.keys(s.sections)) names.add(n);
  const sections: Record<string, unknown> = {};
  for (const n of [...names].sort()) {
    const pick = (k: 'perSec' | 'msPerSec' | 'avg' | 'max') =>
      median(samples.map((s) => s.sections[n]?.[k] ?? 0));
    sections[n] = {
      perSec: pick('perSec'),
      msPerSec: pick('msPerSec'),
      avg: pick('avg'),
      max: pick('max'),
    };
  }
  const cpuKeys = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.cpu)) cpuKeys.add(k);
  const cpu: Record<string, number> = {};
  for (const k of cpuKeys) cpu[k] = median(samples.map((s) => s.cpu[k] ?? 0));

  const os = await import('node:os');
  const status = await win.webContents.executeJavaScript(
    'window.api.getStatus()',
  );
  const summary = {
    platform: process.platform,
    cpuModel: os.cpus()[0]?.model,
    cores: os.cpus().length,
    displays: screen.getAllDisplays().map((d) => ({
      size: d.size,
      scale: d.scaleFactor,
    })),
    projector: useProjector ? projDisplay : null,
    alpha,
    seconds: samples.length,
    vjFps: status.vj.fps,
    projectorFps: status.projector.fps,
    jsMsPerSec: median(samples.map((s) => s.jsMsPerSec)),
    lagAvg: median(samples.map((s) => s.lag.avg)),
    lagMax: median(samples.map((s) => s.lag.max)),
    cpu,
    sections,
  };
  console.log(`U2S_BENCH ${JSON.stringify(summary)}`);
  app.exit(0);
}
