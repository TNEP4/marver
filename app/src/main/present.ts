/**
 * Presentation epochs (spec 28 A2.2, A3.8 #27, #28, #30, r2 #2, r3 #1): when the cover may lift over a full-height
 * canvas view. Owner: the one-ground stream. Pure: no Electron import; its one send port is the caller's.
 *
 * - Epochs are one counter across all tabs and documents, so a number never repeats. An epoch belongs to a key -
 *   `doc`, `w x h`, HTML fullscreen and the view's `gen` - and compose derives the key from the model every time, so
 *   a second compose in the same state makes no new epoch, and an event a handler forgot still shows as a key.
 * - `gen` is how main says "what was presented no longer counts" when nothing else in the key moves: a per-view
 *   counter advanced in the event's turn at four events only - the view shown after being hidden, its document's
 *   accepted hello, a live resize's end, and, for every view at once, the GPU process lost (gone, or its identity
 *   changed or missing: Electron 45 sends no event for a clean exit).
 * - Main sends `mv:present { doc, epoch, w, h, frames }` once per epoch, after the turn's view changes, never during a
 *   live resize (the caller's rule); a send that fails is retried by the next compose, covered meanwhile.
 * - Main accepts a reply only for the tab's current epoch, from its admitted, trusted document (the bridge's check;
 *   `doc` here), at that size within 1 px, with the GPU identity read in the turn of acceptance unchanged. Anything
 *   else is journaled and changes nothing. The cover lifts at the first compose after acceptance plus
 *   `T.uncoverDelayMs` (0 to start; "the wait grows" is `presentFrames`, then that delay - main's numbers).
 * - Every epoch that was sent ends in one `cover` record (app-perf.ts, the recorder's): what made it (`cause`: a new
 *   document, a size, HTML fullscreen, or the gen event - shown, hello, a live resize's end, the GPU process lost),
 *   how it ended (`uncovered`, `mismatch`, `superseded` by a newer key, or `never` - superseded or forgotten a second
 *   or more after it was sent with no answer) and its times from its start: sent, answered, uncovered. They are what
 *   `presentFrames` and `uncoverDelayMs` are tuned from (A3.8 #27). An epoch never sent records nothing.
 *
 * FROZEN (A3.8 #53): `PresentKey`, `observe`, `flush`, `answer`, `forget`, `bumpGen`, `noteGpu`, `gpuGone`.
 */
import type { Present, Presented } from '../../../src/shared/app-api.ts'
import { BOUNDS } from '../../../src/shared/app-api.ts'
import type { AppBody, GpuIdentity, TabIdent } from '../../../src/shared/app-perf.ts'
import { T } from './timings.ts'

/** What an epoch is about; `gen` is the view's generation (the four events above). */
export interface PresentKey { doc: string; w: number; h: number; fs: boolean; gen: number }

/** What `answer` made of a reply: `ok` lifts the cover at the next compose (plus `uncoverDelayMs`). */
export type PresentVerdict = 'ok' | 'stale' | 'mismatch' | 'refused' | 'lost'

/** What made an epoch, and the gen events among them. */
export type PresentCause = AppBody<'cover'>['cause']
export type GenCause = Extract<PresentCause, 'show' | 'hello' | 'resize' | 'gpu'>
/** A `cover` record's body (the caller adds the tab's identity, taken when the epoch began). */
export type CoverRecord = Omit<AppBody<'cover'>, keyof TabIdent>

interface Slot {
  epoch: number; key: string; doc: string; w: number; h: number; fs: boolean; sent: boolean; okAt?: number
  cause: PresentCause; at: number; sentAt?: number; answeredAt?: number; frames: number; recorded: boolean
}

const slots = new Map<string, Slot>()
const gens = new Map<string, number>()
/** the cause of each view's last gen event */
const genCause = new Map<string, GenCause>()
let epochs = 0
/** the GPU process's identity as last read; undefined until the first read (a baseline, not a loss) */
let gpu: GpuIdentity | null | undefined

export type PresentLog = (d: { tab: string; op: 'ask' | 'answer' | 'stale' | 'mismatch' | 'refused' | 'lost'; epoch: number; doc?: string; w?: number; h?: number; gen?: number }) => void
let log: PresentLog | null = null
/** The journal's `present` topic (test builds). */
export function onPresentLog(fn: PresentLog | null): void { log = fn }

type RecordPort = (tab: string, epoch: number, r: CoverRecord) => void
let record: RecordPort | null = null
/** Where each sent epoch's `cover` record goes (window.ts: recorder.event). */
export function onCoverRecord(fn: RecordPort | null): void { record = fn }

/** An epoch ends: its record, once, if it was ever sent. */
function end(tab: string, s: Slot, now: number, outcome: CoverRecord['outcome'], uncoveredAt?: number): void {
  if (s.recorded || s.sentAt === undefined) return
  s.recorded = true
  const out = outcome === 'superseded' && s.answeredAt === undefined && now - s.sentAt >= 1000 ? 'never' : outcome
  record?.(tab, s.epoch, {
    epoch: s.epoch, cause: s.cause, outcome: out,
    sentMs: Math.max(0, Math.round(s.sentAt - s.at)),
    ...(s.answeredAt !== undefined ? { answeredMs: Math.max(0, Math.round(s.answeredAt - s.at)) } : {}),
    ...(uncoveredAt !== undefined ? { uncoveredMs: Math.max(0, Math.round(uncoveredAt - s.at)) } : {}),
    frames: s.frames, uncoverDelayMs: Math.max(0, T.uncoverDelayMs),
  })
}

const keyOf = (k: PresentKey) => `${k.doc}|${k.w}x${k.h}|${k.fs ? 'fs' : '-'}|${k.gen}`

/** The view's generation now (the key's `gen`). */
export const genOf = (tab: string): number => gens.get(tab) ?? 0

/** The tab's current epoch, or null when it has none. */
export const epochOf = (tab: string): number | null => slots.get(tab)?.epoch ?? null

/** compose, before plan(): the active, eligible view's key now; true when its current epoch is accepted (and its delay passed). */
export function observe(tab: string, k: PresentKey, now: number): boolean {
  const key = keyOf(k)
  let s = slots.get(tab)
  if (!s || s.key !== key) {
    const was = s
    const cause: PresentCause = !was || was.doc !== k.doc ? 'doc' : was.fs !== k.fs ? 'fullscreen'
      : was.w !== k.w || was.h !== k.h ? 'size' : genCause.get(tab) ?? 'show'
    if (was) end(tab, was, now, 'superseded')
    epochs = epochs >= BOUNDS.epoch ? 1 : epochs + 1
    s = { epoch: epochs, key, doc: k.doc, w: k.w, h: k.h, fs: k.fs, sent: false, cause, at: now, frames: 0, recorded: false }
    slots.set(tab, s)
  }
  return s.okAt !== undefined && now >= s.okAt
}

/** When the tab's accepted epoch may lift the cover (its delay), or null: the caller composes then. */
export const liftAt = (tab: string): number | null => slots.get(tab)?.okAt ?? null

/** compose, after the views were applied and with no live resize: send the current epoch once; a failed send is retried by the next compose. */
export function flush(tab: string, send: (doc: string, r: Present) => boolean, frames: number, now: number = Date.now()): void {
  const s = slots.get(tab)
  if (!s || s.sent || s.okAt !== undefined) return
  const f = Math.min(BOUNDS.frames, Math.max(1, Math.round(frames) || 1))
  let ok = false
  try { ok = send(s.doc, { epoch: s.epoch, w: s.w, h: s.h, frames: f }) } catch { ok = false }
  if (!ok) return
  s.sent = true
  s.sentAt = now
  s.frames = f
  log?.({ tab, op: 'ask', epoch: s.epoch, doc: s.doc, w: s.w, h: s.h, gen: genOf(tab) })
}

/** The bridge accepted an `mv:presented` from the tab's admitted document; `gpu` is the GPU identity read now. */
export function answer(tab: string, doc: string, r: Presented, now: number, gpuNow: GpuIdentity | null): PresentVerdict {
  // the GPU process replaced since the request: what the page drew may never reach the screen (A3.8 r3 #1)
  if (noteGpu(gpuNow)) { log?.({ tab, op: 'lost', epoch: r.epoch, doc }); return 'lost' }
  const s = slots.get(tab)
  if (!s) { log?.({ tab, op: 'refused', epoch: r.epoch, doc }); return 'refused' }
  if (doc !== s.doc || r.epoch !== s.epoch || !s.sent) { log?.({ tab, op: 'stale', epoch: r.epoch, doc, w: r.w, h: r.h }); return 'stale' }
  if (Math.abs(r.w - s.w) > 1 || Math.abs(r.h - s.h) > 1) {
    log?.({ tab, op: 'mismatch', epoch: r.epoch, doc, w: r.w, h: r.h })
    s.answeredAt ??= now
    end(tab, s, now, 'mismatch')   // it stays covered: the 0.1 look, and its record says so (A3.8 #27)
    return 'mismatch'
  }
  if (s.okAt === undefined) { s.okAt = now + Math.max(0, T.uncoverDelayMs); s.answeredAt = now }
  log?.({ tab, op: 'answer', epoch: r.epoch, doc, w: r.w, h: r.h, gen: genOf(tab) })
  return 'ok'
}

/** window.ts, in the turn the cover lifts over the tab's view: its epoch's record says uncovered. */
export function uncovered(tab: string, now: number = Date.now()): void {
  const s = slots.get(tab)
  if (s && s.okAt !== undefined) end(tab, s, now, 'uncovered', now)
}

/** The view closed, unloaded or its renderer went: its epochs and gen forgotten. */
export function forget(tab: string, now: number = Date.now()): void {
  const s = slots.get(tab)
  if (s) end(tab, s, now, 'superseded')
  slots.delete(tab); gens.delete(tab); genCause.delete(tab)
}

/** One of the four events for one view: what was presented no longer counts. `cause` names it for the record. */
export function bumpGen(tab: string, cause: GenCause = 'show'): void { gens.set(tab, genOf(tab) + 1); genCause.set(tab, cause) }

/** Every view's generation advanced (a live resize's end, the GPU process lost). */
export function bumpAll(cause: GenCause = 'resize'): void {
  for (const tab of new Set([...gens.keys(), ...slots.keys()])) bumpGen(tab, cause)
}

/** The GPU identity read now (a sample, a gpu-info-update): true when it changed or went - every view's gen advanced; the caller composes. */
export function noteGpu(id: GpuIdentity | null): boolean {
  if (gpu === undefined) { gpu = id; return false }
  const same = gpu && id ? gpu.pid === id.pid && gpu.born === id.born : gpu === id
  if (same) return false
  gpu = id
  bumpAll('gpu')
  return true
}

/**
 * `child-process-gone` with type GPU: every view covered until it presents again, at an epoch made after the loss.
 * The next identity read is a fresh baseline: the replacement is the loss already counted, not a second one.
 */
export function gpuGone(): void {
  gpu = undefined
  bumpAll('gpu')
}

/** Test seam: nothing asked, nothing read. */
export function resetPresent(): void { slots.clear(); gens.clear(); genCause.clear(); epochs = 0; gpu = undefined }
