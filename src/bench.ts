import { app, screen, type BrowserWindow } from 'electron';
import { perfHistory, startPerf } from './perf';
import type { ProjectorStats } from './shared';

// ---- Scenario benchmark (opt-in, for diagnosing slow machines) --------------
// U2S_BENCH=vjproj reproduces "VJ mode + projector" with both players showing a
// full-viewport animated canvas (stands in for video: repaints every frame),
// the fader mid-way (worst case: both decks on screen), and the projector
// on a secondary display (or the primary one if there is no other). It runs
// for U2S_BENCH_SECONDS (default 20), prints a summary line and exits.
// Optional: U2S_BENCH_ALPHA (default 0.5), U2S_BENCH_PROJECTOR=0 to skip it,
// U2S_BENCH_URLS="<A url> <B url>" to load real pages (e.g. YouTube watch
// URLs) instead of the synthetic one, U2S_BENCH_SHOT=<dir> to save PNGs of the
// projector and the control window at the end (to eyeball crop and mix).

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
  const urls = (process.env.U2S_BENCH_URLS ?? '').split(/\s+/).filter(Boolean);
  const pages = urls.length ? urls : [TEST_PAGE];
  const script = `(async () => {
    const pages = ${JSON.stringify(pages)};
    let i = 0;
    for (const wv of document.querySelectorAll('webview')) {
      const page = pages[i++ % pages.length];
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
    await window.api.setLevel('mix', ${alpha});
    ${useProjector ? `await window.api.openProjector(${projDisplay});` : ''}
    return true;
  })()`;
  await win.webContents.executeJavaScript(script);

  const warmup = 3;
  await new Promise((r) => setTimeout(r, (seconds + warmup) * 1000));
  const samples = perfHistory.slice(warmup);
  const cpuKeys = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.cpu)) cpuKeys.add(k);
  const cpu: Record<string, number> = {};
  for (const k of cpuKeys) cpu[k] = median(samples.map((s) => s.cpu[k] ?? 0));
  const deck = (id: 'left' | 'right') => {
    const per = samples.map(
      (s) => (s.projector as ProjectorStats | undefined)?.[id],
    );
    return {
      fps: median(per.map((d) => d?.fps ?? 0)),
      size: per.at(-1) ? `${per.at(-1)!.width}x${per.at(-1)!.height}` : null,
      error: per.at(-1)?.error ?? null,
    };
  };

  const shotDir = process.env.U2S_BENCH_SHOT;
  if (shotDir) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { projectorContents } = await import('./projector');
    const shots: [string, Electron.WebContents | null][] = [
      ['projector.png', projectorContents()],
      ['control.png', win.webContents],
    ];
    for (const [name, wc] of shots) {
      if (!wc) continue;
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(shotDir, name), img.toPNG());
    }
  }

  const os = await import('node:os');
  const summary = {
    platform: process.platform,
    cpuModel: os.cpus()[0]?.model,
    cores: os.cpus().length,
    displays: screen.getAllDisplays().map((d) => ({
      size: d.size,
      scale: d.scaleFactor,
    })),
    alpha,
    seconds: samples.length,
    projector: useProjector ? { display: projDisplay, left: deck('left'), right: deck('right') } : null,
    lagAvg: median(samples.map((s) => s.lag.avg)),
    lagMax: median(samples.map((s) => s.lag.max)),
    cpu,
  };
  console.log(`U2S_BENCH ${JSON.stringify(summary)}`);
  app.exit(0);
}
