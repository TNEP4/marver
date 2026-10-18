/**
 * Captures in the shell (spec 27, Part 3): `S` starts one, `E` ends it - everything you say, write
 * and do while it is open is one timeline, on one clock.
 *
 * The frames record what happens inside them (frame-host/trail.js) and post it here; this module
 * owns everything else: the capture ids, the load-bound handshake per mounted instance (a frame can
 * show twice; a document replaced mid-capture never binds), canvas-mode clicks and hovers (the
 * shell's overlay keeps the click and asks the frame what is under it), the UI steps the shell
 * itself takes (select, device, theme, copy, interactive mode), notes, pictures - and the end: the
 * flush, the drain, the seal, and the post of the sealed record.
 *
 * A capture is recording, then draining, then sealed. With `S` -> `S` the next one records from the
 * same instant under its own id, so each message lands in the capture whose id it carries.
 */
import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { CONFIG, useStore, type Node } from './store.ts'
import type { Bundle, CaptureRecord, Step, View } from '../../server/jam/types.ts'

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const now = () => performance.timeOrigin + performance.now()
const rand = (n = 6) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0')
/** One recorder answers a flush within this; one that does not is noted in the record. */
const FLUSH_MS = 500
const PROBE_MS = 500
const PICTURE_MS = 5_000
const MAX_PICTURES = 12

// ---- mounted instances: one per canvas node, and the play stage ------------------------------------

interface Instance { key: string; iframe: HTMLIFrameElement; nonce?: string; doc?: Document | null; captureDoc?: string }
const instances = new Map<string, Instance>()
const post = (inst: Instance, msg: unknown) => { try { inst.iframe.contentWindow?.postMessage(msg, location.origin) } catch { /* gone */ } }
/** Is this message from the document the instance bound to? Checked on EVERY message: a document
 *  replaced since - even before its `load` fired - is dropped. */
const current = (inst: Instance) => !!inst.doc && inst.iframe.contentDocument === inst.doc

/** The instance's iframe fired `load` - a new document: nothing from it is accepted until it answers
 *  a hello carrying the nonce sent now, while that exact Document is still current. */
export function frameLoaded(key: string, iframe: HTMLIFrameElement | null) {
  if (!iframe) return
  const inst: Instance = { key, iframe, nonce: `n-${rand(10)}`, doc: iframe.contentDocument }
  instances.set(key, inst)
  post(inst, { type: 'sh:capture-hello', nonce: inst.nonce })
}
export function frameGone(key: string) { instances.delete(key) }

/** A frame (or the stage) became ready: tell it whether a capture records, and the keys owned now. */
export function frameReady(key: string) {
  const inst = instances.get(key)
  if (!inst) return
  const cur = useJamCapture.getState().current
  if (cur) post(inst, { type: 'sh:capture', id: cur, on: true })
  post(inst, { type: 'sh:keys', owned: ownedNow })
}

// ---- owned keys, mirrored into every frame ------------------------------------------------------------

let ownedNow: string[] = []
/** The keys the shell owns right now (`[Ctrl+][Meta+][Alt+][Shift+]key`), posted to every instance on
 *  change: a frame consumes them itself (before a focused button sees ⏎) and forwards them. */
export function setOwnedKeys(keys: string[]) {
  const next = [...new Set(keys)].sort()
  if (next.join() === ownedNow.join()) return
  ownedNow = next
  for (const inst of instances.values()) post(inst, { type: 'sh:keys', owned: ownedNow })
}

// ---- the captures -------------------------------------------------------------------------------------

export interface Point { n: number; key: string; x: number; y: number }   // a numbered point, in frame-local px
interface Cap {
  id: string
  state: 'recording' | 'draining'
  board: string
  t0: number
  steps: (Step & { seq?: number; src?: string })[]
  seen: Set<string>                        // `${instance}|${captureDoc}|${seq}` - dedupe
  points: Point[]
  pictures: string[]
  probes: number                           // probe answers still out
  shots: number                            // picture requests still out
  flushWait: Map<string, string>           // instance -> the captureDoc whose flush we wait for
  reviewing?: { card: string; batch: string; rev: number }
}

interface CaptureState {
  /** the capture recording now */
  current: string | null
  caps: Record<string, Cap>
  /** the notes card: open, and the text not yet added (kept until the capture ends) */
  noteOpen: boolean
  noteDraft: string
  /** a number that changes on every capture change - for components to redraw (timer, counts) */
  tick: number
  start(reviewing?: Cap['reviewing']): void
  end(next?: boolean): void
  drop(): void
  note(text: string): void
  setNoteOpen(open: boolean): void
  setNoteDraft(text: string): void
  picture(frame?: string): void
  /** the drafts sealed, in order - their read-backs open when capturing stops */
  sealed: { id: string; card?: { id: string; rev: number } }[]
}

const mutate = (fn: (s: CaptureState) => void) => useJamCapture.setState((s) => { fn(s); return { caps: { ...s.caps }, tick: s.tick + 1 } })
const capOf = (id: string): Cap | undefined => useJamCapture.getState().caps[id]

/** Add a step to a capture (in place; the timeline is sorted at the seal, by `at` then `seq`). */
function addStep(id: string, step: Step & { seq?: number; src?: string }) {
  mutate((s) => { const c = s.caps[id]; if (c) c.steps.push(step) })
}

const frameIdOf = (key: string): string | undefined => useStore.getState().nodes.find((n) => n.key === key)?.frame
const viewNow = (): View => {
  const s = useStore.getState()
  const sel = s.selection.map((k) => s.nodes.find((n) => n.key === k)).filter((n): n is Node => !!n)
  const shown = (sel.length ? sel : s.nodes.filter((n) => !n.missing)).slice(0, 20)
  const first = shown[0]
  return {
    board: s.board, frames: [...new Set(shown.map((n) => n.frame))], theme: first?.theme ?? s.viewTheme,
    ...(first ? { width: Math.round(first.w), height: Math.round(first.h) } : {}),
    zoom: Math.round((s.scale ?? 1) * 100) / 100, mode: s.play ? (s.play.slides ? 'slides' : 'play') : s.interact ? 'interact' : 'canvas',
  }
}

// ---- UI steps: the shell's own, written the moment they happen, only while recording ----------------

let unwatch: (() => void) | null = null
function watchUi() {
  unwatch?.()
  let prev = useStore.getState()
  unwatch = useStore.subscribe((s) => {
    const id = useJamCapture.getState().current
    const p = prev
    prev = s
    if (!id) return
    const at = now()
    if (s.selection.join() !== p.selection.join() && s.selection.length) {
      addStep(id, { at, event: 'select', frames: [...new Set(s.selection.map((k) => frameIdOf(k)).filter((f): f is string => !!f))] })
    }
    for (const n of s.nodes) {
      const o = p.nodes.find((x) => x.key === n.key)
      if (!o) continue
      // a device change: the node took a preset's size (its width names the viewport)
      if (o.w !== n.w && n.sizeMode === 'device') {
        const vp = Object.entries(CONFIG.viewports).find(([, v]) => v.width === Math.round(n.w))
        addStep(id, { at, frame: n.frame, event: 'device', viewport: vp?.[0] ?? 'custom', width: Math.round(n.w), height: Math.round(n.h) })
      }
      if (o.theme !== n.theme && s.viewTheme === p.viewTheme && (n.theme === 'light' || n.theme === 'dark')) addStep(id, { at, frame: n.frame, event: 'theme', theme: n.theme })
    }
    if (s.viewTheme !== p.viewTheme && (s.viewTheme === 'light' || s.viewTheme === 'dark')) addStep(id, { at, event: 'theme', theme: s.viewTheme })
    if (!!s.interact !== !!p.interact) addStep(id, { at, ...(s.interact || p.interact ? { frame: frameIdOf((s.interact ?? p.interact)!) } : {}), event: 'interact', on: !!s.interact })
  })
}

/** A copy happened (path or image, of which frame) - never what the clipboard holds. */
export function recordCopy(what: 'path' | 'image', frame: string) {
  const id = useJamCapture.getState().current
  if (id) addStep(id, { at: now(), frame, event: 'copied', what })
}

// ---- trail from the frames ---------------------------------------------------------------------------

/** A frame or the stage posted something about a capture. `key` is the instance it came from. Returns
 *  true when the message was a capture message (handled or dropped). */
export function onFrameMessage(key: string, data: Record<string, any>): boolean {
  const t = data.type
  if (t !== 'sh:capture-hello' && t !== 'sh:trail' && t !== 'sh:probe' && t !== 'sh:capture-flushed') return false
  const inst = instances.get(key)
  if (!inst || !current(inst)) return true
  if (t === 'sh:capture-hello') {
    if (inst.nonce && data.nonce === inst.nonce && typeof data.captureDoc === 'string') { inst.captureDoc = data.captureDoc; inst.nonce = undefined }
    return true
  }
  if (!inst.captureDoc || data.captureDoc !== inst.captureDoc) return true
  if (t === 'sh:probe') { probeAnswered(key, data); return true }
  const cap = typeof data.id === 'string' ? capOf(data.id) : undefined
  if (!cap) return true                                   // a capture neither recording nor draining
  if (t === 'sh:capture-flushed') {
    if (cap.flushWait.get(key) === data.captureDoc) { mutate((s) => { s.caps[cap.id]?.flushWait.delete(key) }); trySeal(cap.id) }
    return true
  }
  const dedupe = `${key}|${data.captureDoc}|${data.seq}`
  if (cap.seen.has(dedupe)) return true
  cap.seen.add(dedupe)
  const at = Number(data.at)
  if (!Number.isFinite(at)) return true
  const frame = typeof data.frame === 'string' ? data.frame : frameIdOf(key)
  const base = { at, seq: Number(data.seq) || 0, src: key, ...(frame ? { frame } : {}) }
  const mode = data.mode === 'play' ? 'play' : data.mode === 'canvas' ? 'canvas' : 'interact'
  switch (data.event) {
    case 'pick': case 'click': case 'hover': {
      const pt = data.point && Number.isFinite(data.point.x) ? { x: data.point.x, y: data.point.y } : null
      const n = data.event === 'hover' ? undefined : cap.points.length + 1
      mutate((s) => {
        const c = s.caps[cap.id]
        if (!c) return
        if (n && pt) c.points.push({ n, key, x: pt.x, y: pt.y })
        c.steps.push({ ...base, event: data.event, bundle: cleanBundle(data.bundle), mode, ...(n ? { point: n } : {}) })
      })
      if (data.event === 'pick' && frame) shoot(cap.id, frame, 'pick')
      return true
    }
    case 'field': addStep(cap.id, { ...base, event: 'field', bundle: cleanBundle(data.bundle), value: String(data.value ?? '') }); return true
    case 'screen': addStep(cap.id, { ...base, event: 'screen', to: String(data.to ?? '') }); return true
    case 'scroll': if (Number.isFinite(Number(data.y))) addStep(cap.id, { ...base, event: 'scroll', y: Number(data.y) }); return true
    default: return true
  }
}

/** A frame's bundle (`{ el: { semantics: { tag, quote, testId, ariaLabel, role }, cssPath, source } }`,
 *  safeBundle) as the record keeps it: flat, strings only - a masked one keeps its '•••'. */
const cleanBundle = (b: unknown): Bundle => {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, any>
  const el = (o.el && typeof o.el === 'object' ? o.el : o) as Record<string, any>
  const sem = (el.semantics && typeof el.semantics === 'object' ? el.semantics : el) as Record<string, unknown>
  const out: Bundle = {}
  for (const k of ['tag', 'quote', 'testId', 'ariaLabel', 'role'] as const) if (typeof sem[k] === 'string') out[k] = sem[k] as string
  for (const k of ['cssPath', 'source'] as const) if (typeof el[k] === 'string') out[k] = el[k] as string
  return out
}

// ---- canvas-mode clicks and hovers: the overlay keeps the click and asks the frame ------------------

const probes = new Map<string, { cap: string; key: string; at: number; event: 'click' | 'hover'; x: number; y: number; timer: ReturnType<typeof setTimeout> }>()

const local = (iframe: HTMLIFrameElement, clientX: number, clientY: number) => {
  const r = iframe.getBoundingClientRect()
  const sx = iframe.clientWidth ? r.width / iframe.clientWidth : 1
  const sy = iframe.clientHeight ? r.height / iframe.clientHeight : 1
  return { x: (clientX - r.left) / sx, y: (clientY - r.top) / sy }
}

function probe(key: string, event: 'click' | 'hover', clientX: number, clientY: number) {
  const id = useJamCapture.getState().current
  const inst = instances.get(key)
  if (!id || !inst || !current(inst)) return
  const at = now()
  const { x, y } = local(inst.iframe, clientX, clientY)
  const req = `r-${rand(8)}`
  const timer = setTimeout(() => {
    probes.delete(req)
    mutate((s) => { const c = s.caps[id]; if (c) { c.probes -= 1; c.steps.push({ at, frame: frameIdOf(key), event: 'missing', what: `the ${event} at ${Math.round(x)},${Math.round(y)} never answered` }) } })
    trySeal(id)
  }, PROBE_MS)
  probes.set(req, { cap: id, key, at, event, x, y, timer })
  mutate((s) => { const c = s.caps[id]; if (c) c.probes += 1 })
  post(inst, { type: 'sh:probe', id, req, x, y })
}

function probeAnswered(key: string, data: Record<string, any>) {
  const p = probes.get(String(data.req ?? ''))
  if (!p || p.key !== key) return
  probes.delete(String(data.req))
  clearTimeout(p.timer)
  const frame = frameIdOf(key)
  mutate((s) => {
    const c = s.caps[p.cap]
    if (!c) return
    c.probes -= 1
    if (!data.bundle) return
    const n = p.event === 'click' ? c.points.length + 1 : undefined
    if (n) c.points.push({ n, key, x: p.x, y: p.y })
    // one act, one line: a click that also selected its frame is one click that names the selection
    const last = c.steps[c.steps.length - 1]
    const selects = p.event === 'click' && !!last && last.event === 'select' && p.at - last.at < 400 && last.frames.length === 1 && last.frames[0] === frame
    if (selects) c.steps.pop()
    c.steps.push({ at: p.at, ...(frame ? { frame } : {}), event: p.event, bundle: cleanBundle(data.bundle), mode: 'canvas', ...(n ? { point: n } : {}), ...(selects ? { selects: true } : {}) })
  })
  trySeal(p.cap)
}

/** The canvas overlay saw a click (not a drag) on a node while a capture records. */
export function canvasClick(key: string, clientX: number, clientY: number) { probe(key, 'click', clientX, clientY) }

let dwell: { key: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
let lastHover = 0
/** The pointer moved over a node in canvas mode: a hold of 0.8 s without moving past 4 px is a hover
 *  (at most one every 2 s); moving or leaving cancels it. */
export function canvasPointer(key: string | null, clientX = 0, clientY = 0) {
  if (dwell && (!key || key !== dwell.key || Math.hypot(clientX - dwell.x, clientY - dwell.y) > 4)) { clearTimeout(dwell.timer); dwell = null }
  if (!key || dwell || !useJamCapture.getState().current) return
  dwell = { key, x: clientX, y: clientY, timer: setTimeout(() => {
    const d = dwell
    dwell = null
    if (!d || performance.now() - lastHover < 2_000) return
    lastHover = performance.now()
    probe(d.key, 'hover', d.x, d.y)
  }, 800) }
  pointerAt = { key, at: performance.now() }
}
/** the node under the pointer lately - where `I` shoots */
let pointerAt: { key: string; at: number } | null = null

// ---- pictures ------------------------------------------------------------------------------------------

function shoot(id: string, frame: string, why: 'key' | 'pick' | 'end') {
  const c = capOf(id)
  if (!c || c.pictures.length + c.shots >= MAX_PICTURES) return
  const at = now()
  const n = useStore.getState().nodes.find((x) => x.frame === frame)
  mutate((s) => { const x = s.caps[id]; if (x) x.shots += 1 })
  const done = (pid: string | null) => {
    mutate((s) => {
      const x = s.caps[id]
      if (!x) return
      x.shots -= 1
      if (pid) { x.pictures.push(pid); x.steps.push({ at, frame, event: 'picture', id: pid, why }) }
      else x.steps.push({ at, frame, event: 'missing', what: `a picture of ${frame}` })
    })
    trySeal(id)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PICTURE_MS)
  fetch(`${ROUTE}/api/jam/picture`, {
    method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
    body: JSON.stringify({ capture: id, frame, theme: n?.theme ?? useStore.getState().viewTheme }),
  }).then(async (r) => (r.ok ? ((await r.json()) as { id?: string }).id ?? null : null), () => null)
    .then((pid) => { clearTimeout(timer); done(pid) })
}

// ---- start, end, seal ----------------------------------------------------------------------------------

const broadcast = (msg: unknown) => { for (const inst of instances.values()) post(inst, msg) }

function begin(reviewing?: Cap['reviewing']) {
  const id = `cap-${Date.now()}-${rand(6)}`
  const s = useStore.getState()
  const cap: Cap = {
    id, state: 'recording', board: s.board, t0: now(), steps: [], seen: new Set(), points: [], pictures: [],
    probes: 0, shots: 0, flushWait: new Map(), ...(reviewing ? { reviewing } : {}),
  }
  cap.steps.push({ at: cap.t0, event: 'view', view: viewNow() })
  // starting with frames selected makes them its focus
  if (s.selection.length) cap.steps.push({ at: cap.t0, event: 'select', frames: [...new Set(s.selection.map((k) => frameIdOf(k)).filter((f): f is string => !!f))] })
  useJamCapture.setState((st) => ({ current: id, caps: { ...st.caps, [id]: cap }, tick: st.tick + 1 }))
  broadcast({ type: 'sh:capture', id, on: true })
  watchUi()
}

/** Stop recording `id`: flush every recorder that holds a captureDoc, wait for them, for every probe
 *  and picture still out, then seal. */
function drain(id: string) {
  const c = capOf(id)
  if (!c || c.state !== 'recording') return
  const s = useJamCapture.getState()
  // text written in the notes card and never added is the capture's last note
  const draft = s.noteDraft.trim()
  mutate((st) => {
    const x = st.caps[id]
    if (!x) return
    x.state = 'draining'
    if (draft) x.steps.push({ at: now(), event: 'note', text: draft })
    for (const inst of instances.values()) if (inst.captureDoc && current(inst)) x.flushWait.set(inst.key, inst.captureDoc)
  })
  useJamCapture.setState({ noteDraft: '', noteOpen: false })
  // the frames in view, shot at E
  for (const f of (viewNow().frames ?? []).slice(0, 3)) shoot(id, f, 'end')
  broadcast({ type: 'sh:capture', id, on: false })
  setTimeout(() => {
    mutate((st) => {
      const x = st.caps[id]
      if (!x || !x.flushWait.size) return
      for (const k of x.flushWait.keys()) x.steps.push({ at: now(), frame: frameIdOf(k), event: 'missing', what: 'a frame never flushed' })
      x.flushWait.clear()
    })
    trySeal(id)
  }, FLUSH_MS)
  trySeal(id)
}

function trySeal(id: string) {
  const c = capOf(id)
  if (!c || c.state !== 'draining' || c.flushWait.size || c.probes > 0 || c.shots > 0) return
  const timeline = [...c.steps].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0)).map(({ seq: _s, src: _k, ...step }) => step as Step)
  const record: CaptureRecord = {
    format: 'marver.jam.capture', v: 1, id,
    context: { canvas: location.host, board: c.board, ...(c.reviewing ? { reviewing: c.reviewing } : {}) },
    view: (timeline.find((x) => x.event === 'view') as Extract<Step, { event: 'view' }> | undefined)?.view ?? {},
    timeline, pictures: c.pictures,
  }
  // sealed: drop everything for this id that arrives later
  useJamCapture.setState((st) => { const caps = { ...st.caps }; delete caps[id]; return { caps, tick: st.tick + 1, sealed: [...st.sealed, { id }] } })
  fetch(`${ROUTE}/api/jam/capture`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ record }) })
    .then((r) => r.json()).then((r: { ok?: boolean; card?: { id: string; rev: number }; error?: string }) => {
      useJamCapture.setState((st) => ({ sealed: st.sealed.map((x) => (x.id === id ? { ...x, ...(r.card ? { card: r.card } : {}) } : x)) }))
      void import('./jam-queue.ts').then(({ useJamQueue }) => useJamQueue.getState().load())
      if (!r.ok) useStore.getState().toast(`the capture could not be kept: ${r.error ?? 'unknown error'}`)
    }, () => useStore.getState().toast('the capture could not be sent - is marver dev still running?'))
}

export const useJamCapture = create<CaptureState>((set, get) => ({
  current: null,
  caps: {},
  noteOpen: false,
  noteDraft: '',
  tick: 0,
  sealed: [],
  start(reviewing) {
    if (get().current) get().end(true)
    begin(reviewing)
  },
  end(next) {
    const id = get().current
    if (!id) return
    set({ current: null })
    drain(id)
    if (next) begin()
    else { unwatch?.(); unwatch = null }
  },
  drop() {
    const id = get().current
    if (!id) return
    broadcast({ type: 'sh:capture', id, on: false })
    set((s) => { const caps = { ...s.caps }; delete caps[id]; return { current: null, caps, noteOpen: false, noteDraft: '', tick: s.tick + 1 } })
    unwatch?.(); unwatch = null
  },
  note(text) {
    const id = get().current
    const t = text.trim()
    if (!id || !t) return
    addStep(id, { at: now(), event: 'note', text: t })
    set({ noteDraft: '' })
  },
  setNoteOpen(open) { set({ noteOpen: open && !!get().current }) },
  setNoteDraft(text) { set({ noteDraft: text }) },
  picture(frame) {
    const id = get().current
    if (!id) return
    const s = useStore.getState()
    const key = pointerAt && performance.now() - pointerAt.at < 5_000 ? pointerAt.key : s.selection[s.selection.length - 1]
    const f = frame ?? (key ? frameIdOf(key) : undefined)
    if (f) shoot(id, f, 'key')
  },
}))

/** What the capture tile shows: the timer and the counts. */
export function captureCounts(c: Cap | undefined, t = now()): { time: string; counts: string; notes: number } {
  if (!c) return { time: '0:00', counts: '', notes: 0 }
  const sec = Math.max(0, Math.floor((t - c.t0) / 1000))
  const steps = c.steps.filter((x) => ['select', 'device', 'theme', 'copied', 'interact'].includes(x.event)).length
  const frames = new Set(c.steps.flatMap((x) => (x.frame ? [x.frame] : []))).size
  const plural = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '')
  return {
    time: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`,
    counts: [plural(c.points.length, 'point'), plural(c.pictures.length, 'picture'), plural(frames, 'frame'), plural(steps, 'step')].filter(Boolean).join(' · '),
    notes: c.steps.filter((x) => x.event === 'note').length,
  }
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamCapture = useJamCapture
