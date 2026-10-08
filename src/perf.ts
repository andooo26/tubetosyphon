import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// ---- Performance diagnostics (opt-in) ---------------------------------------
// U2S_PERF=1 logs one JSON line per second (console + <userData>/perf.log):
//   - lag: how late a 10 ms timer actually fires (main-thread backlog);
//   - CPU% per Chromium process (browser = main, GPU, renderers);
//   - whatever setPerfExtra() provides (the projector's per-deck fps).

export const PERF_ENABLED =
  process.env.U2S_PERF === '1' || !!process.env.U2S_BENCH;

export interface PerfSample {
  t: string;
  lag: { avg: number; max: number };
  cpu: Record<string, number>;
  [extra: string]: unknown;
}

const lag = { n: 0, ms: 0, max: 0 };
export const perfHistory: PerfSample[] = [];
let extra: () => Record<string, unknown> = () => ({});

export function setPerfExtra(fn: () => Record<string, unknown>): void {
  extra = fn;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function snapshot(): PerfSample {
  const procs: Record<string, number> = {};
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Tab' ? `Tab:${m.pid}` : m.type;
    procs[key] = r1((procs[key] ?? 0) + m.cpu.percentCPUUsage);
  }
  const out = {
    t: new Date().toISOString(),
    lag: { avg: r1(lag.n ? lag.ms / lag.n : 0), max: r1(lag.max) },
    cpu: procs,
    ...extra(),
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

  setInterval(() => {
    const snap = snapshot();
    perfHistory.push(snap);
    const line = JSON.stringify(snap);
    console.log(`U2S_PERF ${line}`);
    fs.appendFile(file, line + '\n', () => undefined);
  }, 1000);
}
