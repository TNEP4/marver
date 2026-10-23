/**
 * The app half of the recorder (spec 28 A3.1, A3.8 #4-#9, #12, #13): the one sampler, the events, identity, the
 * `mv:perf` traffic and the minute aggregate on disk. Owner: the recorder stream.
 *
 * **One sampler, two consumers** (A3.8 #4): this file owns the only `getAppMetrics()` loop, every 5 s, while
 * recording or while `memory.ts`'s `wantPressure()` says an unload is possible; nothing else samples. With the
 * recorder off it runs only for memory.ts and writes nothing; with nothing that could be unloaded either, a tick
 * calls neither `getAppMetrics()` nor `sysctl`. The tick stops at `suspend` and starts again at `resume`.
 *
 * **Identity is taken in the event's turn** (A3.8 #8): `identity(tab)` before any await - `page` the one its
 * admitted document's accepted hello sent (tabs.ts keeps it in `reports.hello`), none before it says hello.
 *
 * The ports other streams call, FROZEN (A3.8 #53), wired by main.ts (`start`, after the bridge and before the
 * views; `flushSync` at will-quit) and views.ts (`watchCanvas` first in wireCanvas; `processGone` before recover();
 * `shown` with `mv:app-state shown`; `tabsChanged` after each compose; `markFlash` from runCommand); `event` is how
 * memory.ts, the one ground and the flash stream write their kinds. Until the recorder stream fills them nothing is
 * sampled or written.
 */
import { app, type RenderProcessGoneDetails, type WebContents } from 'electron'
import type { AppBody, AppKind, Flavour, GpuIdentity, RingEvent, Sample, Sampler, TabIdent } from '../../../src/shared/app-perf.ts'
import type { Bridge } from './bridge.ts'
import type { Config, Home } from './config.ts'
import type { Tab } from './tabs.ts'

export type { ProcSample, ProcType, Role, Sample, Sampler, TabIdent } from '../../../src/shared/app-perf.ts'

/** A tab's identity now (A3.8 #8), before any await. */
export function identity(t: Tab): TabIdent {
  return {
    tab: t.id,
    ...(t.reg?.ws ? { ws: t.reg.ws } : {}),
    ...(t.doc ? { commit: t.doc.commits } : {}),
    ...(t.reports.hello?.page ? { page: t.reports.hello.page } : {}),
  }
}

/** The GPU process's identity now (A3.8 #27, r3 #1): `getAppMetrics()`'s GPU entry, or null when there is none. */
export function gpuIdentity(): GpuIdentity | null {
  try {
    const m = app.getAppMetrics().find((x) => x.type === 'GPU')
    return m ? { pid: m.pid, born: m.creationTime } : null
  } catch { return null }
}

const sampleFns = new Set<(s: Sample) => void>()
const wants: (() => boolean)[] = []

/** The one sampler (A3.8 #4). */
export const sampler: Sampler = {
  onSample(fn) { sampleFns.add(fn); return () => { sampleFns.delete(fn) } },
  wantPressure(fn) { wants.push(fn) },
  requestSample() { return Promise.reject(new Error('recorder.ts: the sampler is not built yet (spec 28 A3.8 #4)')) },
  last: () => null,
}

export interface RecorderStart {
  bridge: Bridge
  home: Home
  flavour: Flavour
  config(): Config
}

export const recorder = {
  /** main.ts at ready, after the bridge and before the views: the writer, the machine profile, the sampler, the app-wide events */
  start(p: RecorderStart): void { void p },
  /** views.ts wireCanvas, first: the canvas's own events (unresponsive, responsive) and its `mv:perf` */
  watchCanvas(t: Tab, wc: WebContents): void { void t; void wc },
  /** views.ts's render-process-gone, before recover(): `ours` when main was ending that renderer (A3.8 #9) */
  processGone(t: Tab, d: RenderProcessGoneDetails, ours: boolean): void { void t; void d; void ours },
  /** views.ts, in the turn `mv:app-state shown` is sent (tab switches only): the `shown` ask */
  shown(t: Tab): void { void t },
  /** after each compose: `tab` lines for what changed (A3.8 #9, r4 #1) */
  tabsChanged(): void {},
  /**
   * a record of another stream's kind (app.jsonl only with the recorder on; the journal always in tests): `who` a tab,
   * its identity taken now, or an identity a caller took in its event's turn (a flash, a candidate, a reopen)
   */
  event<K extends AppKind>(kind: K, who: Tab | TabIdent | null, body: Omit<AppBody<K>, keyof TabIdent>): void { void kind; void who; void body },
  /** the shell's last `board` for the tab's current document (Copy Details' frame count, A3.8 #9), or null */
  boardOf(tabId: string): { frames: number; asleep: number } | null { void tabId; return null },
  /** the ring's GPU process events (gone, child-gone, gpu-restart, gpu) between two times: a flash's and a candidate's */
  gpuEvents(from: number, to: number): RingEvent[] { void from; void to; return [] },
  /** runCommand('mark-flash'): flashes.ts's transaction, with this file's ports */
  markFlash(via: 'key' | 'menu'): void { void via },
  /** will-quit: unfinished marks and every queued line, written now */
  flushSync(): void {},
}
