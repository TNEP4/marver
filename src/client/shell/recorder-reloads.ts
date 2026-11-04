/**
 * The edit's way to the frames, from the shell (spec 30 R1, R2): the reload Outbox (#16: `shell-boot`, `ready`,
 * `settled`, `invalidated`/`invalidated-nodes`, `inplace`, `watchdog`, each with `page` and `seq`, batched to
 * `POST perf/reload` under #7), the navigation tokens frozen at `startReload` (#14), the in-place reports
 * (`sh:inplace`, #15), the board writes' `x-mv-page`/`x-mv-cmds` headers (#18, `perfSeams.requestHeaders`) and the
 * watchdog's lines (#20). Owner: the edits stream.
 *
 * recorder.ts calls `startReloads()` once, at the full level only, after the page recorder is on. Until then every hook
 * here does nothing, and a reload line goes as 0.29's did (store.ts `reloadHooks`). It subscribes through
 * recorder-seams.ts and never imports recorder.ts.
 */
import { encodeCmds, RELOAD_BOUNDS, RELOAD_OUTBOX, WRITER_HEADERS, type HeldBy } from '../../shared/perf-records.ts'
import { WATCH_MAX_MS } from '../../shared/app-api.ts'
import { SH } from '../frame-host/messages.ts'
import { api, isStopped, resumed } from './api.ts'
import { watchWindow } from './app-perf.ts'
import { bootOf, iframeOf } from './canvas/frame-registry.ts'
import { isAsleep } from './canvas/sleep.ts'
import { heldBy } from './canvas/updates.ts'
import { cmdsForWrite } from './commands.ts'
import { PERF_RUN } from './perf-run.ts'
import { bound, fitWithin, Outbox, type PerfRecord } from './recorder-core.ts'
import { PAGE_ID, perfSeams } from './recorder-seams.ts'
import { logReload, reloadHooks, reloadLine, useStore } from './store.ts'

let on = false
const nodeOf = (key: string) => useStore.getState().nodes.find((n) => n.key === key)
/** Never in the way (#5), and nothing until started. */
const guard = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => { if (!on) return; try { fn(...a) } catch { /* never in the way */ } }
const chunk = <T>(list: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n))

// ---- #14: attribution frozen per navigation ---------------------------------------------------------------------

/** A node's revisions waiting for a navigation: all of them go with the next one (coalesced). `asleep`: as the first of
 *  them arrived - going stale wakes a node (FrameNode's sleep effect), so by its `startReload` it is always awake. */
interface Pending { revisions: string[]; arrivedAt: number; asleep: boolean; heldBy?: HeldBy }
/** One navigation of a node, frozen as it starts: what arrives after this belongs to the next. */
interface NavToken extends Pending { nav: number; startedAt: number; release: () => void }

const pending = new Map<string, Pending>()
const tokens = new Map<string, NavToken>()
/** each live document's id -> the node's navigation when it booted: a document is told by itself, not by the node's nav
 *  now (a job may have moved it on, its document not there yet) */
const docNav = new Map<string, number>()

// #38: `reload`, an on-screen job's `startReload` to its ready. One window however many jobs run; a job that never comes
// to its ready (the watchdog gave up, the node left) lets go at the app's own end for a window.
let watching = 0
function holdWatch(): () => void {
  if (watching++ === 0) watchWindow('reload', true)
  let held = true
  const t = setTimeout(() => release(), WATCH_MAX_MS)
  const release = () => {
    if (!held) return
    held = false
    clearTimeout(t)
    if (--watching === 0) watchWindow('reload', false)
  }
  return release
}

/** #13: counted over the board's nodes - one frame may have several, or none. */
function invalidated(frames: ReadonlySet<string>, revision: string): void {
  const s = useStore.getState()
  const nodes = s.nodes.filter((n) => frames.has(n.frame))
  const now = performance.now()
  const held: Partial<Record<HeldBy, number>> = {}
  let asleep = 0, awake = 0
  for (const n of nodes) {
    const why = heldBy(n, s)
    if (why) held[why] = (held[why] ?? 0) + 1
    if (isAsleep(n.key)) asleep++
    else if (!n.missing) awake++
    if (n.missing) continue   // it never goes stale: no navigation will carry this for it
    const p = pending.get(n.key)
    if (!p) pending.set(n.key, { revisions: [revision], arrivedAt: now, asleep: isAsleep(n.key) })
    else if (!p.revisions.includes(revision)) {
      p.revisions.push(revision)
      if (p.revisions.length > RELOAD_BOUNDS.idsPerLine) p.revisions.shift()
    }
  }
  const shown = new Set(nodes.map((n) => n.frame))
  const parts = chunk(nodes.map((n) => n.key), RELOAD_BOUNDS.idsPerLine)
  logReload({ kind: 'invalidated', revision, asked: frames.size, offBoard: [...frames].filter((f) => !shown.has(f)).length, onBoard: nodes.length, awake, asleep, held, ...(parts.length ? { parts: parts.length } : {}) })
  parts.forEach((p, i) => logReload({ kind: 'invalidated-nodes', revision, part: i + 1, parts: parts.length, nodes: p }))
  // a node gone from the board keeps nothing here: no ready will come for it
  const keys = new Set(s.nodes.map((n) => n.key))
  for (const k of pending.keys()) if (!keys.has(k)) pending.delete(k)
  for (const [k, t] of tokens) if (!keys.has(k)) { t.release(); tokens.delete(k) }
}

/** The first reason the queue refused a node, for the navigation that will carry its revisions. */
function held(key: string, why: HeldBy): void {
  const p = pending.get(key)
  if (p) p.heldBy ??= why
}

/** `startReload`: this navigation's token. A revision arriving from here on is the next navigation's. */
function started(key: string, nav: number): void {
  const p = pending.get(key)
  pending.delete(key)
  tokens.get(key)?.release()
  tokens.set(key, { revisions: p?.revisions ?? [], arrivedAt: p?.arrivedAt ?? performance.now(), asleep: p?.asleep ?? isAsleep(key), heldBy: p?.heldBy, nav, startedAt: performance.now(), release: holdWatch() })
}

/**
 * sh:ready, from the live document (App.tsx's `fromLiveDocument`), before `setStatus` pumps the next job and `setShown`
 * moves its wait: the token of the navigation this document belongs to, as the `ready` line's fields. A document with no
 * token - a first load, a reload by hand, a self reload - has none.
 */
export function takeNavToken(key: string, data: { boot?: unknown }): Record<string, unknown> | undefined {
  if (!on) return undefined
  try {
    const n = nodeOf(key)
    if (!n) return undefined
    const boot = typeof data.boot === 'string' ? data.boot : ''
    const nav = docNav.get(boot) ?? n.nav ?? 0
    docNav.delete(boot)
    // what setShown decides next: a document that already shows a revision that waited needs no navigation for it
    queueMicrotask(() => { if (!nodeOf(key)?.stale) pending.delete(key) })
    const t = tokens.get(key)
    if (!t || t.nav !== nav) return undefined
    tokens.delete(key)
    t.release()
    return { revisions: t.revisions, queuedMs: Math.round(t.startedAt - t.arrivedAt), bootMs: Math.round(performance.now() - t.startedAt), ...(t.heldBy ? { heldBy: t.heldBy } : {}), ...(t.asleep ? { asleep: true } : {}) }
  } catch { return undefined }
}

// ---- messages from the documents --------------------------------------------------------------------------------

function onFrameMessage(key: string, data: Record<string, unknown>): void {
  if (data.type === 'sh:boot' && typeof data.boot === 'string') {
    const n = nodeOf(key)
    if (!n) return
    docNav.set(data.boot, n.nav ?? 0)
    if (docNav.size > 1_024) docNav.delete(docNav.keys().next().value!)
  } else if (data.type === SH.inplace) {
    // #15: from the document there now; what it saw, no more
    if (typeof data.boot !== 'string' || data.boot !== bootOf(iframeOf(key))) return
    const n = nodeOf(key)
    if (!n) return
    logReload({ kind: 'inplace', node: key, frame: n.frame, hmrTs: data.hmrTs, fetched: true, applyMs: data.applyMs, nextObservedCommitMs: data.nextObservedCommitMs, applied: data.applied === false ? false : 'unknown' })
  }
}

/** #20: the watchdog's silence, before it acts. */
export const watchdogLine = guard((key: string, action: 'retry' | 'gave-up') => {
  const n = nodeOf(key)
  if (n) logReload({ kind: 'watchdog', node: key, frame: n.frame, nav: n.nav ?? 0, action })
})

// ---- #18: a board write names its page and its commands ----------------------------------------------------------

const BOARD_WRITE = /\/api\/(boards\/[^?#]+)/
const NOT_A_BOARD = new Set(['pin', 'status', 'rename', 'reorder'])
function writeHeaders(url: string, init: RequestInit): Record<string, string> | undefined {
  if (!init.method || init.method === 'GET') return undefined
  const route = BOARD_WRITE.exec(url)?.[1]
  if (!route) return undefined
  // the board, when the path names it - a body is never read (#4)
  const name = route.slice('boards/'.length)
  return { [WRITER_HEADERS.page]: PAGE_ID, [WRITER_HEADERS.cmds]: encodeCmds(cmdsForWrite(NOT_A_BOARD.has(name) ? '' : decodeURIComponent(name), route)) }
}

// ---- #16, #7: the reload Outbox ----------------------------------------------------------------------------------

const outbox = new Outbox(RELOAD_OUTBOX.max, RELOAD_OUTBOX.bytes)
let inFlight: PerfRecord[] = []
let sendTimer: ReturnType<typeof setTimeout> | undefined
let sending = false

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const post = (records: PerfRecord[], keepalive = false) => api('perf/reload', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
  body: JSON.stringify({ records }),
  ...(keepalive ? { keepalive: true } : {}),
})
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const armSend = () => { if (!sending && sendTimer === undefined && outbox.size) sendTimer = setTimeout(() => { sendTimer = undefined; void send() }, RELOAD_OUTBOX.sendMs) }
/** The `dropped` line that says how many went, when any did (the count starts over): R13's, a line like the others. */
const droppedNow = (more = 0): PerfRecord[] => {
  const n = outbox.dropped + more
  outbox.dropped = 0
  return n ? [reloadLine({ kind: 'dropped', n }) as PerfRecord] : []
}

/** As the page recorder's `send` (recorder.ts), under #7: a network failure or a server error is tried twice more, 2 s
 *  apart - the server answers only after its append returned, 503 when it failed; a 403 primes the request cookie once;
 *  any other refusal is final. What never lands is counted. */
async function send(): Promise<void> {
  clearTimeout(sendTimer)
  sendTimer = undefined
  if (!on || sending || !outbox.size) return
  // a headless run's documents are not this log's (its barrier refuses the route)
  if (PERF_RUN) { outbox.takeAll(); outbox.dropped = 0; return }
  sending = true
  let batch: PerfRecord[] = []
  let ok = false
  try {
    batch = [...droppedNow(), ...outbox.takeAll()]
    inFlight = batch
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await wait(RELOAD_OUTBOX.sendMs)
      try {
        let r = await post(batch)
        if (r.status === 403) { await api('work').catch(() => {}); r = await post(batch) }
        if (r.ok) ok = true
        else if (r.status < 500 || isStopped(r)) break
      } catch { /* the network: again */ }
    }
  } catch { /* never in the way: what it held is counted below */ }
  if (!ok) outbox.dropped += batch.reduce((n, r) => n + (r.kind === 'dropped' ? (r.n as number) : 1), 0)
  inFlight = []
  sending = false
  armSend()
}

/** The page is going (recorder.ts, after its own last records, only when no capture holds the allowance): this log's
 *  share of the keepalive, what does not fit counted in the last line that does. */
function leave(): void {
  clearTimeout(sendTimer)
  sendTimer = undefined
  if (PERF_RUN) return
  const all = [...inFlight, ...outbox.takeAll()]
  if (!all.length && !outbox.dropped) return
  const { fit, lost } = fitWithin([], all, RELOAD_OUTBOX.keepaliveBytes)
  try { void post([...fit, ...droppedNow(lost)], true).catch(() => {}) } catch { /* going anyway */ }
}

/** A line, as `logReload` built it. `shell-boot` adds what only the page knows (#16). */
function take(line: Record<string, unknown>): void {
  if (line.kind === 'shell-boot') {
    const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type
    if (nav) line.nav = bound(nav, 16)
    if (resumed) line.resumed = true
  }
  outbox.push(line as PerfRecord)
  armSend()
}

/** recorder.ts `startRecorder`, at the full level: the reload Outbox and its listeners. */
export function startReloads(): void {
  if (on) return
  on = true
  reloadHooks.line = guard(take)
  reloadHooks.invalidated = guard(invalidated)
  reloadHooks.started = guard(started)
  reloadHooks.held = guard(held)
  perfSeams.requestHeaders = (url, init) => { try { return writeHeaders(url, init) } catch { return undefined } }
  perfSeams.frameMessage.on(guard(onFrameMessage))
  perfSeams.leaving.on(guard(leave))
  document.addEventListener('visibilitychange', guard(() => { if (document.visibilityState === 'hidden') void send() }))
}
