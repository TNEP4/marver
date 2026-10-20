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
 * A capture is recording, then draining, then sealed. One records at a time: `S` while one records
 * starts nothing - it is ended (E) or dropped (Esc) first. Each message lands in the capture whose
 * id it carries.
 */
import { create } from 'zustand'
import { ROUTE, slideSize } from '../const.ts'
import { CONFIG, SLIDE_INTRINSIC, useStore, type Node } from './store.ts'
import { UNPLACED } from './hash.ts'
import type { Bundle, CaptureRecord, Step, View } from '../../server/jam/types.ts'
import { forgetHeard, RATE, setWordsListener, voiceBegin, voiceDrop, voiceEnd } from './jam-voice.ts'
import { touchedFrames } from '../../shared/capture-frames.ts'
import { onStageSize, stageSize } from './stage-size.ts'

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const now = () => performance.timeOrigin + performance.now()
const rand = (n = 6) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0')
/** One recorder answers a flush within this; one that does not is noted in the record. */
const FLUSH_MS = 500
const PROBE_MS = 500
/** A picture is a render on the server: two at once in a cold browser on a busy Mac (a model downloading,
 *  words being transcribed) took 5-6 s in a trial, so the page waits long enough not to throw a good one away. */
const PICTURE_MS = 20_000
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
  // a recorder installed after `load` (the stage mounts late) missed the hello: ask again, while the
  // Document the hello was bound to is still the one in the iframe
  if (inst.nonce && current(inst)) post(inst, { type: 'sh:capture-hello', nonce: inst.nonce })
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
  shotFrames: string[]                     // frames pictured (or being pictured) in it: an automatic picture is taken once per frame
  endShot?: boolean                        // its end pictures were asked for (once its steps were all in)
  inherited?: string[]                     // Resume: the frames the capture it continues was about (its card's)
  endSizes?: Record<string, { w: number; h: number; play?: true }>   // the sizes as they were at E (what it was about, then)
  endNodes?: { key: string; frame: string; w: number; h: number; visible: boolean }[]   // every instance at E (a step answering late is sized by these)
  sizes: Record<string, { w: number; h: number; play?: true }>   // each frame's size when it was last touched (`play`: on the stage's device)
  keys: Record<string, string>             // each frame's instance last touched (a frame can sit on a board twice)
  sizedAt: Record<string, number>          // when the touch that sized each frame happened (a late answer of an older one is ignored)
  hearing: boolean                         // its words are still coming (the microphone's `final` not in)
  flushWait: Map<string, string>           // instance -> the captureDoc whose flush we wait for
  reviewing?: { card: string; batch: string; rev: number }
  /** Resume: the draft this capture continues, and when recording resumed */
  resumes?: { id: string; at: number }
  /** the Jam session it was made in (Part 5) */
  session?: string
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
  /** Start one - never while one records (it says so instead) */
  /** `session`: the session it belongs to, when the caller knows it before the queue shows it (Start) */
  start(reviewing?: Cap['reviewing'], session?: string): void
  end(): void
  drop(): void
  note(text: string): void
  setNoteOpen(open: boolean): void
  setNoteDraft(text: string): void
  picture(frame?: string): void
  /** the drafts sealed, in order - their read-backs open when capturing stops */
  sealed: { id: string; card?: { id: string; rev: number } }[]
  /** sealed captures the server does not hold yet (kept, sent again until it takes them) */
  unsent: string[]
  /** Continue a draft that ended too soon: its record is loaded and recording goes on from where it
   *  stopped, under a new id that takes the draft's place when it seals. Dropping it leaves the draft. */
  resume(draft: string, ready?: () => Promise<boolean>): Promise<boolean>
  /** drafts being continued right now (recording, sealing or waiting to send) - the lane hides them */
  resuming: string[]
  /** the draft whose Resume is settling (its edits saving, its record loading): its read-back's words are
   *  locked meanwhile, so nothing typed can race the start - set by the caller (resumeDraft) before its
   *  first wait, cleared when the Resume is over */
  settling: string | null
  /** the capture ended last (E): its read-back is the one that opens, whatever seals first */
  lastEnded: string | null
}

const mutate = (fn: (s: CaptureState) => void) => useJamCapture.setState((s) => { fn(s); return { caps: { ...s.caps }, tick: s.tick + 1 } })
const capOf = (id: string): Cap | undefined => useJamCapture.getState().caps[id]

/** Add a step to a capture (in place; the timeline is sorted at the seal, by `at` then `seq`). */
function addStep(id: string, step: Step & { seq?: number; src?: string }, keys?: string[], auto = false) {
  mutate((s) => { const c = s.caps[id]; if (c) { c.steps.push(step); sample(c, step, keys, auto) } })
}
/** The stage laid out again (a resize, a device, Fill, a document's width): the frame on it, while a capture records,
 *  is measured as it is now - the last measurement before it leaves the stage is the one kept. */
if (typeof window !== 'undefined') onStageSize(() => {
  const id = useJamCapture.getState().current
  const st = useStore.getState()
  if (!id || !st.play || st.play.at !== stageSize.at) return
  mutate((s) => { const c = s.caps[id]; if (c && c.state === 'recording') c.sizes[stageSize.at] = { w: stageSize.w, h: stageSize.h, play: true } })
})
const sampleSize = sample   // (the watcher has a `sample` of its own)
/** Leaving play selects the frame it ended on: that selection is the shell's, not a touch (until then) */
let playLeftAt = 0
/** A frame's size on screen now: in play the stage's device, on the canvas its node (the one in view). */
function sizeNow(f: string, key?: string): { w: number; h: number; play?: true } | undefined {
  const st = useStore.getState()
  if (st.play) {
    if (st.play.at !== f) return undefined
    // the stage as play last laid it out (a document's reading width, a slide's stage, the window when it fills);
    // before play has laid this screen out, the same rules play follows: a slide's own stage, the window, the preset
    if (stageSize.at === f && stageSize.w > 0 && stageSize.h > 0) return { w: stageSize.w, h: stageSize.h, play: true }
    const entry = st.manifest?.frames.find((x) => x.id === f)
    const slide = (entry && slideSize(entry, CONFIG.viewports)) ?? (st.play.slides ? SLIDE_INTRINSIC : null)
    if (slide) return { w: Math.round(slide.width), h: Math.round(slide.height), play: true }
    if (st.play.device === 'fill') return { w: window.innerWidth, h: window.innerHeight, play: true }
    const v = CONFIG.viewports[st.play.device]
    return v ? { w: Math.round(v.width), h: Math.round(v.height), play: true } : undefined
  }
  // the instance touched first; else the one in view; else any
  const n = (key ? st.nodes.find((x) => x.key === key && x.frame === f) : undefined) ?? visibleNodes().find((x) => x.frame === f) ?? st.nodes.find((x) => x.frame === f)
  return n && n.w > 0 && n.h > 0 ? { w: Math.round(n.w), h: Math.round(n.h) } : undefined
}
/** A frame as it was at E (a capture finishing): its touched instance, else the one then in view, else any. */
function sizeAtEnd(c: Cap, f: string, key?: string): { w: number; h: number; play?: true } | undefined {
  const ns = (c.endNodes ?? []).filter((n) => n.frame === f)
  // a touch of a canvas instance (it names one): that instance as it was at E - over a size seen on the stage
  const touched = key ? ns.find((x) => x.key === key) : undefined
  if (touched && touched.w > 0 && touched.h > 0) return { w: touched.w, h: touched.h }
  if (c.sizes[f]?.play) return c.sizes[f]
  const n = ns.find((x) => x.key === c.keys[f]) ?? ns.find((x) => x.visible) ?? ns[0]
  return n && n.w > 0 && n.h > 0 ? { w: n.w, h: n.h } : undefined
}
/** Each frame a step touches, at the size it is as it is touched (a frame visited on a phone in play keeps the
 *  phone's size, wherever the capture ends). */
function sample(c: Cap, step: { at?: number; event: string; frame?: string; to?: string; frames?: string[]; src?: string; view?: { frames?: string[] } }, keys?: string[], auto = false) {
  const nodes = useStore.getState().nodes
  // (a view of one frame - the stage as play opens, a frame zoomed to - is a frame it is about)
  const viewed = step.event === 'view' && step.view?.frames?.length === 1 ? step.view.frames : []
  for (const f of [step.frame, step.to, ...(step.event === 'select' ? step.frames ?? [] : []), ...viewed]) {
    if (!f) continue
    // a touch older than the one that sized this frame (its answer came late) changes nothing
    if (step.at !== undefined && (c.sizedAt[f] ?? -Infinity) > step.at) continue
    // the instance it came from (a step's own frame document), or the selected one showing this frame
    const k = [step.src, ...(keys ?? [])].find((x) => x && nodes.some((n) => n.key === x && n.frame === f))
    if (k) c.keys[f] = k
    const z = c.state === 'draining' && c.endNodes ? sizeAtEnd(c, f, k) : sizeNow(f, c.keys[f])
    // a view (play left, a fit) is not a touch: what was seen on the stage keeps the stage's size until the frame is
    // used on the canvas
    if (z && !((auto || step.event === 'view') && c.sizes[f]?.play && !z.play)) {
      c.sizes[f] = z
      if (step.at !== undefined) c.sizedAt[f] = step.at
      // a step answering after E (a hover in flight) was a touch at E: the size kept for E follows the instance it
      // touched - for the seal and the end pictures alike
      if (c.state === 'draining' && c.endSizes && !auto && step.event !== 'view') c.endSizes[f] = z
    }
  }
}

const frameIdOf = (key: string): string | undefined => useStore.getState().nodes.find((n) => n.key === key)?.frame
/** The view: in play the stage; on the canvas the frames on screen - or, at the start only, the frames
 *  selected (a selection is the capture's focus, not what it keeps seeing). */
const viewNow = (focus = false): View => {
  const s = useStore.getState()
  // in play or slides the surface is the stage: its screen, its device, its theme
  if (s.play) {
    const vp = CONFIG.viewports[s.play.device]
    return { board: s.board, frames: [s.play.at], theme: s.play.theme, viewport: s.play.device, ...(vp ? { width: vp.width, height: vp.height } : {}), mode: s.play.slides ? 'slides' : 'play' }
  }
  const sel = s.selection.map((k) => s.nodes.find((n) => n.key === k)).filter((n): n is Node => !!n)
  const shown = focus && sel.length ? sel : visibleNodes()
  const first = shown[0]
  return {
    board: s.board, frames: [...new Set(shown.map((n) => n.frame))], theme: first?.theme ?? s.viewTheme,
    ...(first ? { width: Math.round(first.w), height: Math.round(first.h) } : {}),
    zoom: Math.round((s.scale ?? 1) * 100) / 100, mode: s.interact ? 'interact' : 'canvas',
  }
}

/** The nodes actually on screen now - the canvas's instances whose box meets the viewport, left of
 *  nothing that covers it (the panel and the lane leave their own room). */
export function visibleNodes(): Node[] {
  const s = useStore.getState()
  const W = window.innerWidth, H = window.innerHeight
  const out: Node[] = []
  for (const n of s.nodes) {
    if (n.missing) continue
    const el = document.querySelector(`.sh-node[data-node="${CSS.escape(n.key)}"]`)
    const r = el?.getBoundingClientRect()
    if (r && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H) out.push(n)
  }
  return out.slice(0, 20)
}

// ---- UI steps: the shell's own, written the moment they happen, only while recording ----------------

let unwatch: (() => void) | null = null
function watchUi() {
  unwatch?.()
  // the frames in view, once the camera has settled (two looks a beat apart agree): a pan to another
  // frame, described without a click, still names it
  const sig = () => { const v = viewNow(); return `${(v.frames ?? []).join()}@${Math.round((v.zoom ?? 1) * 20) / 20}` }   // frames and zoom
  let lastView = sig()
  let sample = lastView
  const settle = setInterval(() => {
    const id = useJamCapture.getState().current
    if (!id || useStore.getState().play) return
    const now_ = sig()
    if (now_ === sample && now_ !== lastView) { lastView = now_; addStep(id, { at: now(), event: 'view', view: viewNow() }) }
    sample = now_
  }, 600)
  let prev = useStore.getState()
  const unsub = useStore.subscribe((s) => {
    const id = useJamCapture.getState().current
    const p = prev
    prev = s
    if (!id) return
    const at = now()
    if (p.play && !s.play) playLeftAt = performance.now()
    if (s.selection.join() !== p.selection.join() && s.selection.length) {
      addStep(id, { at, event: 'select', frames: [...new Set(s.selection.map((k) => frameIdOf(k)).filter((f): f is string => !!f))] }, s.selection, performance.now() - playLeftAt < 200)
    }
    for (const n of s.nodes) {
      const o = p.nodes.find((x) => x.key === n.key)
      if (!o) continue
      // a device change: the node took a preset's size (its width names the viewport)
      if (o.w !== n.w && n.sizeMode === 'device') {
        const vp = Object.entries(CONFIG.viewports).find(([, v]) => v.width === Math.round(n.w))
        addStep(id, { at, frame: n.frame, event: 'device', viewport: vp?.[0] ?? 'custom', width: Math.round(n.w), height: Math.round(n.h), src: n.key })
      } else if ((Math.round(o.w) !== Math.round(n.w) || Math.round(o.h) !== Math.round(n.h)) && n.sizeMode !== 'device' && s.resized !== p.resized && s.resized?.key === n.key) {
        // (a person resized it - never a measurement: only a resize sets `resized`)
        // dragged to a size of its own: a step like a device, and the size it is about now - one step per drag (a
        // drag moves it on every frame: the last step of it, still going, takes the new size)
        const lastSteps = capOf(id)?.steps ?? []
        const last = lastSteps[lastSteps.length - 1] as (Step & { src?: string }) | undefined
        if (last && last.event === 'device' && last.src === n.key && last.viewport === 'custom' && at - last.at < 1500) {
          mutate((st) => { const c = st.caps[id]; const l = c?.steps[c.steps.length - 1] as (Step & { src?: string; width?: number; height?: number }) | undefined; if (c && l) { l.width = Math.round(n.w); l.height = Math.round(n.h); l.at = at; sampleSize(c, l) } })
        } else addStep(id, { at, frame: n.frame, event: 'device', viewport: 'custom', width: Math.round(n.w), height: Math.round(n.h), src: n.key })
      }
      if (o.theme !== n.theme && s.viewTheme === p.viewTheme && (n.theme === 'light' || n.theme === 'dark')) addStep(id, { at, frame: n.frame, event: 'theme', theme: n.theme, src: n.key })
    }
    if (s.viewTheme !== p.viewTheme && (s.viewTheme === 'light' || s.viewTheme === 'dark')) addStep(id, { at, event: 'theme', theme: s.viewTheme })
    // play: the stage's device and theme through the shell's controls (its screen comes from the stage)
    if (s.play && p.play) {
      if (s.play.theme !== p.play.theme && (s.play.theme === 'light' || s.play.theme === 'dark')) addStep(id, { at, frame: s.play.at, event: 'theme', theme: s.play.theme })
      if (s.play.device !== p.play.device) { const vp = CONFIG.viewports[s.play.device]; addStep(id, { at, frame: s.play.at, event: 'device', viewport: s.play.device, width: vp?.width ?? 0, height: vp?.height ?? 0 }) }
    }
    // a screen change the SHELL made (arrows, the walker, a variant): the stage reports its own
    // navigation itself, so a change it reported (sh:stage-at) is not recorded twice
    if (s.play && p.play && s.play.at !== p.play.at) {
      if (stageNav !== s.play.at) screenStep(id, at, s.play.at)
    }
    if (!!s.play !== !!p.play) addStep(id, { at, event: 'view', view: viewNow() })
    if (!!s.interact !== !!p.interact) addStep(id, { at, ...(s.interact || p.interact ? { frame: frameIdOf((s.interact ?? p.interact)!), src: (s.interact ?? p.interact)! } : {}), event: 'interact', on: !!s.interact })
  })
  unwatch = () => { unsub(); clearInterval(settle) }
}

/** Words heard for a capture (recording or still draining): one `words` step per phrase, at its first
 *  word, each word with its time on the capture's clock (sample 0 = the capture's start). */
setWordsListener((capture, words) => {
  const c = capOf(capture)
  if (!c || !words.length) return
  const ms = (sample: number) => c.t0 + (sample / RATE) * 1000
  addStep(capture, { at: ms(words[0].at), event: 'words', text: words.map((w) => w.w).join(' '), words: words.map((w) => ({ w: w.w, at: ms(w.at) })) })
})

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
    if (inst.nonce && data.nonce === inst.nonce && typeof data.captureDoc === 'string') {
      inst.captureDoc = data.captureDoc; inst.nonce = undefined
      // bound: tell this document what it may have missed (a frame can be ready before its load fires)
      frameReady(key)
    }
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
        c.steps.push({ ...base, event: data.event, bundle: cleanBundle(data.bundle), mode, ...(n ? { point: n } : {}) }); sample(c, { at: base.at, event: data.event, frame: base.frame, src: key })
      })
      if (data.event === 'pick' && frame) shoot(cap.id, frame, 'pick', key === 'stage' ? undefined : key)
      return true
    }
    case 'field': addStep(cap.id, { ...base, event: 'field', bundle: cleanBundle(data.bundle), value: String(data.value ?? '') }); return true
    case 'screen': screenStep(cap.id, at, String(data.to ?? ''), base.seq); return true
    case 'scroll': if (Number.isFinite(Number(data.y))) addStep(cap.id, { ...base, event: 'scroll', y: Number(data.y) }); return true
    default: return true
  }
}

/** A frame's bundle (`{ el: { semantics: { tag, quote, testId, ariaLabel, role }, cssPath, source } }`,
 *  safeBundle) as the record keeps it: flat, strings only - a masked one keeps its '•••'. */
/** One screen change - each navigation once, by whoever made it (revisits are their own lines). */
function screenStep(id: string, at: number, to: string, seq?: number) {
  if (!capOf(id) || !to) return
  addStep(id, { at, frame: to, event: 'screen', to, ...(seq !== undefined ? { seq } : {}) })
}
/** The stage moved itself to `at` (sh:stage-at): its recorder has the step; the shell's play state
 *  follows without a second line. */
let stageNav: string | null = null
/** Run the play-state update the stage's own navigation causes: during it (and only during it) the
 *  shell does not record a second line. */
export function stageNavigated(at: string, update: () => void) { stageNav = at; try { update() } finally { stageNav = null } }

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

const probes = new Map<string, { cap: string; key: string; at: number; event: 'click' | 'hover'; x: number; y: number; timer: ReturnType<typeof setTimeout>; selectStep?: Step }>()

const local = (iframe: HTMLIFrameElement, clientX: number, clientY: number) => {
  const r = iframe.getBoundingClientRect()
  const sx = iframe.clientWidth ? r.width / iframe.clientWidth : 1
  const sy = iframe.clientHeight ? r.height / iframe.clientHeight : 1
  return { x: (clientX - r.left) / sx, y: (clientY - r.top) / sy }
}

function probe(key: string, event: 'click' | 'hover', clientX: number, clientY: number, pressAt?: number) {
  const id = useJamCapture.getState().current
  const inst = instances.get(key)
  if (!id || !inst || !current(inst)) return
  const at = now()
  const { x, y } = local(inst.iframe, clientX, clientY)
  const req = `r-${rand(8)}`
  // one act, one line: the select this very click made (the overlay selects on pointerdown) is folded
  // into it when it answers - found now, by reference, whatever lands in the timeline meanwhile
  const frameNow = frameIdOf(key)
  const capNow = capOf(id)
  // the select made between this press and its release (the overlay selects on pointerdown) - however
  // long the press; a selection made before the press is its own line
  const selectStep = event === 'click' && capNow && pressAt !== undefined ? [...capNow.steps].reverse().find((x) => x.event === 'select' && x.at >= pressAt - 5 && x.at <= at && x.frames.length === 1 && x.frames[0] === frameNow) : undefined
  const timer = setTimeout(() => {
    probes.delete(req)
    mutate((s) => { const c = s.caps[id]; if (c) { c.probes -= 1; c.steps.push({ at, frame: frameIdOf(key), event: 'missing', what: `the ${event} at ${Math.round(x)},${Math.round(y)} never answered` }) } })
    trySeal(id)
  }, PROBE_MS)
  probes.set(req, { cap: id, key, at, event, x, y, timer, selectStep })
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
    const i = p.selectStep ? c.steps.indexOf(p.selectStep as (typeof c.steps)[number]) : -1
    const selects = i >= 0
    if (selects) c.steps.splice(i, 1)
    c.steps.push({ at: p.at, ...(frame ? { frame } : {}), event: p.event, bundle: cleanBundle(data.bundle), mode: 'canvas', ...(n ? { point: n } : {}), ...(selects ? { selects: true } : {}) }); sample(c, { at: p.at, event: p.event, frame, src: key })
  })
  trySeal(p.cap)
  // a click on a field: you mean to type there - the frame turns interactive and the caret goes in the
  // field, so the letters you type are the field's and never end, restart or drop the capture
  if (p.event === 'click' && data.field === true && useJamCapture.getState().current === p.cap) focusField(p.key, p.x, p.y)
}

function focusField(key: string, x: number, y: number) {
  const st = useStore.getState()
  if (st.play || !st.nodes.some((n) => n.key === key)) return
  if (st.interact !== key) st.setInteract(key)
  // after the overlay has stepped aside (interact removes it): focus the iframe, then the field in it
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const inst = instances.get(key)
    if (!inst || !current(inst)) return
    try { inst.iframe.focus() } catch { /* gone */ }
    post(inst, { type: 'sh:focus-at', x, y })
  }))
}

/** The canvas overlay saw a click (not a drag) on a node while a capture records. */
export function canvasClick(key: string, clientX: number, clientY: number, pressAt?: number) { cancelDwell(); probe(key, 'click', clientX, clientY, pressAt) }
/** When the press began, on the capture clock - the overlay calls this on pointerdown. */
export const pressNow = (): number => now()

let dwell: { key: string; cap: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
/** A capture ending (or dropped) takes its pending hover with it: a dwell belongs to one capture. */
const cancelDwell = () => { if (dwell) { clearTimeout(dwell.timer); dwell = null } }
let lastHover = 0
/** The pointer moved over a node in canvas mode: a hold of 0.8 s without moving past 4 px is a hover
 *  (at most one every 2 s); moving or leaving cancels it. */
export function canvasPointer(key: string | null, clientX = 0, clientY = 0) {
  if (dwell && (!key || key !== dwell.key || Math.hypot(clientX - dwell.x, clientY - dwell.y) > 4)) { clearTimeout(dwell.timer); dwell = null }
  const cur = useJamCapture.getState().current
  if (!key || dwell || !cur) return
  dwell = { key, cap: cur, x: clientX, y: clientY, timer: setTimeout(() => {
    const d = dwell
    dwell = null
    if (!d || d.cap !== useJamCapture.getState().current || performance.now() - lastHover < 2_000) return
    lastHover = performance.now()
    probe(d.key, 'hover', d.x, d.y)
  }, 800) }
  pointerAt = { key, at: performance.now() }
}
/** the node under the pointer lately - where `I` shoots */
let pointerAt: { key: string; at: number } | null = null

// ---- pictures ------------------------------------------------------------------------------------------

function shoot(id: string, frame: string, why: 'key' | 'pick' | 'end', key?: string) {
  const c = capOf(id)
  if (!c || c.pictures.length + c.shots >= MAX_PICTURES) return
  // each picture is a render on the server, and the capture waits for it as it ends: a point or the end
  // pictures a frame once - only I asks for another
  if (why !== 'key' && c.shotFrames.includes(frame)) return
  // the instance pictured is the one this frame is about (its size for the run's pictures)
  // (an I picture is a touch at this instant: a hover from before it, answering late, never overrides it)
  const touchAt = now()
  mutate((s) => { const x = s.caps[id]; if (x) { if (!x.shotFrames.includes(frame)) x.shotFrames.push(frame); if (why === 'key') sample(x, { at: touchAt, event: 'picture', frame, src: key }) } })
  const at = now()
  // the instance it was seen in: its size (a responsive defect is shot as seen) and its theme
  const st = useStore.getState()
  const n = (key ? st.nodes.find((x) => x.key === key && x.frame === frame) : undefined) ?? st.nodes.find((x) => x.frame === frame)
  // as it was seen: on the stage's device now, or as it was on the stage (left play since), or its node
  const seen = c.sizes[frame]
  // after E: as the frame was at E (a resize while it finishes is not part of it); else as it is seen now
  const atEnd = c.state === 'draining' ? c.endSizes?.[frame] ?? (c.endNodes ? sizeAtEnd(c, frame) : undefined) ?? seen : undefined
  const onStage = st.play && st.play.at === frame ? sizeNow(frame) : undefined
  const size = atEnd ? { width: atEnd.w, height: atEnd.h } : onStage ? { width: onStage.w, height: onStage.h } : seen?.play && why !== 'key' ? { width: seen.w, height: seen.h } : n ? { width: n.w, height: n.h } : undefined
  const theme = st.play && st.play.at === frame ? st.play.theme : n?.theme ?? st.viewTheme
  mutate((s) => { const x = s.caps[id]; if (x) x.shots += 1 })
  const done = (pid: string | null, late: boolean) => {
    mutate((s) => {
      const x = s.caps[id]
      if (!x) return
      x.shots -= 1
      if (pid) { x.pictures.push(pid); x.steps.push({ at, frame, event: 'picture', id: pid, why }) }
      else x.steps.push({ at, frame, event: 'missing', what: `no picture of ${frame} - ${late ? `it took over ${PICTURE_MS / 1000} s` : 'the render failed'}` })
    })
    trySeal(id)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PICTURE_MS)
  // settled exactly once - a picture, or a missing one - whatever fails: the request, its body, the abort
  let settled = false
  const finish = (pid: string | null) => { if (settled) return; settled = true; clearTimeout(timer); done(pid, ctl.signal.aborted) }
  fetch(`${ROUTE}/api/jam/picture`, {
    method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
    body: JSON.stringify({ capture: id, frame, theme, ...(size ? { w: Math.round(size.width), h: Math.round(size.height) } : {}) }),
  }).then(async (r) => (r.ok ? ((await r.json()) as { id?: string }).id ?? null : null))
    .catch(() => null)
    .then((pid) => finish(typeof pid === 'string' ? pid : null))
}

// ---- start, end, seal ----------------------------------------------------------------------------------

const broadcast = (msg: unknown) => { for (const inst of instances.values()) post(inst, msg) }

/** The session is being wrapped up (its talk flushing, its record being written): no capture starts. */
let sessionEnding = false
export const setSessionEnding = (on: boolean) => { sessionEnding = on }

/** A capture of a session tells the server it is open - recording, sealing, waiting to send - and renews
 *  that every 20 s until it lands or is dropped: the session's record waits for it, whatever tab ends it. */
const openOnServer = new Map<string, { session: string; timer: ReturnType<typeof setInterval> }>()
const tellOpen = (capture: string, session: string, on: boolean) => {
  void fetch(`${ROUTE}/api/jam/capture-open`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ capture, session, on }) })
    .then(async (r) => { if (on && r.status === 409 && (await r.json().catch(() => null))?.ended) leftOutOfSession(capture) }, () => {})
}
/** The server had already written the session's record (in another tab) when it heard of this capture: it is
 *  not in that record - it goes on as a capture of its own, and you are told. */
const toldOutside = new Set<string>()
function leftOutOfSession(capture: string) {
  // said once, whichever answer says it first (the registration's, or the upload's) - whatever order they come in
  if (toldOutside.has(capture)) return
  toldOutside.add(capture)
  releaseOpen(capture, false)
  useJamCapture.setState((st) => {
    const c = st.caps[capture]
    if (!c?.session) return {}
    const { session: _gone, ...rest } = c
    return { caps: { ...st.caps, [capture]: rest as Cap } }
  })
  useStore.getState().toast('the session ended in another tab - this capture is on its own, not in its record')
}
function holdOpen(capture: string, session: string) {
  tellOpen(capture, session, true)
  const timer = setInterval(() => {
    const st = useJamCapture.getState()
    if (st.current === capture || st.caps[capture] || st.unsent.includes(capture) || pendingUploads.has(capture)) tellOpen(capture, session, true)
    else releaseOpen(capture, false)
  }, 20_000)
  openOnServer.set(capture, { session, timer })
}
/** Stop renewing (it landed - the server knows - or it was dropped: say so). */
function releaseOpen(capture: string, tell: boolean) {
  const o = openOnServer.get(capture)
  if (!o) return
  clearInterval(o.timer)
  openOnServer.delete(capture)
  if (tell) tellOpen(capture, o.session, false)
}

/** The session running now (the queue view holds it), if any. */
let sessionNow: () => string | undefined = () => undefined
/** A card's frames as the server holds them (a resumed capture counts the ones it carries on). */
let cardFrames: (id: string) => string[] = () => []
void import('./jam-queue.ts').then(({ useJamQueue }) => {
  sessionNow = () => useJamQueue.getState().session?.id
  cardFrames = (id) => useJamQueue.getState().cards?.find((c) => c.id === id)?.frames ?? []
})

function begin(reviewing?: Cap['reviewing'], from?: CaptureRecord, session = sessionNow()): boolean {
  const s = useStore.getState()
  // checked here, as recording starts: a Resume that began loading before the session's wrap-up never
  // starts recording into it
  if (sessionEnding) { s.toast('the session is being wrapped up - a moment'); return false }
  // a capture becomes a thread on a board: the Not on a board view takes none (as it takes no comment)
  if (s.board === UNPLACED) { s.toast('captures need a board - open one first'); return false }
  const id = `cap-${Date.now()}-${rand(6)}`
  const t = now()
  // Resume: the draft's steps, moved up so its last step meets this instant (the pause between the two
  // is not part of the capture), its pictures and its numbered points; then recording goes on
  // (to just before this instant: everything carried over is strictly before `resumes.at`, the new part after)
  // (the latest instant in it: a step's, or a word's inside the last phrase - every carried word stays
  // before the resume)
  const latest = from ? Math.max(...from.timeline.flatMap((x) => [x.at, ...(x.event === 'words' && x.words ? x.words.map((w) => w.at) : [])]), -Infinity) : 0
  const shift = from && Number.isFinite(latest) ? t - 1 - latest : 0
  // (a phrase's words move with it - each word keeps its place in the phrase)
  const steps = from ? from.timeline.map((x) => ({ ...x, at: x.at + shift, ...(x.event === 'words' && x.words ? { words: x.words.map((w) => ({ ...w, at: w.at + shift })) } : {}) }) as Step) : []
  const cap: Cap = {
    id, state: 'recording', board: s.board, t0: from ? (steps[0]?.at ?? t) : t, steps, seen: new Set(),
    points: steps.flatMap((x) => ('point' in x && typeof x.point === 'number' ? [{ n: x.point, key: '', x: 0, y: 0 }] : [])), pictures: from ? [...from.pictures] : [],
    sizes: { ...(from?.sizes ?? {}) }, keys: {}, sizedAt: {},
    probes: 0, shots: 0, shotFrames: steps.flatMap((x) => (x.event === 'picture' && x.frame ? [x.frame] : [])), hearing: false, flushWait: new Map(), ...(reviewing ? { reviewing } : {}), ...(from ? { resumes: { id: from.id, at: t }, inherited: cardFrames(from.id) } : {}),
    ...(session ? { session } : {}),
  }
  // what is on screen and selected as it starts - a resumed one too, just after the resume (you may have
  // moved to another frame in the pause: the record names it)
  const at0 = from ? t + 1 : cap.t0
  cap.steps.push({ at: at0, event: 'view', view: viewNow(true) })
  // starting with frames selected makes them its focus (on the canvas - in play the stage is the surface)
  if (!s.play && s.selection.length) cap.steps.push({ at: at0, event: 'select', frames: [...new Set(s.selection.map((k) => frameIdOf(k)).filter((f): f is string => !!f))] })
  // the sizes it starts with: the stage's device in play, the selected frames on the canvas
  if (s.play) { const z = sizeNow(s.play.at); if (z) cap.sizes[s.play.at] = z } else if (s.selection.length) sample(cap, cap.steps[cap.steps.length - 1] as { event: string; frames?: string[] }, s.selection)
  useJamCapture.setState((st) => ({ current: id, caps: { ...st.caps, [id]: cap }, tick: st.tick + 1, ...(from ? { resuming: [...st.resuming, from.id] } : {}) }))
  if (cap.session) holdOpen(id, cap.session)
  broadcast({ type: 'sh:capture', id, on: true })
  watchUi()
  void voiceBegin(id, cap.t0)   // your words, if you said yes to the microphone (spec 27 Part 4)
  return true
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
    // its frames' sizes as they are at E - a resize while it finishes is not part of it; and every instance as it
    // is at E, for a step that answers late (a hover still in flight names a frame then)
    x.endSizes = framesSizes(x)
    const vis = new Set(visibleNodes().map((n) => n.key))
    x.endNodes = useStore.getState().nodes.map((n) => ({ key: n.key, frame: n.frame, w: Math.round(n.w), h: Math.round(n.h), visible: vis.has(n.key) }))
    if (draft) x.steps.push({ at: now(), event: 'note', text: draft })
    for (const inst of instances.values()) if (inst.captureDoc && current(inst)) x.flushWait.set(inst.key, inst.captureDoc)
  })
  useJamCapture.setState({ noteDraft: '', noteOpen: false })
  // in play the stage is what it is about: pictured now. On the canvas the end pictures wait until every frame
  // has flushed and every probe answered (trySeal) - a hover still in flight may name the frame to picture
  const st = useStore.getState()
  if (st.play) { mutate((s) => { const x = s.caps[id]; if (x) x.endShot = true }); shoot(id, st.play.at, 'end') }
  broadcast({ type: 'sh:capture', id, on: false })
  // the audio is cut at the key press, then its last words are awaited (3 s at most)
  mutate((st) => { const x = st.caps[id]; if (x) x.hearing = true })
  void voiceEnd(id).then((complete) => {
    mutate((st) => {
      const x = st.caps[id]
      if (!x) return
      x.hearing = false
      if (!complete) x.steps.push({ at: now(), event: 'missing', what: 'words may be incomplete' })
    })
    trySeal(id)
  })
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

/** The end pictures, once the timeline is whole: the frames it is about not pictured in it yet, three at most -
 *  each as the instance on screen shows it (a narrow, dark second copy as itself); never every frame that
 *  happens to be in view. None touched: the one frame it began on. Returns whether any was asked for. */
function endPictures(id: string): boolean {
  const c = capOf(id)
  if (!c || c.endShot) return false
  mutate((s) => { const x = s.caps[id]; if (x) x.endShot = true })
  const onScreen = visibleNodes()
  // resumed: the new part's frames (what the part before was about was pictured then - its pictures are carried);
  // none touched in a fresh capture: the one frame it began on
  const since = c.resumes?.at
  const touched = touchedFrames(since === undefined ? c.steps : c.steps.filter((x) => x.at >= since), undefined, false)
  const frames = (touched.length || since !== undefined ? touched : touchedFrames(c.steps).slice(0, 1)).filter((f) => !c.shotFrames.includes(f)).slice(0, 3)
  // each as the instance it was touched on (else the one in view)
  for (const f of frames) shoot(id, f, 'end', c.keys[f] ?? onScreen.find((n) => n.frame === f)?.key)
  return frames.length > 0
}

/** Each frame the capture is about, at the size it is on screen now (the instance in view, else any): a device,
 *  or a width you dragged it to. In play, the stage's device. Its run is pictured at these sizes. */
function framesSizes(c: Cap): Record<string, { w: number; h: number; play?: true }> {
  const st = useStore.getState()
  const onScreen = visibleNodes()
  const frames = new Set([...(c.inherited ?? []), ...touchedFrames(c.steps, undefined, true, c.resumes?.at)])
  const out: Record<string, { w: number; h: number; play?: true }> = {}
  for (const f of frames) {
    // seen in play: as it was on the stage's device; on the canvas: as its node is now (a resize after the last
    // touch counts); else as it was sampled
    const sampled = c.sizes[f]
    if (sampled?.play) { out[f] = sampled; continue }
    // no instance known for it in this recording (carried on by a Resume, or seen without one): as measured then
    if (!c.keys[f] && sampled) { out[f] = sampled; continue }
    if (st.play && st.play.at === f) { const z = sizeNow(f); if (z) out[f] = z; continue }
    const k = c.keys[f]
    const n = (k ? st.nodes.find((x) => x.key === k && x.frame === f) : undefined) ?? onScreen.find((x) => x.frame === f) ?? st.nodes.find((x) => x.frame === f)
    if (n && n.w > 0 && n.h > 0) out[f] = { w: Math.round(n.w), h: Math.round(n.h) }
    else if (sampled) out[f] = { w: sampled.w, h: sampled.h }
  }
  return out
}

/** The sizes it seals with: as they were at E; a frame only named by a step that came in after (a hover still in
 *  flight) as it was sampled when that step came - never as it is now. */
function sealedSizes(c: Cap): Record<string, { w: number; h: number; play?: true }> {
  if (!c.endSizes) return framesSizes(c)
  const out = { ...c.endSizes }
  for (const f of new Set([...(c.inherited ?? []), ...touchedFrames(c.steps, undefined, true, c.resumes?.at)])) if (!out[f] && c.sizes[f]) out[f] = c.sizes[f]
  return out
}

/** A capture's sealed record: its steps in time order, internal fields stripped, its context, view, pictures and
 *  sizes. `interrupted`: sealed by its page leaving, as it stood. */
function buildRecord(c: Cap, steps: Cap['steps'], interrupted = false): CaptureRecord {
  const timeline = [...steps].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0)).map(({ seq: _s, src: _k, ...step }) => step as Step)
  return {
    format: 'marver.jam.capture', v: 1, id: c.id,
    context: { canvas: location.host, board: c.board, ...(c.session ? { session: c.session } : {}), ...(c.reviewing ? { reviewing: c.reviewing } : {}), ...(c.resumes ? { resumes: c.resumes } : {}), ...(interrupted ? { interrupted: true as const } : {}) },
    view: (timeline.find((x) => x.event === 'view') as Extract<Step, { event: 'view' }> | undefined)?.view ?? {},
    timeline, pictures: c.pictures, ...(() => { const sizes = sealedSizes(c); return Object.keys(sizes).length ? { sizes } : {} })(),
  }
}

function trySeal(id: string) {
  const c = capOf(id)
  if (!c || c.state !== 'draining' || c.flushWait.size || c.probes > 0) return
  // every step is in: now the end pictures - sealing waits only for those actually under way (one refused at
  // the picture limit is never waited for)
  if (!c.endShot) endPictures(id)
  const c2 = capOf(id)
  if (!c2 || c2.shots > 0 || c2.hearing) return
  const record = buildRecord(c2, c2.steps)
  // sealed: drop everything for this id that arrives later
  useJamCapture.setState((st) => { const caps = { ...st.caps }; delete caps[id]; return { caps, tick: st.tick + 1, sealed: [...st.sealed, { id }] } })
  forgetHeard(id)
  keepSealed(record)
  void upload(record)
}

// ---- the sealed record is kept until the server has it ----------------------------------------------

/** Kept per workspace: another project served later on the same port never receives this one's captures. */
const KEPT = `mv-jam-sealed:${CONFIG.workspace ?? 'unknown'}`
const syncUnsent = () => useJamCapture.setState({ unsent: [...pendingUploads.keys()] })
const keepSealed = (r: CaptureRecord) => { try { const all = JSON.parse(localStorage.getItem(KEPT) ?? '{}'); all[r.id] = r; localStorage.setItem(KEPT, JSON.stringify(all)) } catch { /* memory only */ } pendingUploads.set(r.id, r); syncUnsent() }
const forgetSealed = (id: string) => { pendingUploads.delete(id); syncUnsent(); try { const all = JSON.parse(localStorage.getItem(KEPT) ?? '{}'); delete all[id]; localStorage.setItem(KEPT, JSON.stringify(all)) } catch { /* memory only */ } }
const pendingUploads = new Map<string, CaptureRecord>()
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Post a sealed record - the same id, idempotent on the server - until it takes. A refusal about the
 *  record itself (not the network) is final and said once; a dev server that is away is waited for. */
async function upload(record: CaptureRecord, leaving = false): Promise<void> {
  type Verdict = { ok?: boolean; card?: { id: string; rev: number }; error?: string; outside?: boolean }
  let r: Verdict | null = null
  try {
    // the workspace it was made in travels with it: another project served on this port refuses it
    const payload = JSON.stringify({ record, workspace: CONFIG.workspace })
    // a page that is going sends with keepalive (64 kB at most) so the request outlives it; a bigger one, the next page
    const res = await fetch(`${ROUTE}/api/jam/capture`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: payload, ...(leaving && payload.length < 60_000 ? { keepalive: true } : {}) })
    const body = (await res.json().catch(() => null)) as Verdict | null
    // only an explicit verdict on THIS record is final: taken (200, naming its card) or refused as a
    // record (400, saying why). Anything else - jam not running yet, another workspace, an unreadable
    // answer, a gate, a server error - is the server being away: keep it and try again
    r = res.ok && body?.ok === true && body.card?.id === record.id ? body
      : res.status === 400 && body && typeof body.error === 'string' ? body : null
  } catch { r = null }
  if (!r) {
    if (!retryTimer) useStore.getState().toast('the capture is kept here and will be sent when marver dev answers')
    retryTimer ??= setTimeout(() => { retryTimer = null; for (const x of pendingUploads.values()) void upload(x) }, 5_000)
    return
  }
  forgetSealed(record.id)
  releaseOpen(record.id, !r.ok)   // it landed (the server knows); refused, it is no longer open either
  // the server holds it: a resumed draft is replaced now (or, refused, shows again)
  const was = record.context.resumes?.id
  useJamCapture.setState((st) => ({ sealed: st.sealed.map((x) => (x.id === record.id ? { ...x, ...(r!.card ? { card: r!.card } : {}) } : x)), ...(was ? { resuming: st.resuming.filter((x) => x !== was) } : {}) }))
  void import('./jam-queue.ts').then(({ useJamQueue }) => useJamQueue.getState().load())
  if (!r.ok) useStore.getState().toast(`the capture could not be kept: ${r.error ?? 'unknown error'}`)
  // it reached the server after its session ended (another tab wrote the record): on its own
  else if (r.outside) leftOutOfSession(record.id)
}

/** A capture still recording, or finishing (its pictures and last words coming in), lives only in this page until it
 *  seals; a sealed one is kept in localStorage until it lands. Leaving the page asks first - and if you leave anyway
 *  (`pagehide`: a close, a reload, a navigation, the back-forward cache alike), every capture not sealed yet is sealed
 *  at once, as it stood, for good: a missing step says so, the server keeps it as a draft, and it goes out like any
 *  sealed record not sent yet - from the next page, or this one if it comes back. Carrying on is Resume, with a new id.
 *  Best effort: a crash or a killed process fires nothing. */
let guarded = false
function guardUnload() {
  if (guarded || typeof window === 'undefined') return
  guarded = true
  window.addEventListener('beforeunload', (e) => {
    if (!Object.keys(useJamCapture.getState().caps).length) return
    e.preventDefault()
    e.returnValue = ''
  })
  window.addEventListener('pagehide', () => sealOnLeave())
  // back from the back-forward cache: what was kept goes out now (never amended, never dropped)
  window.addEventListener('pageshow', (e) => { if (e.persisted) for (const r of pendingUploads.values()) void upload(r) })
}

/** Seal every capture not sealed yet, as it stands, and tear it down as a drop does - synchronously: the page is going. */
export function sealOnLeave() {
  const s = useJamCapture.getState()
  const caps = Object.values(s.caps)
  if (!caps.length) return
  const draft = s.noteDraft.trim()
  const records: CaptureRecord[] = []
  for (const c of caps) {
    const at = now()
    const steps = [...c.steps]
    // text written in the notes card and never added is the capture's last note, as at E
    if (c.id === s.current && draft) steps.push({ at, event: 'note', text: draft })
    steps.push({ at, event: 'missing', what: c.state === 'recording' ? 'the page closed while it recorded' : 'the page closed before it finished' })
    records.push(buildRecord(c, steps, true))
    // its frames stop recording, its microphone is let go; a late picture or word finds nothing to change
    broadcast({ type: 'sh:capture', id: c.id, on: false })
    voiceDrop(c.id)
    forgetHeard(c.id)
  }
  cancelDwell()
  unwatch?.(); unwatch = null
  useJamCapture.setState((st) => ({ current: null, caps: {}, noteOpen: false, noteDraft: '', tick: st.tick + 1, sealed: [...st.sealed, ...records.map((r) => ({ id: r.id }))] }))
  for (const r of records) { keepSealed(r); void upload(r, true) }
}

/** Records sealed in an earlier page that never reached the server: sent again at boot. */
export function resendSealed() {
  guardUnload()
  try {
    const all = JSON.parse(localStorage.getItem(KEPT) ?? '{}') as Record<string, CaptureRecord>
    // a session's capture waiting to be sent is still open: the server is told again until it lands
    for (const r of Object.values(all)) { pendingUploads.set(r.id, r); if (r.context?.session && !openOnServer.has(r.id)) holdOpen(r.id, r.context.session); void upload(r) }
    syncUnsent()
    // a resumed capture still to send keeps its draft off the lane until it lands
    const was = Object.values(all).flatMap((r) => (r.context?.resumes?.id ? [r.context.resumes.id] : []))
    if (was.length) useJamCapture.setState((st) => ({ resuming: [...new Set([...st.resuming, ...was])] }))
  } catch { /* none */ }
}

/** Resume's work, while the caller holds `settling`: load the record, let the caller settle, start. */
async function resumeNow(draft: string, ready?: () => Promise<boolean>): Promise<boolean> {
  let rec: CaptureRecord | null = null
  try {
    const r = await fetch(`${ROUTE}/api/jam/capture?id=${encodeURIComponent(draft)}`, { headers: { 'x-mv-c': csrf() } })
    const body = r.ok ? ((await r.json()) as { record?: CaptureRecord; sealed?: boolean }) : null
    if (body?.record && body.sealed !== true) { useStore.getState().toast('the capture changed after it was sealed - it cannot be resumed'); return false }
    rec = body?.record ?? null
  } catch { rec = null }
  if (!rec) { useStore.getState().toast('the capture could not be loaded to resume it'); return false }
  if (useJamCapture.getState().current) return false
  if (rec.context.board !== useStore.getState().board) { useStore.getState().toast('open the capture\'s board to resume it'); return false }
  // the caller's last word before recording starts (the draft's edit saved, it is still a draft)
  if (ready && !(await ready())) return false
  // as things are NOW: nothing recording, still on the capture's board
  if (useJamCapture.getState().current) return false
  if (rec.context.board !== useStore.getState().board) { useStore.getState().toast('open the capture\'s board to resume it'); return false }
  return begin(rec.context.reviewing, rec)
}

export const useJamCapture = create<CaptureState>((set, get) => ({
  current: null,
  caps: {},
  noteOpen: false,
  noteDraft: '',
  tick: 0,
  sealed: [],
  unsent: [],
  resuming: [],
  lastEnded: null,
  settling: null,
  async resume(draft, ready) {
    if (get().current) { useStore.getState().toast('a capture is recording - press E to end it first'); return false }
    if (sessionEnding) { useStore.getState().toast('the session is being wrapped up - a moment'); return false }
    return resumeNow(draft, ready)
  },
  start(reviewing, session) {
    // one capture at a time: the one recording is ended or dropped first
    if (get().current) { useStore.getState().toast('a capture is recording - press E to end it first'); return }
    if (sessionEnding) { useStore.getState().toast('the session is being wrapped up - a moment'); return }
    begin(reviewing, undefined, session)
  },
  end() {
    const id = get().current
    if (!id) return
    set({ current: null, lastEnded: id })
    cancelDwell()
    drain(id)
    unwatch?.(); unwatch = null
  },
  drop() {
    const id = get().current
    if (!id) return
    broadcast({ type: 'sh:capture', id, on: false })
    cancelDwell()
    voiceDrop(id)
    releaseOpen(id, true)
    // a resumed capture dropped: its draft is still there, as it was
    const was = get().caps[id]?.resumes?.id
    set((s) => { const caps = { ...s.caps }; delete caps[id]; return { current: null, caps, noteOpen: false, noteDraft: '', tick: s.tick + 1, ...(was ? { resuming: s.resuming.filter((x) => x !== was) } : {}) } })
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
    if (s.play) { shoot(id, frame ?? s.play.at, 'key'); return }   // in play: the screen on stage
    const key = pointerAt && performance.now() - pointerAt.at < 5_000 ? pointerAt.key : s.selection[s.selection.length - 1]
    const f = frame ?? (key ? frameIdOf(key) : undefined)
    if (f) shoot(id, f, 'key', key)
  },
}))

/** What the capture tile shows: the timer and the counts. */
export function captureCounts(c: Cap | undefined, t = now()): { time: string; counts: string; notes: number } {
  if (!c) return { time: '0:00', counts: '', notes: 0 }
  const sec = Math.max(0, Math.floor((t - c.t0) / 1000))
  const steps = c.steps.filter((x) => ['select', 'device', 'theme', 'copied', 'interact'].includes(x.event)).length
  const frames = new Set([...(c.inherited ?? []), ...touchedFrames(c.resumes ? c.steps.filter((x) => x.at >= c.resumes!.at) : c.steps, undefined, !c.resumes)]).size
  const plural = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '')
  return {
    time: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`,
    counts: [plural(c.points.length, 'point'), plural(c.pictures.length, 'picture'), plural(frames, 'frame'), plural(steps, 'step')].filter(Boolean).join(' · '),
    notes: c.steps.filter((x) => x.event === 'note').length,
  }
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) { (window as any).__mvJamCapture = useJamCapture; (window as any).__mvJamInstances = instances }
