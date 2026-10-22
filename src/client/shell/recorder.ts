/**
 * The recorder's page half (spec 28 A1.7): what each board load did, from the page - when it was asked for and
 * committed, when each frame reached its outcome, every move of a node and why, the first quiet second and settled -
 * plus gestures and errors. Records go to the dev server (POST /__mv/api/perf/page) and land in
 * design/.local/perf/page.jsonl; `npx marver perf --loads` reads them back.
 *
 * Dev only - off on a published canvas - and nothing at rest: no timer or frame of its own while no load is in flight
 * and nothing waits to be sent. The store tells it about loads and moves through its hooks (store.ts recorderHooks,
 * withCause); a frame's outcome counts only from the document its iframe shows now (`__mvBoot`, set by the frame
 * bridge). It reaches the canvas only through its dependency-free modules (ctl, admission, the frame registry), never
 * Canvas.tsx or FrameNode.tsx: a locked bundle (no canvas) imports it through the stage.
 */
import { api, isStopped } from './api.ts'
import { CONFIG, PUBLISHED, geometryCause, knownHeight, recorderHooks, reflowIdle, settleRule, useStore, type LoadCause, type Manifest, type MeasureResult, type Node, type RequestCut } from './store.ts'
import { admissionIdle, onAdmissionIdle } from './canvas/admission.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { bootOf, iframeOf } from './canvas/frame-registry.ts'
import { adopt, bound, fitWithin, KEEPALIVE_BYTES, LOAD_MAX_MS, newId, Outbox, outcomeOf, QUIET_MS, SEND_MS, stackLines, type Kind, type Outcome, type PerfRecord, type Track } from './recorder-core.ts'

/** This document, in every record (and, in the app, in its hello: the app's records about this tab carry it). */
export const PAGE_ID = newId()

type State = ReturnType<typeof useStore.getState>
type View = { x: number; y: number; w: number; h: number }
type Gesture = { type: 'pan' | 'zoom' | 'layout'; ms: number; frames: number; p50: number; p95: number; max: number; over17ms: number; over33ms: number; longFrames: number }

interface Load {
  id: string; board: string; cause: LoadCause; t0: number
  committedAt?: number
  /** the last move of this load (the commit counts as one): quiet is a second after it */
  lastMoveAt: number
  quietSent: boolean
  /** the visible cohort: the nodes the first camera placement after the commit showed */
  cohort?: Set<string>
  /** store changes that moved a node (before drags are merged), their distance, by cause */
  moves: number; distance: number; causes: Record<string, number>
  errors: number; errAt: Map<string, number>
  /** node key -> `${outcome}:${boot}` its last frame record said */
  reported: Map<string, string>
  done?: 'settled' | 'cut'
  quietTimer?: ReturnType<typeof setTimeout>; timeout?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>
}

let on = false
let ws = ''
let seq = 0
let capturesPending = (): boolean => false
let sealCaptures = (): void => {}
/** requested, not committed (or cut) yet */
const pending = new Map<string, Load>()
/** the load that owns the geometry: the last one committed */
let owner: Load | null = null
/** node key -> what its live document said (page-level: a reload of the same board keeps its documents) */
const tracks = new Map<string, Track>()
/** each node's geometry as last seen - numbers, not the node objects (applyManifest edits nodes in place) */
let baseline = new Map<string, { x: number; y: number; w: number; h: number }>()
const outbox = new Outbox()
/** a drag's or a resize's move record per node while it waits to be sent: the next pointermove adds to it */
const open = new Map<string, PerfRecord>()
let inFlight: PerfRecord[] = []
let sendTimer: ReturnType<typeof setTimeout> | undefined
let sending = false
/** what only the canvas knows (Canvas.tsx attaches it): is a pan, zoom or layout animation running; frames asleep */
let motion = { camera: false, preset: false }
let sleeping = (): number => 0
/** errors before any load committed, and their last time by kind (as a load's) */
const unowned = { errors: 0, errAt: new Map<string, number>() }

const env = (kind: Kind, load: string, body: Record<string, unknown>): PerfRecord =>
  ({ ...Object.fromEntries(Object.entries(body).filter(([, x]) => x !== undefined)), v: 1, ws, page: PAGE_ID, load, seq: seq++, ts: Date.now(), kind })
function rec(kind: Kind, load: string, body: Record<string, unknown>): PerfRecord {
  if (kind !== 'move') open.clear()   // a merged drag ends at the next record of another kind
  const r = env(kind, load, body)
  outbox.push(r)
  armSend()
  return r
}
const ownerId = () => owner?.id ?? '-'
/** ms from the load's request; undefined for a moment before it (a document kept from an earlier load) */
const rel = (L: Load, at?: number) => (at === undefined || at < L.t0 ? undefined : Math.round(at - L.t0))
const node = (key: string) => useStore.getState().nodes.find((n) => n.key === key)
/** The document a node's iframe shows now, by the id its bridge set - absent while a new document has not run its
 *  bridge yet, or when the frame was navigated off this origin (the read throws). */
const liveBoot = (key: string): string | undefined => bootOf(iframeOf(key))
/** the URL revision the node's iframe was given */
const genOf = (key: string) => iframeOf(key)?.src.match(/[?&]r=(\d+)/)?.[1]
function trackOf(n: Node): Track {
  let t = tracks.get(n.key)
  if (!t || t.frame !== n.frame) { t = { frame: n.frame }; tracks.set(n.key, t) }
  return t
}
const cameraMoving = () => motion.camera || motion.preset || canvasCtl.cameraBusy() || useStore.getState().gesture
/** Every method: off - nothing; and the recorder never stands in the way of the canvas. */
const guard = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => { if (!on) return; try { fn(...a) } catch { /* never in the way */ } }

/** Start recording, once, before the first board loads (shell/main.tsx). A published canvas: nothing at all. */
export function startRecorder(opts: { capturesPending: () => boolean; sealCaptures: () => void }): void {
  const w = window as { __mvRecorderOn?: boolean }
  if (on || PUBLISHED || !CONFIG.workspace || w.__mvRecorderOn) return   // a hot-replaced module never records twice
  w.__mvRecorderOn = true
  on = true
  ws = CONFIG.workspace
  capturesPending = opts.capturesPending
  sealCaptures = opts.sealCaptures
  recorderHooks.request = (board, cause) => { try { return request(board, cause) } catch { return '' } }
  recorderHooks.commit = guard(commit)
  recorderHooks.cut = guard(cutRequest)
  recorderHooks.reflowIdle = settleSoon
  onAdmissionIdle(settleSoon)
  useStore.subscribe(guard(onNodes))
  // the error's own message (not the event's "Uncaught …"), so a render error the boundary also reports is one error
  addEventListener('error', (e) => { if (e instanceof ErrorEvent) recorder.error({ source: 'shell', message: (e.error instanceof Error && e.error.message) || e.message || String(e.error), stack: (e.error as Error | undefined)?.stack }) })
  addEventListener('unhandledrejection', (e) => recorder.error({ source: 'shell', message: `unhandled rejection: ${(e.reason as Error | undefined)?.message ?? String(e.reason)}`, stack: (e.reason as Error | undefined)?.stack }))
  document.addEventListener('visibilitychange', guard(() => {
    if (document.visibilityState !== 'hidden') return
    if (owner && !owner.done) cut(owner, 'hidden')
    if (!capturesPending()) void send()   // a capture still to send has the way out first
  }))
  addEventListener('pagehide', guard(leave))
  if (import.meta.env.DEV) (window as unknown as { __mvRecorder: unknown }).__mvRecorder = { page: PAGE_ID, ws, state, send }
}

/** What only the canvas knows, from Canvas.tsx when it mounts: when the camera or a layout animation starts and stops
 *  (camera-broadcast.ts's observer), and how many frames sleep. Returns the detach. */
export function attachCanvas(c: { onMotion: (fn: (m: { camera: boolean; preset: boolean }) => void) => () => void; sleeping: () => number }): () => void {
  sleeping = c.sleeping
  const off = c.onMotion((m) => { motion = { camera: m.camera, preset: m.preset }; if (on && !m.camera && !m.preset) settleSoon() })
  return () => { off(); sleeping = () => 0; motion = { camera: false, preset: false } }
}

// ---- loads ------------------------------------------------------------------------------------------------------

function request(board: string, cause: LoadCause): string {
  if (!on) return ''
  const t0 = performance.now()
  const L: Load = { id: newId(), board, cause, t0, lastMoveAt: t0, quietSent: false, moves: 0, distance: 0, causes: {}, errors: 0, errAt: new Map(), reported: new Map() }
  pending.set(L.id, L)
  // `load`, its uncommitted `cut` and its `commit` carry the request's own id (the load's, once it commits)
  rec('load', L.id, { board, cause, request: L.id, ...(cause === 'boot' ? { sinceNav: Math.round(t0) } : {}) })
  return L.id
}

function cutRequest(id: string, reason: RequestCut): void {
  const L = pending.get(id)
  if (!L) return
  pending.delete(id)
  rec('cut', id, { reason, request: id, ms: Math.round(performance.now() - L.t0) })
}

function commit(id: string, nodes: readonly Node[], manifest: Manifest): void {
  const L = pending.get(id)
  if (!L) return
  pending.delete(id)
  // the load that was up ends here, its board's nodes still in the store
  if (owner && !owner.done) cut(owner, owner.board === L.board ? 'reload' : 'switch')
  owner = L
  L.committedAt = L.lastMoveAt = performance.now()
  // mounting is never a move: the baseline is the nodes about to mount
  baseline = new Map(nodes.map((n) => [n.key, { x: n.x, y: n.y, w: n.w, h: n.h }]))
  const keys = new Set(nodes.map((n) => n.key))
  for (const k of [...tracks.keys()]) if (!keys.has(k)) tracks.delete(k)
  rec('commit', id, { request: id, ms: Math.round(L.committedAt - L.t0), ...facts(nodes, manifest) })
  L.quietTimer = setTimeout(guard(() => quiet(L)), QUIET_MS)
  L.timeout = setTimeout(guard(() => cut(L, 'timeout')), Math.max(0, LOAD_MAX_MS - (L.committedAt - L.t0)))
  // a page hidden already: cut once the set that mounts this load has run - its nodes, not the board it replaces
  if (document.visibilityState === 'hidden') queueMicrotask(guard(() => { if (L === owner) cut(L, 'hidden') }))
}

/** What a load mounts: its frames by kind (Marver has no image frame kind), how many measure, and how many of those
 *  open at a height already known. */
function facts(nodes: readonly Node[], m: Manifest) {
  const byKind = { hifi: 0, content: 0, html: 0 }
  let measuring = 0, savedHeights = 0
  for (const n of nodes) {
    const f = n.missing ? undefined : m.frames.find((x) => x.id === n.frame)
    if (!f) continue
    if (f.kind === 'html') byKind.html++
    else if (f.contentWidth) byKind.content++
    else byKind.hifi++
    if (settleRule(n, m) === 'measure') { measuring++; if (knownHeight(f.id, n.w)) savedHeights++ }
  }
  return { frames: nodes.length, byKind, measuring, savedHeights }
}

// ---- moves ------------------------------------------------------------------------------------------------------

/** The store changed: one reference check, and only when the nodes changed, their numbers against the baseline. A
 *  node new to it joins (a manifest's newcomer, a spawn) - never a move; one gone leaves. */
function onNodes(s: State, prev: State): void {
  if (s.nodes === prev.nodes) return
  const L = owner
  if (!L) return
  const cause = geometryCause() ?? 'unknown'
  for (const n of s.nodes) {
    const b = baseline.get(n.key)
    if (!b) { baseline.set(n.key, { x: n.x, y: n.y, w: n.w, h: n.h }); continue }
    const dx = n.x - b.x, dy = n.y - b.y, dw = n.w - b.w, dh = n.h - b.h
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dw) < 0.5 && Math.abs(dh) < 0.5) continue
    b.x = n.x; b.y = n.y; b.w = n.w; b.h = n.h
    move(L, n.key, dx, dy, dw, dh, cause)
  }
  if (baseline.size > s.nodes.length + 32) { const keys = new Set(s.nodes.map((n) => n.key)); for (const k of [...baseline.keys()]) if (!keys.has(k)) baseline.delete(k) }
  // a node gone, or now missing, may be what the load waited for
  if (!L.done) settleSoon()
}

function move(L: Load, key: string, dx: number, dy: number, dw: number, dh: number, cause: string): void {
  const late = !!L.done
  if (!late) {
    L.moves++
    L.distance += Math.hypot(dx, dy) + Math.abs(dw) + Math.abs(dh)
    L.causes[cause] = (L.causes[cause] ?? 0) + 1
    L.lastMoveAt = performance.now()
    clearTimeout(L.quietTimer)
    L.quietTimer = setTimeout(guard(() => quiet(L)), QUIET_MS)
  }
  // a drag is one store change per pointermove: while its record waits to be sent, the next one adds to it
  const merges = cause === 'drag' || cause === 'resize'
  const m = merges ? open.get(key) : undefined
  if (m && m.cause === cause && m.load === L.id && outbox.has(m)) {
    m.dx = Math.round((m.dx as number) + dx); m.dy = Math.round((m.dy as number) + dy)
    m.dw = Math.round((m.dw as number) + dw); m.dh = Math.round((m.dh as number) + dh)
    outbox.touch(m)
    return
  }
  const r = rec('move', L.id, { node: key, dx: Math.round(dx), dy: Math.round(dy), dw: Math.round(dw), dh: Math.round(dh), cause, ...(late ? { late: true } : {}) })
  if (merges) open.set(key, r)
}

// ---- outcomes, quiet, settled, cut ----------------------------------------------------------------------------

function outcomeNow(n: Node, m: Manifest | null): Outcome | null {
  const rule = settleRule(n, m)
  const t = tracks.get(n.key)
  return outcomeOf(rule, t?.frame === n.frame ? t : undefined, rule === 'missing' ? undefined : liveBoot(n.key), { w: n.w, nav: n.nav, gen: genOf(n.key) })
}
/** What a message says of its document, for its track: its URL revision, and the navigation it arrived under. */
const docOf = (n: Node, data: { gen?: unknown }) => ({ gen: data.gen, nav: n.nav })
const said = (n: Node, o: Outcome | 'cut') => `${o}:${tracks.get(n.key)?.boot ?? ''}`

/** A node of the load in flight may have reached its outcome: its frame record, once per outcome and document. */
function progress(n: Node): void {
  const L = owner
  if (L && !L.done && L.committedAt !== undefined) {
    const o = outcomeNow(n, useStore.getState().manifest)
    if (o && L.reported.get(n.key) !== said(n, o)) frameRecord(L, n, o)
  }
  settleSoon()
}

function frameRecord(L: Load, n: Node, outcome: Outcome | 'cut'): void {
  const t = tracks.get(n.key)
  const times = [t?.admittedAt, t?.readyAt, t?.firstMeasureAt, t?.settled?.at]
  rec('frame', L.id, {
    node: n.key, frame: n.frame, gen: genOf(n.key), boot: t?.boot,
    admitted: rel(L, t?.admittedAt), ready: rel(L, t?.readyAt), firstMeasure: rel(L, t?.firstMeasureAt), settled: rel(L, t?.settled?.at),
    outcome,
    // its document is older than the load: a reload of the same board kept it
    ...(times.some((x) => x !== undefined && x < L.t0) ? { kept: true } : {}),
  })
  L.reported.set(n.key, said(n, outcome))
}

function quiet(L: Load): void {
  L.quietTimer = undefined
  if (L !== owner || L.done) return
  if (!L.quietSent) { L.quietSent = true; rec('quiet', L.id, { ms: Math.round(L.lastMoveAt - L.t0) }) }
  trySettle()
}

let soon = false
/** Check after what notified us is done (a hook may run inside a store change). */
function settleSoon(): void {
  if (!on || soon || !owner || owner.done) return
  soon = true
  queueMicrotask(() => { soon = false; try { trySettle() } catch { /* never in the way */ } })
}

/** Settled: every node at its outcome from its live document, no reflow pending or held, admission idle, the camera
 *  still, and a second with no move. Each gate that is not open comes back on its own: the quiet timer, the reflow
 *  and admission notifications, a frame's message - the camera alone is asked again shortly. */
function trySettle(): void {
  const L = owner
  if (!L || L.done || L.committedAt === undefined) return
  if (performance.now() - L.lastMoveAt < QUIET_MS) return
  if (!reflowIdle() || !admissionIdle()) return
  if (cameraMoving()) { L.retry ??= setTimeout(guard(() => { L.retry = undefined; trySettle() }), 150); return }
  const s = useStore.getState()
  const outs = s.nodes.map((n) => outcomeNow(n, s.manifest))
  if (outs.some((o) => !o)) return
  settle(L, s, outs as Outcome[])
}

function settle(L: Load, s: State, outs: Outcome[]): void {
  ensureVisible(L)
  s.nodes.forEach((n, i) => { if (L.reported.get(n.key) !== said(n, outs[i])) frameRecord(L, n, outs[i]) })
  const lastReady = (ns: readonly Node[]) => {
    const xs = ns.map((n) => tracks.get(n.key)?.readyAt).filter((x): x is number => x !== undefined)
    return xs.length ? Math.max(0, Math.round(Math.max(...xs) - L.t0)) : undefined
  }
  if (!L.quietSent) { L.quietSent = true; rec('quiet', L.id, { ms: Math.round(L.lastMoveAt - L.t0) }) }
  rec('settled', L.id, {
    ms: Math.round(performance.now() - L.t0), moves: L.moves, distance: Math.round(L.distance), causes: L.causes,
    visibleReadyMs: lastReady(s.nodes.filter((n) => L.cohort?.has(n.key))), allReadyMs: lastReady(s.nodes),
    missing: outs.filter((o) => o === 'missing').length, neverReady: outs.filter((o) => o === 'never-ready').length, errors: outs.filter((o) => o === 'error').length,
    weight: weight(),
  })
  finish(L, 'settled')
}

/** The load ended before it settled: another board, a reload of this one, the page hidden, or 120 s. What its nodes
 *  had reached goes with it; the others are `cut`. */
function cut(L: Load, reason: 'switch' | 'reload' | 'hidden' | 'timeout'): void {
  if (L.done) return
  const s = useStore.getState()
  ensureVisible(L)
  for (const n of s.nodes) {
    const o = outcomeNow(n, s.manifest)
    if (!o) frameRecord(L, n, 'cut')
    else if (L.reported.get(n.key) !== said(n, o)) frameRecord(L, n, o)
  }
  rec('cut', L.id, { reason, ms: Math.round(performance.now() - L.t0) })
  finish(L, 'cut')
}

function finish(L: Load, how: 'settled' | 'cut'): void {
  L.done = how
  clearTimeout(L.quietTimer); clearTimeout(L.timeout); clearTimeout(L.retry)
  L.quietTimer = L.timeout = L.retry = undefined
}

/** A settled load's weight: elements in the shell and its frames, iframes awake and asleep, the heap (Chrome). */
function weight() {
  let domNodes = document.getElementsByTagName('*').length
  const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.sh-live[src]')]
  for (const f of frames) { try { domNodes += f.contentDocument?.getElementsByTagName('*').length ?? 0 } catch { /* another origin */ } }
  const asleep = sleeping()
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory
  return { domNodes, iframes: frames.length, awake: Math.max(0, frames.length - asleep), asleep, ...(mem ? { heapMB: Math.round((mem.usedJSHeapSize / 1_048_576) * 10) / 10 } : {}) }
}

// ---- the visible cohort -----------------------------------------------------------------------------------------

const HEADER = 28   // a node's title bar, part of its box (FrameNode)
const cohortIn = (v: View) => new Set(useStore.getState().nodes
  .filter((n) => n.x < v.x + v.w && n.x + n.w > v.x && n.y < v.y + v.h && n.y + n.h + HEADER > v.y).map((n) => n.key))
/** No fit landed before the load ended (a reload of the board in view): the cohort is what the camera shows. */
function ensureVisible(L: Load): void {
  if (L.cohort || L.committedAt === undefined) return
  const v = canvasCtl.view()
  L.cohort = v ? cohortIn(v) : new Set()
  rec('visible', L.id, { nodes: L.cohort.size, ms: Math.round(performance.now() - L.t0), assumed: true })
}

// ---- errors -----------------------------------------------------------------------------------------------------

let inError = false
/** the errors past a load's 50, counted in one `dropped` record while it waits to be sent (the next one adds to it) */
let over: PerfRecord | null = null
/** ≤ 50 per load (those past it counted), the same one at most once a second; messages and stack lines cut to 200
 *  characters. An error after the load settled or was cut is `late` - the load owns the geometry for as long as its
 *  board stays open. */
function logError(e: { source: 'shell' | 'frame' | 'stage'; frame?: string; component?: string; message: unknown; stack?: unknown }): void {
  if (inError) return
  inError = true
  try {
    const message = bound(typeof e.message === 'string' ? e.message : String(e.message ?? ''))
    if (!message) return
    const L = owner, mine = L ?? unowned
    const key = `${e.source}|${e.frame ?? ''}|${message}`, now = performance.now()
    if (now - (mine.errAt.get(key) ?? -Infinity) < 1000) return
    if (mine.errors >= 50) {
      if (over && over.load === ownerId() && outbox.has(over)) { over.n = (over.n as number) + 1; outbox.touch(over) }
      else over = rec('dropped', ownerId(), { n: 1, reason: 'errors' })
      return
    }
    mine.errors++
    mine.errAt.set(key, now)
    const stack = Array.isArray(e.stack) ? e.stack.slice(0, 3).map((l) => bound(l)).filter((l): l is string => !!l) : stackLines(e.stack)
    rec('error', ownerId(), { source: e.source, frame: bound(e.frame), component: bound(e.component), message, ...(stack?.length ? { stack } : {}), ...(L?.done ? { late: true } : {}) })
  } finally { inError = false }
}

// ---- sending ----------------------------------------------------------------------------------------------------

const armSend = () => { if (!sending && sendTimer === undefined && outbox.size) sendTimer = setTimeout(() => { sendTimer = undefined; void send() }, SEND_MS) }
const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const post = (records: PerfRecord[], keepalive = false) => api('perf/page', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
  body: JSON.stringify({ records }),
  ...(keepalive ? { keepalive: true } : {}),
})
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** The `dropped` record that says how many went, when any did (the count starts over). */
const droppedNow = (more = 0): PerfRecord[] => {
  const n = outbox.dropped + more
  outbox.dropped = 0
  return n ? [env('dropped', ownerId(), { n })] : []
}

/** Everything waiting, in one request (the queue is bounded under what the server takes); one at a time. A network
 *  failure or a server error is tried twice more, 2 s apart; a 403 primes the request cookie once (a page's first
 *  request may go before it exists, as logReload's); any other refusal is final. What never lands is counted. */
async function send(): Promise<void> {
  clearTimeout(sendTimer)
  sendTimer = undefined
  if (!on || sending || !outbox.size) return
  sending = true
  let batch: PerfRecord[] = []
  let ok = false
  try {
    batch = [...droppedNow(), ...outbox.takeAll()]
    open.clear()
    inFlight = batch
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await wait(SEND_MS)
      try {
        let r = await post(batch)
        if (r.status === 403) { await api('work').catch(() => {}); r = await post(batch) }
        if (r.ok) ok = true
        else if (r.status < 500 || isStopped(r)) break   // refused (a bad batch), or this canvas stopped: trying again cannot help
      } catch { /* the network: again */ }
    }
  } catch { /* never in the way: what it held is counted below */ }
  if (!ok) outbox.dropped += batch.filter((r) => r.kind !== 'dropped').length + batch.filter((r) => r.kind === 'dropped').reduce((n, r) => n + (r.n as number), 0)
  inFlight = []
  sending = false
  armSend()
}

/** The page is going. The load in flight is cut; captures go first - a capture still open is sealed here (whichever
 *  pagehide listener runs first), and while one waits to be sent or is on its way the keepalive allowance is its:
 *  the recorder sends nothing. Else its last records with keepalive, 16 KB at most, the cut first; the rest counted. */
function leave(): void {
  if (owner && !owner.done) cut(owner, 'hidden')
  clearTimeout(sendTimer)
  sendTimer = undefined
  sealCaptures()
  if (capturesPending()) return
  // a send on its way may not outlive the page: its records again (the report drops a duplicate by its seq)
  const all = [...inFlight, ...outbox.takeAll()]
  if (!all.length) return
  const { fit, lost } = fitWithin(all.filter((r) => r.kind === 'cut'), all.filter((r) => r.kind !== 'cut'), KEEPALIVE_BYTES)
  try { void post([...fit, ...droppedNow(lost)], true).catch(() => {}) } catch { /* going anyway */ }
}

// ---- for tests --------------------------------------------------------------------------------------------------

function state() {
  const s = useStore.getState()
  return {
    owner: owner && { id: owner.id, board: owner.board, cause: owner.cause, committed: owner.committedAt !== undefined, done: owner.done ?? null, cohort: owner.cohort ? [...owner.cohort] : null },
    pending: [...pending.keys()], queued: outbox.size, sending, motion, admissionIdle: admissionIdle(),
    nodes: Object.fromEntries(s.nodes.map((n) => [n.key, outcomeNow(n, s.manifest)])),
  }
}

// ---- what the shell tells it ------------------------------------------------------------------------------------

export const recorder = {
  /** A node's mount got its boot slot (FrameNode). */
  admitted: guard((key: string) => { const n = node(key); if (n) trackOf(n).admittedAt = performance.now() }),
  /** A frame document started (sh:boot): its node's story starts over - before its `load`, without polling. */
  booted: guard((key: string, data: { boot?: unknown; gen?: unknown }) => { const n = node(key); if (n) adopt(trackOf(n), data.boot, liveBoot(key), docOf(n, data)) }),
  /** sh:ready, after the shell's own generation check. */
  ready: guard((key: string, data: { boot?: unknown; gen?: unknown }) => {
    const n = node(key)
    if (!n) return
    const t = trackOf(n)
    if (!adopt(t, data.boot, liveBoot(key), docOf(n, data))) return   // a document since replaced never counts
    t.readyAt ??= performance.now()
    progress(n)
  }),
  /** sh:measure, with what the store took: only a settled report taken at the node's width settles it. */
  measured: guard((key: string, data: { boot?: unknown; gen?: unknown; settled?: unknown }, took: MeasureResult) => {
    const n = node(key)
    if (!n) return
    const t = trackOf(n)
    if (!adopt(t, data.boot, liveBoot(key), docOf(n, data))) return
    t.firstMeasureAt ??= performance.now()
    // the first settled report at a width is when the node settled there
    if (data.settled === true && took.took === 'fit' && took.w !== undefined && t.settled?.w !== took.w) t.settled = { at: performance.now(), w: took.w }
    else if (took.took === 'width') delete t.settled   // its width changed: the next report is the one
    progress(n)
  }),
  /** sh:error, after the shell's generation check: recorded, and the node's outcome when it is its live document's. */
  frameError: guard((key: string, data: { id?: unknown; boot?: unknown; gen?: unknown; message?: unknown; stack?: unknown }) => {
    // an error from a document since replaced is no error of this page's (the shell drops it before here too)
    if (typeof data.boot !== 'string' || data.boot !== liveBoot(key)) return
    const n = node(key)
    logError({ source: 'frame', frame: bound(data.id) ?? n?.frame, message: data.message, stack: data.stack })
    if (!n) return
    const t = trackOf(n)
    if (adopt(t, data.boot, liveBoot(key), docOf(n, data))) { t.errorAt ??= performance.now(); progress(n) }
  }),
  /** The ready watchdog's second silence (FrameNode): never-ready for this navigation. The frame stays loading. */
  neverReady: guard((key: string) => {
    const n = node(key)
    if (!n) return
    trackOf(n).neverReady = { at: performance.now(), nav: n.nav ?? 0 }
    progress(n)
  }),
  /** The iframe's load event: one more moment to check - it never resets an outcome. */
  loaded: guard((_key: string) => settleSoon()),
  /** Where a fit sends the camera, in world px (Canvas.tsx): the first one after a commit is the visible cohort. */
  placed: guard((view: View) => {
    const L = owner
    if (!L || L.committedAt === undefined || L.cohort) return
    L.cohort = cohortIn(view)
    rec('visible', L.id, { nodes: L.cohort.size, ms: Math.round(performance.now() - L.t0) })
  }),
  /** A pan, zoom or layout animation ended (perf.ts). */
  gesture: guard((g: Gesture) => { rec('gesture', ownerId(), g); settleSoon() }),
  /** An error the shell saw: its own (window, ShellBoundary) or the play stage's. A shell error goes out at once. */
  error: guard((e: { source: 'shell' | 'stage'; message: unknown; stack?: unknown; component?: string }) => {
    logError(e)
    if (e.source === 'shell' && !capturesPending()) void send()
  }),
}
