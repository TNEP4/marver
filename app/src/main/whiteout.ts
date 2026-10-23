/**
 * The white-out detector, recording candidates (spec 28 A3.3, A3.8 #15, #16). Owner: the flash stream.
 *
 * Only while the recorder is on, for the active local tab with the window visible, from a gesture's start
 * (`mv:perf gesture on`) until 500 ms after its end (30 s at most): one tick every 250 ms, at most one capture
 * outstanding, a tick while one runs skipped and counted. A tick asks the shell's probes `before`, captures the view
 * (`capturePage()`, a full readback: Electron 45 has no output size), asks `after`. A capture past 500 ms is
 * abandoned but keeps the slot until its promise settles. Each capture is scaled to 64 px for the whole-view test
 * (85 % near-white, every channel >= 245) and cropped 3 x 3 at each probe. A sample with fewer than 4 valid probes,
 * a changed document, bounds or active tab, or an answer later than 150 ms is inconclusive, never white. A candidate
 * is two completed white samples of one document at consecutive ticks, at most 1.6 tick intervals apart (400 ms at
 * 4 Hz, 800 ms at 2 Hz), and claims white at its `observedAt` times only. If the detector costs more than 1 ms of
 * median gesture p95 it drops to 2 Hz. Candidates stay candidates until spike B-S3.1.
 *
 * FROZEN (A3.8 #53): `Verdict`, `classify`, `WhiteoutPorts`, `startWhiteout`.
 */
import type { WebContents } from 'electron'
import type { AgxReading, AppBody, RingEvent, TabIdent } from '../../../src/shared/app-perf.ts'
import type { PerfMsg, PerfProbeAsk } from '../../../src/shared/app-api.ts'

export type Verdict = 'white' | 'clear' | 'inconclusive'

/** One sample's verdict from its probe reads (true near-white, false not, null invalid): fewer than 4 valid is inconclusive; 70 % or more white is white. */
export function classify(reads: readonly (boolean | null)[]): Verdict {
  void reads
  return 'inconclusive'   // A3 flash stream
}

export interface WhiteoutPorts {
  recorderOn(): boolean
  /** the active local tab with its view shown and the window visible, or null; `ident` taken now */
  target(): { tabId: string; wc: WebContents; ident: TabIdent } | null
  /** bridge.onPerf: gestures and probe answers */
  onPerf(fn: (tabId: string, doc: string, msg: PerfMsg) => void): () => void
  /** bridge.perfAsk: a probes ask to the tab's admitted document */
  ask(tabId: string, a: PerfProbeAsk): boolean
  gpuEvents(from: number, to: number): RingEvent[]
  readAgx(timeoutMs: number): Promise<AgxReading>
  /** the recorder's `whiteout-candidate` record, under the identity its first sample took */
  record(ident: TabIdent, body: Omit<AppBody<'whiteout-candidate'>, keyof TabIdent>): void
  now(): number
}

/** At ready, after the recorder. */
export function startWhiteout(p: WhiteoutPorts): void { void p }   // A3 flash stream
