/**
 * What the page signals beyond loads (spec 30 R3-R6): theme switches by transition (#21-#23), modes (#24-#27), the new
 * error sources and their budgets (#28-#33: console, vite, api, resource, the frames' `sh:dropped` counts), the gesture
 * posts to the frames (#36; its scale, awake count and Long Animation Frames are perf.ts's and recorder.ts's, #34, #35)
 * and the React Profiler's minutes (#36). Owner: the signals stream.
 *
 * `startSignals()` runs once, at the full level only, after the page recorder is on (recorder.ts `startRecorder`). It
 * subscribes through recorder-seams.ts and the stores, writes through `perfSeams.record` (and `signalSink`, which
 * recorder.ts fills beside `logError`), sets `perfSeams.transition`, and asks the Mac app for `theme` windows.
 *
 * A record never lies (R0): an ack counts only with the transition's own `t` and from the live document; what never
 * acknowledged is `late` at the timeout; a newer change makes the older one `superseded` with what it had.
 */
import { ERROR_BUDGET, TRANSITION, type DropReason, type ErrorFields, type ErrorSource, type ModeName, type RenderRow, type ThemeScope, type TransitionOutcome } from '../../shared/perf-records.ts'
import { formatConsole, periodMs, RESOURCE_TAGS, resourceOf, stackOfArgs, viteEcho } from '../frame-host/signals.js'
import { watchWindow } from './app-perf.ts'
import { onMotion } from './canvas/camera-broadcast.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { bootOf, iframeOf } from './canvas/frame-registry.ts'
import { currentCmd } from './commands.ts'
import { useComments } from './comments-store.ts'
import { useJamCapture } from './jam-capture.ts'
import { useJamQueue } from './jam-queue.ts'
import { useJamUi } from './jam-state.ts'
import { newId } from './recorder-core.ts'
import { hooked, perfSeams, type Answered } from './recorder-seams.ts'
import { addRow, createRate, foldRows, nodesIn, normRoute, p50, topWarnings } from './recorder-signals-core.ts'
import { useStore } from './store.ts'
import { isHideUI, onHideUI } from './Toolbar.tsx'

type State = ReturnType<typeof useStore.getState>

/** What recorder.ts takes from here, set beside `logError`: this module never imports recorder.ts. */
export interface SignalError { source: ErrorSource; frame?: string; component?: string; message: unknown; stack?: unknown; fields?: ErrorFields }
export const signalSink = {
  error: (_e: SignalError): void => {},
  dropped: (_reason: DropReason, _n: number): void => {},
}

let started = false
const now = () => performance.now()

// ---- transitions' rate (#57) -----------------------------------------------------------------------------------------

const rates = { theme: createRate(TRANSITION.perSecond), mode: createRate(TRANSITION.perSecond) }
/** A `theme` or `mode` record, at most 10 a second each; past that counted. */
function transitionRecord(kind: 'theme' | 'mode', body: Record<string, unknown>): void {
  if (!rates[kind]()) { signalSink.dropped(kind, 1); return }
  perfSeams.record(kind, body)
}

// ---- documents -------------------------------------------------------------------------------------------------------

/** The play stage's iframe, and the document it shows now (`__mvStage`). */
function liveStageBoot(): string | undefined {
  try {
    const f = document.querySelector<HTMLIFrameElement>('.sh-play-stage iframe')
    const b = (f?.contentWindow as { __mvStage?: { boot?: unknown } } | null | undefined)?.__mvStage?.boot
    return typeof b === 'string' ? b : undefined
  } catch { return undefined }
}
const liveFrame = (key: string, boot: unknown) => typeof boot === 'string' && !!boot && boot === bootOf(iframeOf(key))
/** The nodes the camera shows now (recorder.ts `cohortIn`) - none with no canvas. */
function shownNodes(s: State) {
  const v = canvasCtl.view()
  return v ? nodesIn(s.nodes, v) : []
}

// ---- R3: theme switches ----------------------------------------------------------------------------------------------

interface Switch {
  t: string; scope: ThemeScope; to: string; by?: string; at: number
  /** the displayed cohort: node keys, or the stage alone */
  cohort: Set<string>; stage: boolean
  acked: Set<string>; times: number[]
  timer?: ReturnType<typeof setTimeout>
}
let sw: Switch | null = null

const themeSize = (s: Switch) => (s.stage ? 1 : s.cohort.size)
function themeEnd(s: Switch, outcome: TransitionOutcome): void {
  clearTimeout(s.timer)
  if (sw === s) sw = null
  const frames = themeSize(s), applied = s.acked.size
  if (frames) watchWindow('theme', false)
  const ms = p50(s.times)
  transitionRecord('theme', {
    t: s.t, scope: s.scope, to: s.to, by: s.by, frames, applied,
    ...(ms !== undefined ? { p50Ms: Math.round(ms), maxMs: Math.round(Math.max(...s.times)) } : {}),
    ...(outcome === 'timeout' ? { late: frames - applied } : {}),
    outcome,
  })
}
/** #21-#23: a switch begins. A newer switch finishes the running one with what it had. */
function themeStart(scope: ThemeScope, to: string, cohort: Set<string>, stage: boolean): void {
  if (sw) themeEnd(sw, 'superseded')
  const s: Switch = { t: newId(), scope, to, by: currentCmd(), at: now(), cohort, stage, acked: new Set(), times: [] }
  // nothing displayed changes: nothing to wait for
  if (!themeSize(s)) { themeEnd(s, 'done'); return }
  sw = s
  watchWindow('theme', true)
  s.timer = setTimeout(hooked('theme', () => { if (sw === s) themeEnd(s, 'timeout') }), TRANSITION.timeoutMs)
}
function themeAck(key: string, data: Record<string, unknown>): void {
  const s = sw
  if (!s || data.t !== s.t || data.theme !== s.to || s.acked.has(key)) return
  s.acked.add(key)
  s.times.push(now() - s.at)
  if (s.acked.size >= themeSize(s)) themeEnd(s, 'done')
}

/** The nodes whose resolved theme this change moved. */
function themeMoved(s: State, prev: State): string[] {
  if (s.nodes === prev.nodes) return []
  let was: Map<string, State['nodes'][number]> | undefined
  const out: string[] = []
  s.nodes.forEach((n, i) => {
    let p: State['nodes'][number] | undefined = prev.nodes[i]
    if (p === n) return
    if (p?.key !== n.key) p = (was ??= new Map(prev.nodes.map((x) => [x.key, x]))).get(n.key)
    if (p && p.theme !== n.theme) out.push(n.key)
  })
  return out
}
/** A selection pin (`setSelectedTheme`): a moved node whose own pin is the theme it moved to. A manifest's new
 *  `meta.theme` moves only nodes with no pin; a view switch clears them all. */
function pinnedTo(s: State, moved: readonly string[]): string | undefined {
  for (const k of moved) {
    const n = s.nodes.find((x) => x.key === k)
    if (n?.themeUser && n.themeUser === n.theme) return n.theme
  }
  return undefined
}
/** The canvas's displayed cohort: on screen, its theme moved, a document there to answer - none under a covering play
 *  stage (#22: covered frames are not waited for). */
function themeCohort(s: State, moved: readonly string[]): Set<string> {
  if (s.play) return new Set()
  const m = new Set(moved)
  return new Set(shownNodes(s).filter((n) => m.has(n.key) && !n.missing && bootOf(iframeOf(n.key))).map((n) => n.key))
}
function onStoreTheme(s: State, prev: State): void {
  if (s.play && prev.play && s.play.theme !== prev.play.theme) {
    // Play's own switch changes nothing else; a new session is no switch (its board or its slides differ, PlayInner remounts)
    if (s.board === prev.board && !!s.play.slides === !!prev.play.slides) themeStart('play', s.play.theme, new Set(), true)
  }
  if (s.viewTheme !== prev.viewTheme) { themeStart('view', s.viewTheme, themeCohort(s, themeMoved(s, prev)), false); return }
  if (s.nodes === prev.nodes) return
  const moved = themeMoved(s, prev)
  if (!moved.length) return
  const to = pinnedTo(s, moved)
  if (to) themeStart('selection', to, themeCohort(s, moved), false)
}

// ---- R4: modes -------------------------------------------------------------------------------------------------------

/** How a mode's enter is shown: acknowledged by the displayed cohort (#26), the stage's first frame, or two frames. */
type Shown = 'cohort' | 'first-frame' | 'two-frames'
const SHOWN: Record<ModeName, Shown> = {
  laser: 'cohort', inspect: 'cohort', comments: 'cohort',
  play: 'first-frame', slides: 'first-frame',
  interact: 'two-frames', 'hide-ui': 'two-frames', immersive: 'two-frames', 'jam-session': 'two-frames', 'jam-capture': 'two-frames', 'jam-review': 'two-frames', 'jam-lane': 'two-frames',
}
/** The first frame of a stage is a cold boot: the command's own deadline (`play`, `slides`: 30 s), not a toggle's 5 s - a
 *  slow first frame is the answer that record exists for. */
const FIRST_FRAME_MS = 30_000

interface Enter {
  mode: ModeName; t: string; by?: string; at: number; shown: Shown
  cohort: Set<string>; stage: boolean; acked: Set<string>
  ended?: boolean; timer?: ReturnType<typeof setTimeout>
}
interface ModeOn { since: number; errors: number; enter?: Enter }
const modes = new Map<ModeName, ModeOn>()
/** The enter still waiting for its cohort: the `t` a laser or a pick message to a document carries */
let waiting: Enter | null = null

function enterEnd(e: Enter, outcome: TransitionOutcome): void {
  if (e.ended) return
  e.ended = true
  clearTimeout(e.timer)
  if (waiting === e) waiting = null
  const ms = Math.round(now() - e.at)
  const firstFrame = e.shown === 'first-frame'
  const frames = SHOWN[e.mode] === 'two-frames' ? undefined : firstFrame || e.stage ? 1 : e.cohort.size
  transitionRecord('mode', {
    mode: e.mode, phase: 'enter', t: e.t, by: e.by,
    ...(outcome === 'done' ? (firstFrame ? { firstFrameMs: ms } : { shownMs: ms }) : {}),
    frames, outcome,
  })
}
const twoFrames = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn))

function enter(mode: ModeName): void {
  const m: ModeOn = { since: now(), errors: 0 }
  modes.set(mode, m)
  const s = useStore.getState()
  let shown = SHOWN[mode], stage = false
  let cohort = new Set<string>()
  if (shown === 'cohort') {
    if (s.play) stage = true
    else {
      cohort = new Set(shownNodes(s).filter((n) => n.status === 'ready' && !n.missing && bootOf(iframeOf(n.key))).map((n) => n.key))
      if (!cohort.size) shown = 'two-frames'   // no frame to tell: the shell's own chrome is all that shows it
    }
  }
  const e: Enter = { mode, t: newId(), by: currentCmd(), at: now(), shown, cohort, stage, acked: new Set() }
  m.enter = e
  if (shown === 'cohort') {
    if (waiting) enterEnd(waiting, 'superseded')
    waiting = e
  }
  e.timer = setTimeout(hooked('mode', () => enterEnd(e, 'timeout')), shown === 'first-frame' ? FIRST_FRAME_MS : TRANSITION.timeoutMs)
  if (shown === 'two-frames') twoFrames(hooked('mode', () => enterEnd(e, 'done')))
}
function exit(mode: ModeName): void {
  const m = modes.get(mode)
  if (!m) return
  modes.delete(mode)
  if (m.enter && !m.enter.ended) enterEnd(m.enter, 'superseded')
  transitionRecord('mode', { mode, phase: 'exit', t: newId(), by: currentCmd(), heldMs: Math.round(now() - m.since), errors: m.errors })
}
/** One store's say on its modes: exits first, so a switch from one to another reads in order. */
function setModes(want: Partial<Record<ModeName, boolean>>): void {
  const names = Object.keys(want) as ModeName[]
  for (const k of names) if (!want[k] && modes.has(k)) exit(k)
  for (const k of names) if (want[k] && !modes.has(k)) enter(k)
}
/** An ack counts for the mode being entered only if it shows that mode: the frame applied what the shell asked. */
function ackShows(mode: ModeName, d: Record<string, unknown>): boolean {
  if (mode === 'comments') return d.pick === true
  if (mode === 'inspect') return d.laser === true && d.inspect === true
  return d.laser === true && d.inspect !== true
}
function modeAck(key: string, data: Record<string, unknown>): void {
  const e = waiting
  if (!e || data.t !== e.t || !ackShows(e.mode, data) || e.acked.has(key)) return
  e.acked.add(key)
  if (e.acked.size >= (e.stage ? 1 : e.cohort.size)) enterEnd(e, 'done')
}

const canvasModes = (s: State): Partial<Record<ModeName, boolean>> => ({
  laser: s.laser && !s.laserInspect,
  inspect: s.laser && s.laserInspect,
  interact: s.interact !== null,
  play: !!s.play && !s.play.slides,
  slides: !!s.play?.slides,
})
const reviewModes = () => {
  const j = useJamUi.getState()
  return { 'jam-review': j.panel?.kind === 'review', 'jam-lane': j.laneKeys }
}

/** #27: the modes on now, for an error (recorder.ts `logError`). */
export const modesOn = (): ModeName[] => [...modes.keys()]
/** #27: an error recorded with these modes on: each exit counts it. */
export function errorCounted(on: readonly ModeName[]): void {
  for (const k of on) { const m = modes.get(k); if (m) m.errors++ }
}

// ---- R5: the sources -------------------------------------------------------------------------------------------------

/** #33, in the shell: 5 a second each for console, api and resource, before anything is formatted. */
const { perSourcePerSecond } = ERROR_BUDGET.shell
const budgets = { console: createRate(perSourcePerSecond), api: createRate(perSourcePerSecond), resource: createRate(perSourcePerSecond) }
function takeSource(source: keyof typeof budgets): boolean {
  if (budgets[source]()) return true
  signalSink.dropped(source, 1)
  return false
}

const onConsole = hooked('console', (args: unknown[]) => {
  if (viteEcho(args) || !takeSource('console')) return
  signalSink.error({ source: 'console', message: formatConsole(args), stack: stackOfArgs(args) })
})
const onWarn = hooked('console', () => countWarning('shell', 1))
/** The shell's own console, wrapped once: the original runs first (#28). */
function wrapConsole(): void {
  const w = window as { __mvConsoleWrapped?: boolean }
  if (w.__mvConsoleWrapped) return
  w.__mvConsoleWrapped = true
  const error0 = console.error, warn0 = console.warn
  console.error = function (this: Console, ...args: unknown[]) { error0.apply(this, args); onConsole(args) }
  console.warn = function (this: Console, ...args: unknown[]) { warn0.apply(this, args); onWarn() }
}

/** #31: a failure mvFetch saw. A save's 409 is the save-conflict command's outcome; `perf/*` is the recorder's own; a
 *  request its caller aborted did not fail. */
const hasCookie = () => { try { return /(?:^|;\s*)mv_c=/.test(document.cookie) } catch { return true } }
let cookieSeen = hasCookie()
function onAnswered(a: Answered): void {
  if (/\/api\/perf\//.test(a.url)) return
  const { status } = a
  if (typeof status === 'number' && status !== 0 && status < 400) return
  if (status === 0 && a.init.signal?.aborted) return
  const route = normRoute(a.url), method = (a.init.method ?? 'GET').toUpperCase()
  if (status === 409 && method === 'PUT' && route === 'boards/:board') return
  // a fresh page's first asks, before its double-submit cookie exists: the refusal primes it and the caller asks again
  // (store.ts `syncWorking`); once the cookie has been seen, a 403 is a 403
  if (status === 403 && !cookieSeen) { cookieSeen = hasCookie(); if (method === 'GET') return }
  if (!takeSource('api')) return
  signalSink.error({ source: 'api', message: `${method} ${route} ${status}`, fields: { route, method, status, ms: Math.round(a.ms) } })
}

/** #29: the shell's `vite:error`; frames ignore the broadcast, so it is recorded once. The server makes `file`
 *  repo-relative (it knows the root). */
function onViteError(p: { err?: { message?: unknown; id?: unknown; plugin?: unknown; loc?: { file?: unknown } } }): void {
  const err = p?.err
  if (!err) return
  const raw = typeof err.loc?.file === 'string' ? err.loc.file : typeof err.id === 'string' ? err.id : undefined
  signalSink.error({
    source: 'vite', message: String(err.message ?? 'vite error'),
    fields: { ...(raw ? { file: raw.split('?')[0] } : {}), ...(typeof err.plugin === 'string' ? { plugin: err.plugin.slice(0, 64) } : {}) },
  })
}

/** #32: the shell's own elements. */
function onElementError(e: Event): void {
  if (!(e.target instanceof Element)) return
  const r = resourceOf(e.target)
  if (!r || !takeSource('resource')) return
  signalSink.error({ source: 'resource', message: `${r.tag} ${r.url}`, fields: { tag: r.tag as ErrorFields['tag'], url: r.url } })
}

// ---- R6, R5: the minute's rows ---------------------------------------------------------------------------------------

interface Minute { rows: Map<string, RenderRow>; warnings: Map<string, number>; timer?: ReturnType<typeof setTimeout> }
const minutes = new Map<number, Minute>()
/** Frames post their minute as it ends: the shell writes it a little after, with theirs in it. A later one writes a
 *  second record for that minute; readers sum them. */
const GRACE_MS = 2_000
const minuteOf = (ms: number) => { const p = periodMs(); return Math.floor(ms / p) * p }
function slot(minute: number): Minute {
  let m = minutes.get(minute)
  if (m) return m
  m = { rows: new Map(), warnings: new Map() }
  minutes.set(minute, m)
  m.timer = setTimeout(hooked('renders', () => writeMinute(minute)), Math.max(0, minute + periodMs() - Date.now()) + GRACE_MS)
  return m
}
function writeMinute(minute: number): void {
  const m = minutes.get(minute)
  if (!m) return
  clearTimeout(m.timer)
  minutes.delete(minute)
  if (m.rows.size) perfSeams.record('renders', { minute, rows: foldRows(m.rows.values()) })
  if (m.warnings.size) perfSeams.record('warnings', topWarnings(m.warnings))
}
function countWarning(node: string, n: number): void {
  const w = slot(minuteOf(Date.now())).warnings
  w.set(node, (w.get(node) ?? 0) + n)
}
/** a gesture runs now (the shell's own `inGesture`) */
let moving = false
/** The Profiler around the shell's root (shell/main.tsx). */
export const shellRendered = hooked('renders', (_id: string, _phase: string, actual: number) => {
  if (!started) return
  addRow(slot(minuteOf(Date.now())).rows, 'shell', undefined, { commits: 1, ms: actual, maxMs: actual, inGesture: moving ? 1 : 0 })
})
/** Another document's minute (`sh:renders`): its numbers are checked, its row added under who it is. */
function rowFrom(who: string, frame: string | undefined, d: Record<string, unknown>): void {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  if (typeof d.minute !== 'number' || !Number.isFinite(d.minute)) return
  addRow(slot(d.minute).rows, who, frame, { commits: num(d.commits), ms: num(d.ms), maxMs: num(d.maxMs), inGesture: num(d.inGesture) })
}

/** #36: the on-screen frames at a gesture's start hear its start and its end. */
let inGesture: string[] | null = null
function tellGesture(keys: readonly string[], on: boolean): void {
  for (const k of keys) { try { iframeOf(k)?.contentWindow?.postMessage({ type: 'sh:gesture', on }, location.origin) } catch { /* its document's timing */ } }
}
function onCanvasMotion(m: { camera: boolean; preset: boolean }): void {
  moving = m.camera || m.preset
  if (moving && !inGesture) { inGesture = shownNodes(useStore.getState()).map((n) => n.key); tellGesture(inGesture, true) }
  else if (!moving && inGesture) { tellGesture(inGesture, false); inGesture = null }
}

// ---- the messages ------------------------------------------------------------------------------------------------------

const FROM_FRAME_DROPS = ['console', 'resource'] as const
/** Which node a document was (its `sh:boot`): its last counts come with no source once it has gone, below. */
const bootNodes = new Map<string, string>()
function onFrameMessage(node: string, d: Record<string, unknown>): void {
  switch (d.type) {
    case 'sh:boot':
      if (typeof d.boot === 'string') {
        bootNodes.set(d.boot, node)
        if (bootNodes.size > 256) bootNodes.delete(bootNodes.keys().next().value!)
      }
      return
    case 'sh:theme-applied':
      if (sw && !sw.stage && sw.cohort.has(node) && liveFrame(node, d.boot)) themeAck(node, d)
      return
    case 'sh:mode-applied':
      if (waiting && !waiting.stage && waiting.cohort.has(node) && liveFrame(node, d.boot)) modeAck(node, d)
      return
    case 'sh:console':
      if (typeof d.message === 'string' && takeSource('console')) signalSink.error({ source: 'console', frame: typeof d.id === 'string' ? d.id : undefined, message: d.message, stack: d.stack })
      return
    case 'sh:resource-error':
      if (typeof d.url === 'string' && RESOURCE_TAGS.includes(String(d.tag)) && takeSource('resource')) {
        signalSink.error({ source: 'resource', frame: typeof d.id === 'string' ? d.id : undefined, message: `${String(d.tag)} ${d.url}`, fields: { tag: d.tag as ErrorFields['tag'], url: d.url } })
      }
      return
    case 'sh:dropped': {
      // a document since replaced says what it refused too (its final count, a frame reloaded mid-burst)
      const counts = d.counts as Record<string, unknown> | undefined
      for (const k of FROM_FRAME_DROPS) { const n = counts?.[k]; if (typeof n === 'number' && Number.isInteger(n) && n > 0) signalSink.dropped(k, n) }
      return
    }
    case 'sh:warnings':
      if (typeof d.n === 'number' && Number.isInteger(d.n) && d.n > 0) countWarning(node, d.n)
      return
    case 'sh:renders':
      rowFrom(node, typeof d.id === 'string' ? d.id : undefined, d)
      return
  }
}
function onStageMessage(d: Record<string, unknown>): void {
  switch (d.type) {
    case 'sh:theme-applied':
      if (sw?.stage && d.boot === liveStageBoot()) themeAck('stage', d)
      return
    case 'sh:mode-applied':
      if (waiting?.stage && d.boot === liveStageBoot()) modeAck('stage', d)
      return
    case 'sh:stage-shown':
      // #26: the first frame of the stage up now
      for (const k of ['play', 'slides'] as const) {
        const e = modes.get(k)?.enter
        if (e && !e.ended && d.boot === liveStageBoot()) enterEnd(e, 'done')
      }
      return
    case 'sh:renders':
      rowFrom('stage', undefined, d)
      return
  }
}

/** A document's last counts, posted at its `pagehide` (#33: a frame reloaded mid-burst): by the time they arrive it has
 *  gone, so the message has no source and App.tsx's registry knows nothing of it. Counts only, and only from this origin. */
function onGoneMessage(e: MessageEvent): void {
  if (e.source !== null || e.origin !== location.origin) return
  const d = e.data as Record<string, unknown> | null
  if (d?.type !== 'sh:dropped' && d?.type !== 'sh:warnings' && d?.type !== 'sh:renders') return
  if (d.id === 'stage') onStageMessage(d)
  else onFrameMessage(bootNodes.get(String(d.boot)) ?? 'others', d)
}

// ---- start -------------------------------------------------------------------------------------------------------------

/** recorder.ts `startRecorder`, at the full level: the watchers and listeners. */
export function startSignals(): void {
  if (started) return
  started = true

  // what is on already counts from here, with no enter record of its own
  const s0 = useStore.getState()
  const held = { ...canvasModes(s0), comments: useComments.getState().commentMode, 'hide-ui': isHideUI(), 'jam-session': !!useJamQueue.getState().session, 'jam-capture': !!useJamCapture.getState().current, ...reviewModes() }
  for (const k of Object.keys(held) as ModeName[]) if (held[k]) modes.set(k, { since: now(), errors: 0 })

  // #21, #26: the `t` a message to a document carries
  perfSeams.transition = (kind) => (kind === 'theme' ? sw?.t : waiting?.t)

  // the store's own turn: a theme or a mode change is seen before anything renders, so the effects that post it read `t`
  useStore.subscribe(hooked('theme', onStoreTheme))
  useStore.subscribe(hooked('mode', (s: State, prev: State) => {
    if (s.laser !== prev.laser || s.laserInspect !== prev.laserInspect || s.interact !== prev.interact || s.play !== prev.play) setModes(canvasModes(s))
  }))
  useComments.subscribe(hooked('mode', (s: { commentMode: boolean }, p: { commentMode: boolean }) => { if (s.commentMode !== p.commentMode) setModes({ comments: s.commentMode }) }))
  useJamQueue.subscribe(hooked('mode', (s: { session: unknown }, p: { session: unknown }) => { if (s.session !== p.session) setModes({ 'jam-session': !!s.session }) }))
  useJamCapture.subscribe(hooked('mode', (s: { current: string | null }, p: { current: string | null }) => { if (s.current !== p.current) setModes({ 'jam-capture': !!s.current }) }))
  useJamUi.subscribe(hooked('mode', () => setModes(reviewModes())))
  onHideUI(hooked('mode', () => setModes({ 'hide-ui': isHideUI() })))

  perfSeams.frameMessage.on(hooked(null, onFrameMessage))
  perfSeams.stageMessage.on(hooked(null, onStageMessage))
  addEventListener('message', hooked(null, onGoneMessage))
  perfSeams.answered.on(hooked(null, onAnswered))
  onMotion(hooked(null, onCanvasMotion))
  wrapConsole()
  addEventListener('error', hooked(null, onElementError), true)
  if (import.meta.hot) import.meta.hot.on('vite:error', hooked(null, onViteError))
  // before the page's last records go (recorder.ts `leave`, in the same event): capture runs first at the target
  addEventListener('pagehide', hooked('renders', () => { for (const m of [...minutes.keys()]) writeMinute(m) }), true)
}
