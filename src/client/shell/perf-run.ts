/**
 * Perf mode, the page's half of a headless run (spec 28 A3.4, A3.8 #17): `?mvperfrun=<16 hex>[&warm=1]` sets
 * `PERF_RUN` at module load, before boot, in dev only. Owner: the headless stream; the contract is
 * src/shared/perf-run.ts, which the server reads too.
 *
 * - The barrier sits in `mvFetch` (api.ts), before any `fetch`: GET and HEAD pass, and under `${ROUTE}/api/` only
 *   `POST perf/page` and `POST bakes`; anything else gets a synthetic 403, counted as `refused`, and never reaches
 *   `lost()`. Every request carries `x-mv-perfrun`; `withWs()` adds `mvperfrun` to frame URLs, the play stage and
 *   Jam pictures.
 * - Warm mode: the recorder runs (the driver reads `settled` from it) and posts nothing; `flush()` sends until the
 *   outbox is empty and answers whether every batch landed.
 * - In perf mode `beforeunload` never refuses, and the Video primitive never asks for a poster
 *   (`data-mv-poster-skipped`).
 * - `window.__mvPerfRun` (`PerfRunProbe`): status(), fit(), centre(), flush().
 *
 * FROZEN (A3.8 #53): `PERF_RUN`, `runApiPath`, `perfRunGate` and `installPerfRunProbe`'s signature.
 */
import { ROUTE } from '../const.ts'
import { allowedInRun, RUN_HEADER, RUN_ID, RUN_PARAM, WARM_PARAM, type PerfRunProbe } from '../../shared/perf-run.ts'

export * from '../../shared/perf-run.ts'

/**
 * This page's run, or null: a published canvas (a production build), or no `mvperfrun`. Read with no import of
 * api.ts, which calls `perfRunGate` (a cycle would read this before it exists).
 */
export const PERF_RUN: { id: string; warm: boolean } | null = (() => {
  if (!import.meta.env.DEV) return null
  try {
    const q = new URLSearchParams(location.search)
    const id = q.get(RUN_PARAM)
    return id && RUN_ID.test(id) ? { id, warm: q.get(WARM_PARAM) === '1' } : null
  } catch { return null }
})()

/** The path under `${ROUTE}/api/` a URL names (no query), or null for any other path. */
export function runApiPath(url: string): string | null {
  let p: string
  try { p = new URL(url, location.href).pathname } catch { return null }
  const base = `${ROUTE}/api/`
  return p.startsWith(base) ? p.slice(base.length) : null
}

let refused = 0
/** Requests refused before sending, so far. */
export const refusedInPage = (): number => refused

/**
 * The barrier, called first by `mvFetch` in perf mode: null lets the request go (it then carries `x-mv-perfrun`);
 * a Response is the synthetic refusal, never sent.
 */
export function perfRunGate(url: string, init: RequestInit = {}): Response | null {
  if (!PERF_RUN) return null
  if (allowedInRun(init.method ?? 'GET', runApiPath(url))) return null
  refused += 1
  return new Response('{"error":"a perf run is read-only"}', { status: 403, headers: { 'content-type': 'application/json', [RUN_HEADER]: 'refused' } })
}

/** main.tsx in perf mode: `window.__mvPerfRun`. */
export function installPerfRunProbe(probe: PerfRunProbe): void {
  if (!PERF_RUN) return
  ;(window as unknown as { __mvPerfRun?: PerfRunProbe }).__mvPerfRun = probe
}
