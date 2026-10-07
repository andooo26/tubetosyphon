import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// ---- Performance diagnostics (opt-in) ---------------------------------------
// U2S_PERF=1 logs one JSON line per second (console + <userData>/perf.log):
//   - per-section main-thread time (ms/s), call counts and max — everything the
//     capture / mix / publish / projector paths do runs on the main thread, so
//     their sum against 1000 ms/s shows how close that thread is to saturation;
//   - lag: how late a 10 ms timer actually fires (main-thread backlog, which
//     also covers native work we can't time from JS, e.g. the frame copy
//     Electron makes before each beginFrameSubscription callback);
//   - CPU% per Chromium process (browser = main, GPU, renderers).
// When disabled, perfAdd() is a single boolean check.

export const PERF_ENABLED =
  process.env.U2S_PERF === '1' || !!process.env.U2S_BENCH;

interface Acc {
  n: number;
  ms: number;
  max: number;
}

const acc = new Map<string, Acc>();
const lag = { n: 0, ms: 0, max: 0 };
export const perfHistory: Record<string, unknown>[] = [];

export function perfAdd(name: string, ms: number): void {
  if (!PERF_ENABLED) return;
  let a = acc.get(name);
  if (!a) {
    a = { n: 0, ms: 0, max: 0 };
    acc.set(name, a);
  }
  a.n++;
  a.ms += ms;
  if (ms > a.max) a.max = ms;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// Outermost sections only (the others are nested inside these), so their sum
// is the main thread's JS time without double counting.
const isTopLevel = (name: string) =>
  name.endsWith('.frame') || name === 'vj.tick' || name === 'gen.publish';

function snapshot(elapsedMs: number): Record<string, unknown> {
  const scale = 1000 / elapsedMs;
  const sections: Record<string, unknown> = {};
  let total = 0;
  for (const [name, a] of acc) {
    sections[name] = {
      perSec: r1(a.n * scale),
      msPerSec: r1(a.ms * scale),
      avg: r1(a.n ? a.ms / a.n : 0),
      max: r1(a.max),
    };
    if (isTopLevel(name)) total += a.ms * scale;
  }
  acc.clear();
  const procs: Record<string, number> = {};
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Tab' ? `Tab:${m.pid}` : m.type;
    procs[key] = r1((procs[key] ?? 0) + m.cpu.percentCPUUsage);
  }
  const out = {
    t: new Date().toISOString(),
    jsMsPerSec: r1(total),
    lag: { avg: r1(lag.n ? lag.ms / lag.n : 0), max: r1(lag.max) },
    cpu: procs,
    sections,
  };
  lag.n = 0;
  lag.ms = 0;
  lag.max = 0;
  return out;
}

let started = false;

/** Start the once-per-second logger (no-op unless enabled). */
export function startPerf(): void {
  if (!PERF_ENABLED || started) return;
  started = true;
  const file = path.join(app.getPath('userData'), 'perf.log');
  console.log(`U2S_PERF logging to ${file}`);

  // Lag probe: a 10 ms timer that measures how late it runs.
  let expect = performance.now() + 10;
  setInterval(() => {
    const now = performance.now();
    const late = Math.max(0, now - expect);
    lag.n++;
    lag.ms += late;
    if (late > lag.max) lag.max = late;
    expect = now + 10;
  }, 10);

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const snap = snapshot(now - last);
    last = now;
    perfHistory.push(snap);
    const line = JSON.stringify(snap);
    console.log(`U2S_PERF ${line}`);
    fs.appendFile(file, line + '\n', () => undefined);
  }, 1000);
}
