/**
 * The canvas preload (spec 28 A2.9, A2.14 #9, v1.12 r1 #1): `window.marverApp` for local canvases.
 * Owner: the trust stream.
 *
 * It runs sandboxed, in the main frame only: one bundle of its own that may `require` only `electron`
 * (test/unit/bundle.test.ts). As `MarverAppV1` (src/shared/app-api.ts):
 * - one synchronous `mv:doc { origin }` at document start, answered whether or not the document is trusted: `{ reopen }`;
 * - nothing is sent before an `mv:admit { doc }`: the page's latest hello, theme, busy and menu - each a whole
 *   state - are held, and on every admit with a new `doc` all four go, hello first, stamped with it; later ones go
 *   as they come, with the latest admit's `doc`. The same admit again (main repeats it at `dom-ready`) replays
 *   nothing. The shell never sees a `doc`: `window.marverApp` is the same before and after;
 * - one `ipcRenderer.on` per main-to-page channel, fanning out to the page's listeners, for this document's `doc`
 *   alone: a message main meant for an earlier document never reaches this one.
 * What the page passes is copied as JSON before it is held: no getter, function or live object crosses.
 *
 * A3 (app 0.2; A3.8 #5, #9, #10, #26, #27): `topInset` is `mv:doc`'s answer; `onPresent` hears main's presentation
 * requests for this document and `presented` answers at once (never held: an answer, not a state); `perf` sends the
 * shell's recorder messages at once with the current `doc` (never held or replayed: they are about now). Main's
 * `mv:perf-ask` is answered here for `mem` (getProcessMemoryInfo and getHeapStatistics, KB) and `shown` (the second
 * animation-frame callback), kept for `display` (`perfInfo().hz`), and handed to the shell for `probes`.
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  APP_API_VERSION, BOUNDS, CANVAS_CHANNELS, PERF_BOUNDS,
  type AppState, type DocAnswer, type MarverAppV1, type MenuClick, type PerfMsg, type PerfProbeAsk, type Present, type Presented,
} from '../../../src/shared/app-api.ts'

type Report = 'hello' | 'theme' | 'busy' | 'menu'
const ORDER: readonly Report[] = ['hello', 'theme', 'busy', 'menu']

let answer: DocAnswer = { reopen: false }
try {
  // this document's own origin, as it knows it now: main gives the crash reload's `reopen` only to a document on
  // its canvas's origin, never to an error page (A2.14 #9)
  let origin = ''
  try { origin = String(location.origin) } catch { /* none */ }
  const a = ipcRenderer.sendSync(CANVAS_CHANNELS.doc, { origin }) as Partial<DocAnswer> | null
  if (a && typeof a.reopen === 'boolean') answer = { reopen: a.reopen, inset: a.inset === 44 ? 44 : 0 }
} catch { /* answered no */ }

let doc: string | null = null
const held = new Map<Report, unknown>()
const stateFns = new Set<(s: AppState) => void>()
const clickFns = new Set<(p: MenuClick) => void>()
const presentFns = new Set<(r: Present) => void>()
const probeFns = new Set<(a: PerfProbeAsk) => void>()
/** the display's rate main last said (`display` ask) */
let hz: number | null = null

const copy = (p: unknown): unknown => {
  try {
    const s = JSON.stringify(p)
    return s === undefined || s.length > 64 * 1024 ? undefined : JSON.parse(s)
  } catch { return undefined }
}
const post = (ch: Report, p: unknown) => { if (doc) ipcRenderer.send(CANVAS_CHANNELS[ch], { doc, p }) }
const say = (ch: Report) => (p: unknown): void => {
  const c = copy(p)
  if (c === undefined) return
  held.set(ch, c)
  post(ch, c)
}

ipcRenderer.on(CANVAS_CHANNELS.admit, (_e, a: { doc?: unknown } | null) => {
  if (!a || typeof a.doc !== 'string' || !BOUNDS.doc.test(a.doc) || a.doc === doc) return
  doc = a.doc
  for (const ch of ORDER) if (held.has(ch)) post(ch, held.get(ch))
})
ipcRenderer.on(CANVAS_CHANNELS.appState, (_e, m: { doc?: unknown; s?: unknown } | null) => {
  if (!m || !doc || m.doc !== doc || (m.s !== 'shown' && m.s !== 'hidden' && m.s !== 'untrusted')) return
  const s = m.s
  for (const fn of [...stateFns]) { try { fn(s) } catch { /* the page's own */ } }
})
ipcRenderer.on(CANVAS_CHANNELS.menuClick, (_e, m: { doc?: unknown; id?: unknown } | null) => {
  if (!m || !doc || m.doc !== doc || typeof m.id !== 'string' || !BOUNDS.menuId.test(m.id)) return
  const p = { id: m.id }
  for (const fn of [...clickFns]) { try { fn(p) } catch { /* the page's own */ } }
})

const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
const within = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

// A3: the presentation requests, for this document alone
ipcRenderer.on(CANVAS_CHANNELS.present, (_e, m: Record<string, unknown> | null) => {
  if (!m || !doc || m.doc !== doc || !whole(m.epoch, BOUNDS.epoch) || !within(m.w, BOUNDS.viewport) || !within(m.h, BOUNDS.viewport)
    || !whole(m.frames, BOUNDS.frames) || m.frames < 1) return
  const r: Present = { epoch: m.epoch, w: m.w, h: m.h, frames: m.frames }
  for (const fn of [...presentFns]) { try { fn(r) } catch { /* the page's own */ } }
})

/** an answer or a recorder message: sent now with the current doc, never held */
const now = (ch: 'perf' | 'presented', p: unknown) => { if (doc) ipcRenderer.send(CANVAS_CHANNELS[ch], { doc, p }) }

// A3: main's perf asks - mem and shown answered here (so a 0.27.0 or 0.27.1 page answers too), probes the shell's
ipcRenderer.on(CANVAS_CHANNELS.perfAsk, (_e, m: Record<string, unknown> | null) => {
  if (!m || !doc || m.doc !== doc) return
  const asked = doc
  switch (m.kind) {
    case 'mem': {
      if (!whole(m.tick, PERF_BOUNDS.counter)) return
      const tick = m.tick
      process.getProcessMemoryInfo().then((pm) => {
        if (doc !== asked) return
        const h = process.getHeapStatistics()
        now('perf', { kind: 'mem', tick, privateKB: pm.private, heapUsedKB: h.usedHeapSize, heapTotalKB: h.totalHeapSize } satisfies PerfMsg)
      }, () => { /* no answer: the sample keeps RSS */ })
      return
    }
    case 'shown': {
      if (!whole(m.tick, PERF_BOUNDS.counter)) return
      const tick = m.tick
      // a frame produced, not proved presented (A3.8 #9)
      try { requestAnimationFrame(() => requestAnimationFrame(() => { if (doc === asked) now('perf', { kind: 'shown', tick } satisfies PerfMsg) })) } catch { /* no frames */ }
      return
    }
    case 'display':
      if (typeof m.hz === 'number' && Number.isFinite(m.hz) && m.hz >= PERF_BOUNDS.hz.min && m.hz <= PERF_BOUNDS.hz.max) hz = m.hz
      return
    case 'probes': {
      if (!whole(m.tick, PERF_BOUNDS.counter) || (m.at !== 'before' && m.at !== 'after')) return
      const a: PerfProbeAsk = { kind: 'probes', tick: m.tick, at: m.at }
      for (const fn of [...probeFns]) { try { fn(a) } catch { /* the page's own */ } }
      return
    }
  }
})

const listen = <T>(set: Set<(x: T) => void>) => (fn: (x: T) => void): (() => void) => {
  if (typeof fn !== 'function') return () => {}
  set.add(fn)
  return () => { set.delete(fn) }
}

const api: MarverAppV1 = {
  v: APP_API_VERSION as 1,
  topInset: answer.inset === 44 ? 44 : 0,
  reopen: answer.reopen,
  hello: say('hello'),
  theme: say('theme'),
  busy: say('busy'),
  menu: say('menu'),
  onAppState: listen(stateFns),
  onMenuClick: listen(clickFns),
  onPresent: listen(presentFns),
  presented: (p: Presented) => { const c = copy(p); if (c !== undefined) now('presented', c) },
  perf: (p: PerfMsg) => { const c = copy(p); if (c !== undefined) now('perf', c) },
  onPerfAsk: listen(probeFns),
  perfInfo: () => ({ hz }),
}
contextBridge.exposeInMainWorld('marverApp', api)
