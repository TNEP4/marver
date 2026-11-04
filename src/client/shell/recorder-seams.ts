/**
 * The page recorder's seams (spec 30): what the shared shell files call and the spec 30 streams fill, so each stream's
 * work stays in its own module. Dependency-free (recorder-core.ts and types only): store.ts, api.ts, App.tsx, Play.tsx
 * and every stream module import it without a cycle - recorder.ts imports store.ts, so a stream module that store.ts
 * or api.ts reaches must never import recorder.ts at its top level for a value it reads at load.
 *
 * Two shapes, as store.ts's `recorderHooks`: a settable function where one owner answers (a header, a transition id),
 * and a tap (listeners, each run in a try, never in the way) where several streams listen to one point. Every tap is
 * silent until a stream subscribes, and the streams subscribe only from their starters (recorder.ts `startRecorder`,
 * never under the `core` level), so a published canvas, a `core` run and a page without the recorder pay one call.
 *
 * FROZEN before the spec 30 streams split. Who fills what (.r30-contracts.md has the whole map):
 *  - `record`, `load`, `leaving`: recorder.ts (the page recorder writes through `record`; its loads' phases and its
 *    `pagehide` are told to whoever listens - commands' `board-open`, app-store's `watch load`, edits' reload Outbox);
 *  - `requestHeaders`: edits (#18: a board write's `x-mv-page` and `x-mv-cmds`, from commands.ts `cmdsForWrite`);
 *  - `answered`: signals (#31: `api` errors), commands (#49: a write's or a call's answer ends its commands);
 *  - `frameMessage`, `stageMessage`: signals (acks with `t`, `sh:mode-applied`, `sh:dropped`, `sh:renders`,
 *    `sh:console`, `sh:resource-error`), edits (`sh:inplace`), commands (`sh:stage-shown` ends play commands);
 *  - `transition`: signals (#21: the `t` FrameNode and Play send with `sh:set-theme`, `sh:laser` and `sh:pick`);
 *  - `selfCost`: app-store (#58: `self` records' `hookMs`), charged by every stream through `hooked()`.
 */
import { newId } from './recorder-core.ts'
import { busyWait, SLOW_HOOK, SLOW_HOOK_MS } from '../recorder-level.ts'
import type { LoadTrigger, PageKind, SelfHook } from '../../shared/perf-records.ts'
import type { LoadCause } from './store.ts'

/** This document, in every record (and, in the app, in its hello: the app's records about this tab carry it). */
export const PAGE_ID = newId()

let seq = 0
/** The page's one record order (spec 30 #7, #16): page records and reload lines share it, so `(page, seq)` names one
 *  record of this page whichever file it lands in. */
export const nextSeq = (): number => seq++

type Listener<A extends unknown[]> = (...a: A) => void
/** Listeners at one point: each runs in a try - a stream's hook never stands in the way, nor stops another's (#5). */
export interface Tap<A extends unknown[]> {
  on(fn: Listener<A>): () => void
  emit(...a: A): void
  readonly size: number
}
export function tap<A extends unknown[]>(): Tap<A> {
  const fns = new Set<Listener<A>>()
  return {
    on(fn) { fns.add(fn); return () => { fns.delete(fn) } },
    emit(...a) { if (fns.size) for (const fn of [...fns]) { try { fn(...a) } catch { /* never in the way */ } } },
    get size() { return fns.size },
  }
}

/** A request mvFetch sent and how it ended: `status` the HTTP status, 0 the network, `timeout` its abort signal's
 *  timeout. `headers` as sent (the board write's `x-mv-cmds` among them). Never a body. */
export interface Answered { url: string; init: RequestInit; headers: Record<string, string> | undefined; status: number | 'timeout'; ms: number }

/** Why a load or a request ended unsettled (the server's `CUT_REASONS`). */
export type CutReason = 'switch' | 'reload' | 'hidden' | 'timeout' | 'superseded' | 'error' | 'edited' | 'unsaved'
/**
 * A load's way, as the page recorder sees it (its records carry the same ids). `request`: asked for (#38's `load`
 * window opens here); `visible`: the cohort chosen (`assumed` when no fit landed); `commit` (`late`: a request already
 * cut mounted all the same); `settled`; `cut` (`request`: before it committed). `visible-ready` - the cohort's frames
 * all ready (#49's step) - is the commands stream's to emit, from progress() (recorder.ts).
 */
export type LoadPhase =
  | { phase: 'request'; load: string; board: string; cause: LoadCause; trigger?: LoadTrigger }
  | { phase: 'visible'; load: string; nodes: number; assumed?: true }
  | { phase: 'visible-ready'; load: string }
  | { phase: 'commit'; load: string; late?: true }
  | { phase: 'settled'; load: string }
  | { phase: 'cut'; load: string; reason: CutReason; request?: true }

/** The transitions whose id a message to a document carries (#21, #26). */
export type TransitionKind = 'theme' | 'mode'

export const perfSeams = {
  /** recorder.ts sets it: true while the page records (dev, not published, a workspace) */
  on: false,
  /** recorder.ts sets it: a record of `kind` into page.jsonl, through the page's envelope (`page`, `seq`, `ts`) and
   *  outbox; `load` the load that owns the geometry unless given. Nothing while the page does not record */
  record: (_kind: PageKind, _body: Record<string, unknown>, _load?: string): void => {},
  /** recorder.ts: each load's phases */
  load: tap<[p: LoadPhase]>(),
  /** recorder.ts, at `pagehide`, after the page's own last records went (#7's order: Jam's captures, page records
   *  16 KB, then reload lines 8 KB) - never while a capture holds the keepalive allowance */
  leaving: tap<[]>(),
  /** mvFetch (api.ts), before it sends a request this page's canvas will answer: headers to add, or undefined */
  requestHeaders: (_url: string, _init: RequestInit): Record<string, string> | undefined => undefined,
  /** mvFetch (api.ts): every request that got an answer or failed - `perf/*` included; a listener skips what it must */
  answered: tap<[a: Answered]>(),
  /** App.tsx: every `sh:*` message from a registered frame, before the shell handles it (a listener checks the
   *  document itself - `fromLiveDocument` - and never consumes the message) */
  frameMessage: tap<[node: string, data: Record<string, unknown>]>(),
  /** Play.tsx: every message from the play stage's live iframe, before the shell handles it */
  stageMessage: tap<[data: Record<string, unknown>]>(),
  /** FrameNode.tsx and Play.tsx, as they post a theme or a mode to a document: the transition it belongs to, or none */
  transition: (_kind: TransitionKind): string | undefined => undefined,
  /** app-store (#58): a hook's own time, by hook - `hooked()` charges it */
  selfCost: (_hook: SelfHook, _ms: number): void => {},
}

let hookDepth = 0
/** Is a measured hook running? (`self` counts a record written inside one as that hook's.) */
export const insideHook = (): boolean => hookDepth > 0

/** A stream's hook, as recorder.ts's `guard`: nothing while the page does not record, never in the way - and its time
 *  charged to `hook` in `self` (#58) when it is one of the measured hooks. `?mvslowhook=<hook>` adds the cost run's
 *  injected wait here (recorder-level.ts, test only). */
export function hooked<A extends unknown[]>(hook: SelfHook | null, fn: (...a: A) => void): (...a: A) => void {
  return (...a) => {
    if (!perfSeams.on) return
    const t0 = hook ? performance.now() : 0
    if (hook) hookDepth++
    if (hook && hook === SLOW_HOOK) busyWait(SLOW_HOOK_MS)
    try { fn(...a) } catch { /* never in the way */ }
    if (hook) { hookDepth--; try { perfSeams.selfCost(hook, performance.now() - t0) } catch { /* the same */ } }
  }
}
