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
 * FROZEN (A3.8 #53): `Verdict`, `classify`, `WhiteoutPorts`, `startWhiteout`. The rate is `T.whiteoutTickMs` (250
 * for 4 Hz; 500 is 2 Hz, the cost case's fallback). A run of white samples is one record, written when it ends; the
 * pixel tests are pure (`wholeWhite`, `probeWhite`) and the loop runs on the ports, so both are unit-tested.
 */
import type { NativeImage, WebContents } from 'electron'
import type { AgxReading, AppBody, RingEvent, TabIdent } from '../../../src/shared/app-perf.ts'
import { PERF_BOUNDS, type PerfMsg, type PerfProbeAsk } from '../../../src/shared/app-api.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'

export type Verdict = 'white' | 'clear' | 'inconclusive'

/** At least this share of the 64 px view near-white, and of the valid probes. */
export const WHOLE_WHITE = 0.85
export const PROBES_WHITE = 0.7
export const MIN_PROBES = 4
/** every channel at least this: near-white */
export const NEAR_WHITE = 245

/** One sample's verdict from its probe reads (true near-white, false not, null invalid): fewer than 4 valid is inconclusive; 70 % or more white is white. */
export function classify(reads: readonly (boolean | null)[]): Verdict {
  const valid = reads.filter((r): r is boolean => r !== null)
  if (valid.length < MIN_PROBES) return 'inconclusive'
  return valid.filter(Boolean).length / valid.length >= PROBES_WHITE ? 'white' : 'clear'
}

/** The share of a BGRA bitmap's pixels whose three colour channels are all near-white. */
export function wholeWhite(bmp: Uint8Array): number {
  const n = Math.floor(bmp.length / 4)
  if (!n) return 0
  let w = 0
  for (let i = 0; i < n * 4; i += 4) if (bmp[i]! >= NEAR_WHITE && bmp[i + 1]! >= NEAR_WHITE && bmp[i + 2]! >= NEAR_WHITE) w++
  return w / n
}

/** A probe's 3 x 3 crop around pixel (x, y) is near-white when at least 5 of its 9 pixels are; outside the image, null. */
export function probeWhite(bmp: Uint8Array, pw: number, ph: number, x: number, y: number): boolean | null {
  const cx = Math.round(x), cy = Math.round(y)
  if (cx < 1 || cy < 1 || cx >= pw - 1 || cy >= ph - 1) return null
  let w = 0
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = ((cy + dy) * pw + cx + dx) * 4
    if (bmp[i]! >= NEAR_WHITE && bmp[i + 1]! >= NEAR_WHITE && bmp[i + 2]! >= NEAR_WHITE) w++
  }
  return w >= 5
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

type Before = Extract<PerfMsg, { kind: 'probes'; at: 'before' }>
type After = Extract<PerfMsg, { kind: 'probes'; at: 'after' }>

/** What one tick found: its verdict, when its capture started, and the document it read. */
interface Done { tick: number; verdict: Verdict | 'skipped'; at: number; ident?: TabIdent; doc?: string }

/**
 * Tick numbers, never reset between gesture windows (review of a3-native, minor #14): main's waits are keyed
 * `tab:tick:at` and the shell keeps each tick's points by number, so a late answer from one window's tick k could
 * otherwise meet the next window's tick k and pair one window's "before" with the other's "after".
 */
let nextTick = 0
const takeTick = (): number => { const k = nextTick; nextTick = (nextTick + 1) % PERF_BOUNDS.counter; return k }

/** Counters, for the cost case and the journal. */
export interface WhiteoutStats { windows: number; ticks: number; captures: number; skipped: number; abandoned: number; inconclusive: number; white: number; clear: number; candidates: number; probed: number }
const zero = (): WhiteoutStats => ({ windows: 0, ticks: 0, captures: 0, skipped: 0, abandoned: 0, inconclusive: 0, white: 0, clear: 0, candidates: 0, probed: 0 })
let stats = zero()
export const whiteoutStats = (): WhiteoutStats => ({ ...stats })

const j = (data: unknown) => { if (__MV_TEST__) note('whiteout', data) }
const sameIdent = (a: TabIdent, b: TabIdent) => a.tab === b.tab && a.commit === b.commit && a.page === b.page && a.ws === b.ws

let stop: (() => void) | null = null

/** At ready, after the recorder. A second call replaces the first (tests). */
export function startWhiteout(p: WhiteoutPorts): void {
  stop?.()
  stats = zero()
  const waiting = new Map<string, { resolve(m: Before | After, doc: string): void }>()
  /** the gesture window: its tab, the gesture's seq, when it ends (Infinity while the gesture is on), its hard end */
  let win: { tabId: string; seq: number; until: number; hardEnd: number; timer?: ReturnType<typeof setTimeout>; counts: { samples: number; skipped: number; inconclusive: number } } | null = null
  /** one sample at a time, and at most one capture outstanding (A3.8 #15): an abandoned capture keeps the slot until
   *  its promise settles (r1 #5), so captures never pile up */
  let sampling = false
  let capturing = false
  /** the white run in progress, and the tick before (for pairing) */
  let run: { ident: TabIdent; doc: string; gesture: number; observedAt: number[]; lastTick: number } | null = null
  let last: Done | null = null

  const tickMs = () => T.whiteoutTickMs
  const rateHz = (): 4 | 2 => (tickMs() <= 250 ? 4 : 2)

  const off = p.onPerf((tabId, doc, msg) => {
    if (msg.kind === 'probes') {
      waiting.get(`${tabId}:${msg.tick}:${msg.at}`)?.resolve(msg, doc)
      return
    }
    if (msg.kind !== 'gesture') return
    const now = p.now()
    if (msg.on) {
      if (!p.recorderOn()) return
      const t = p.target()
      if (!t || t.tabId !== tabId) return
      if (win && win.tabId === tabId) { win.seq = msg.seq; win.until = Infinity; return }
      endWindow()
      win = { tabId, seq: msg.seq, until: Infinity, hardEnd: now + T.whiteoutMaxMs, counts: { samples: 0, skipped: 0, inconclusive: 0 } }
      stats.windows++
      j({ window: 'open', tab: tabId, seq: msg.seq })
      schedule(0)
    } else if (win && win.tabId === tabId) {
      win.until = now + T.whiteoutTailMs
    }
  })

  function schedule(delay: number) {
    if (!win) return
    win.timer = setTimeout(tick, Math.max(0, delay))
    ;(win.timer as { unref?: () => void }).unref?.()
  }

  function endWindow() {
    if (!win) return
    if (win.timer) clearTimeout(win.timer)
    j({ window: 'close', tab: win.tabId, seq: win.seq, ...win.counts })
    void flushRun()
    win = null
    last = null
  }

  function tick() {
    const w = win
    if (!w) return
    const now = p.now()
    if (now >= w.until || now >= w.hardEnd || !p.recorderOn()) { endWindow(); return }
    const k = takeTick()
    stats.ticks++
    schedule(tickMs())
    if (sampling || capturing) {
      stats.skipped++
      w.counts.skipped++
      settle(w, { tick: k, verdict: 'skipped', at: now })
      return
    }
    sampling = true
    void sampleOnce(w, k).finally(() => { sampling = false })
  }

  /** A probes ask; its answer within probeAnswerMs, with the document the bridge says sent it, else null. */
  function ask(tabId: string, tick: number, at: 'before' | 'after'): Promise<{ msg: Before | After; doc: string } | null> {
    return new Promise((resolve) => {
      const key = `${tabId}:${tick}:${at}`
      const t = setTimeout(() => { waiting.delete(key); resolve(null) }, T.probeAnswerMs)
      waiting.set(key, { resolve: (msg, doc) => { clearTimeout(t); waiting.delete(key); resolve({ msg, doc }) } })
      if (!p.ask(tabId, { kind: 'probes', tick, at })) { clearTimeout(t); waiting.delete(key); resolve(null) }
    })
  }

  async function sampleOnce(w: NonNullable<typeof win>, k: number): Promise<void> {
    const t = p.target()
    const at = p.now()
    if (!t || t.tabId !== w.tabId) { inconclusive(w, k, at, 'target'); return }
    const ident = t.ident
    const before = await ask(t.tabId, k, 'before') as { msg: Before; doc: string } | null
    if (!before || before.msg.kind !== 'probes' || before.msg.at !== 'before') { inconclusive(w, k, at, 'before'); return }
    // the capture: one at a time; past whiteoutCaptureMs abandoned, its slot kept until it settles
    capturing = true
    stats.captures++
    const capAt = p.now()
    let img: NativeImage | null = null
    let late = false
    const cap = t.wc.capturePage().then((x) => x, () => null).finally(() => { capturing = false })
    const res = await Promise.race([cap, new Promise<'late'>((r) => setTimeout(() => r('late'), T.whiteoutCaptureMs))])
    if (res === 'late') { late = true; stats.abandoned++ } else img = res
    if (late || !img || img.isEmpty()) { inconclusive(w, k, capAt, late ? 'abandoned' : 'empty'); return }
    // the whole view, scaled to 64 px: no probe work when it is not white
    let thumb: Uint8Array
    try { thumb = img.resize({ width: 64, quality: 'good' }).toBitmap() } catch { inconclusive(w, k, capAt, 'resize'); return }
    // the whole view's share, journaled with the path the sample took, so a case can tell a clear sample that never
    // reached the probes from one the probes cleared (a white frame on purpose must take the probe path)
    const whole = wholeWhite(thumb)
    if (whole < WHOLE_WHITE) { complete(w, { tick: k, verdict: 'clear', at: capAt, ident, doc: before.doc }, { probed: false, whole }); return }
    const after = await ask(t.tabId, k, 'after') as { msg: After; doc: string } | null
    const now = p.target()
    if (!after || after.msg.at !== 'after' || after.doc !== before.doc || !now || now.tabId !== w.tabId || !sameIdent(now.ident, ident)
      || after.msg.view.w !== before.msg.view.w || after.msg.view.h !== before.msg.view.h || after.msg.valid.length !== before.msg.points.length) {
      inconclusive(w, k, capAt, 'after'); return
    }
    // the probes, in device px read from the image itself (DIP-safe)
    const size = img.getSize()
    const bmp = img.toBitmap()
    const r = Math.sqrt(bmp.length / 4 / Math.max(1, size.width * size.height))
    const pw = Math.round(size.width * r), ph = Math.round(size.height * r)
    const s = pw / Math.max(1, before.msg.view.w)
    const reads = before.msg.points.map(([x, y], i) => after.msg.valid[i] ? probeWhite(bmp, pw, ph, x * s, y * s) : null)
    const v = classify(reads)
    if (v === 'inconclusive') { inconclusive(w, k, capAt, 'probes'); return }
    complete(w, { tick: k, verdict: v, at: capAt, ident, doc: before.doc }, { probed: true, whole, valid: reads.filter((x) => x !== null).length })
  }

  function inconclusive(w: NonNullable<typeof win>, k: number, at: number, why: string) {
    stats.inconclusive++
    w.counts.inconclusive++
    j({ tick: k, verdict: 'inconclusive', why })
    settle(w, { tick: k, verdict: 'inconclusive', at })
  }

  function complete(w: NonNullable<typeof win>, d: Done, path: { probed: boolean; whole: number; valid?: number }) {
    w.counts.samples++
    if (d.verdict === 'white') stats.white++; else stats.clear++
    if (path.probed) stats.probed++
    j({ tick: d.tick, verdict: d.verdict, probed: path.probed, whole: Math.round(path.whole * 1000) / 1000, ...(path.valid !== undefined ? { valid: path.valid } : {}) })
    settle(w, d)
  }

  /** Pair the tick with the one before (A3.8 #16, r1 #5): consecutive ticks, one document, at most 1.6 intervals apart. */
  function settle(w: NonNullable<typeof win>, d: Done) {
    if (win !== w) return
    const prev = last
    last = d
    if (d.verdict !== 'white') { void flushRun(); return }
    const pairs = prev && prev.verdict === 'white' && prev.tick === d.tick - 1 && prev.doc === d.doc && prev.ident && d.ident && sameIdent(prev.ident, d.ident)
      && d.at - prev.at <= tickMs() * 1.6
    if (run && run.lastTick === d.tick - 1 && pairs) { run.observedAt.push(d.at); run.lastTick = d.tick; return }
    void flushRun()
    if (pairs) run = { ident: prev!.ident!, doc: d.doc!, gesture: w.seq, observedAt: [prev!.at, d.at], lastTick: d.tick }
  }

  async function flushRun() {
    const r = run
    run = null
    if (!r) return
    const c = win?.counts ?? { samples: 0, skipped: 0, inconclusive: 0 }
    stats.candidates++
    const first = r.observedAt[0]!, lastAt = r.observedAt.at(-1)!
    const gpuEvents = safe(() => p.gpuEvents(first - 1000, lastAt + 1000), [] as RingEvent[])
    const agx = await p.readAgx(T.spawnTimeoutMs).catch(() => null)
    j({ candidate: r.observedAt.length, gesture: r.gesture })
    p.record(r.ident, {
      gesture: r.gesture, observedAt: r.observedAt, rateHz: rateHz(), samples: c.samples, skipped: c.skipped,
      inconclusive: c.inconclusive, gpuEvents,
      agx: agx ?? { gpuSystemMemoryMB: 'unknown', allocMB: 'unknown', utilPct: 'unknown', rendererPct: 'unknown', tilerPct: 'unknown', recoveryCount: 'unknown', machineWide: true },
    })
  }

  stop = () => { off(); endWindow(); waiting.clear() }
}

/** Tests: the detector off. */
export function stopWhiteout(): void { stop?.(); stop = null }

function safe<V>(f: () => V, fallback: V): V { try { return f() } catch { return fallback } }
