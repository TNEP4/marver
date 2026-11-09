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
 *
 * A4 (app 0.3; A4.6 #29): `mv:open` - a notice's click - is dropped unless its `doc` is this document's admitted one
 * and its item passes open-item.ts's check; only the known fields reach `onOpen`'s listener, and the first listener's
 * answer goes back as `mv:opened { doc, p: { id, result } }`, for the document that was asked alone.
 *
 * Spec 31 (app 1.1; D1, D3): `mv:show` - a `marver://` link into this open tab - reaches `onShow`'s listeners only for
 * this document's admitted `doc` and a target `checkShowTarget` takes; `front()` sends `mv:front { doc }` once the
 * shell showed a `marver show` (main admits it as it admits the reports, and acts at most once a second).
 *
 * A4 (app 0.3; A4.6 #35): `capture` asks main for a picture of this document's own view - before an admit it answers
 * `untrusted` with no IPC; after, `mv:capture { doc, p }` is invoked, and main's answer reaches the page only as the
 * contract types it (the bytes a `Uint8Array`, the size within `BOUNDS.captureLong`), anything else `untrusted`.
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  APP_API_VERSION, BOUNDS, CANVAS_CHANNELS, CAPTURE_WHY, EXPORT_PDF_WHY, MENU_IN, OPEN_RESULTS, PDF_JOB, PERF_BOUNDS,
  type AppState, type CaptureAnswer, type CaptureAsk, type CaptureWhy, type DocAnswer, type ExportPdfAnswer, type ExportPdfAsk, type ExportPdfWhy, type MarverAppV1, type MenuClick, type MenuIn, type OpenItem, type OpenResult,
  type PerfMsg, type PerfProbeAsk, type Present, type Presented,
} from '../../../src/shared/app-api.ts'
import { checkOpenItem } from '../shared/open-item.ts'
import { checkShowTarget, type ShowTarget } from '../../../src/shared/deep-link.ts'

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
const openFns = new Set<(p: OpenItem) => OpenResult | Promise<OpenResult>>()
const showFns = new Set<(t: ShowTarget | null) => void>()
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
ipcRenderer.on(CANVAS_CHANNELS.menuClick, (_e, m: { doc?: unknown; id?: unknown; in?: unknown } | null) => {
  if (!m || !doc || m.doc !== doc || typeof m.id !== 'string' || !BOUNDS.menuId.test(m.id)) return
  // the menu it came from (spec 30 #51), absent or unknown: not passed on, and the shell records `in: 'app'`
  const where = (MENU_IN as readonly unknown[]).includes(m.in) ? { in: m.in as MenuIn } : {}
  const p = { id: m.id, ...where }
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

// A4: a notice's click, for this document alone; the first listener answers
ipcRenderer.on(CANVAS_CHANNELS.open, (_e, m: Record<string, unknown> | null) => {
  if (!m || !doc || m.doc !== doc) return
  const item = checkOpenItem(m.item)
  const fn = [...openFns][0]
  if (!item || !fn) return
  const asked = doc
  let r: OpenResult | Promise<OpenResult>
  try { r = fn({ ...item, ...(item.cards ? { cards: [...item.cards] } : {}) }) } catch { return }
  void Promise.resolve(r).then((result) => {
    if (doc !== asked || !(OPEN_RESULTS as readonly unknown[]).includes(result)) return
    ipcRenderer.send(CANVAS_CHANNELS.opened, { doc, p: { id: item.id, result } })
  }, () => { /* the page's own */ })
})

// spec 31 D1: a `marver://` link into this open tab - main's navigation command, for this document alone, checked again
ipcRenderer.on(CANVAS_CHANNELS.show, (_e, m: Record<string, unknown> | null) => {
  if (!m || !doc || m.doc !== doc) return
  // null: the canvas's own board (a link whose place the app could not take)
  const t = m.p === null ? null : checkShowTarget(m.p)
  if (m.p !== null && !t) return
  for (const fn of [...showFns]) { try { fn(t ? { ...t } : null) } catch { /* the page's own */ } }
})

// A4: a live picture of this document's view (A4.6 #35)
const WHYS = new Set<string>(CAPTURE_WHY)
const side = (v: unknown): v is number => whole(v, BOUNDS.captureLong) && v >= 1
/** main's answer as the contract types it, or `untrusted`: nothing else reaches the page */
const captureAnswer = (a: unknown): CaptureAnswer => {
  const m = a && typeof a === 'object' ? a as Record<string, unknown> : null
  if (m?.ok === true && m.png instanceof Uint8Array && m.png.length > 0 && side(m.width) && side(m.height)) return { ok: true, png: m.png, width: m.width, height: m.height }
  if (m?.ok === false && typeof m.why === 'string' && WHYS.has(m.why)) return { ok: false, why: m.why as CaptureWhy }
  return { ok: false, why: 'untrusted' }
}
const capture = (a: CaptureAsk): Promise<CaptureAnswer> => {
  const asked = doc
  if (!asked) return Promise.resolve({ ok: false, why: 'untrusted' })
  const p = copy(a)
  if (p === undefined) return Promise.resolve({ ok: false, why: 'bounds' })
  return ipcRenderer.invoke(CANVAS_CHANNELS.capture, { doc: asked, p }).then(captureAnswer, () => ({ ok: false, why: 'untrusted' }) as const)
}

// spec 31: a finished deck PDF saved by main - only the job id crosses; main's answer reaches the page as typed
const PDF_WHYS = new Set<string>(EXPORT_PDF_WHY)
const exportPdf = (a: ExportPdfAsk): Promise<ExportPdfAnswer> => {
  const asked = doc
  if (!asked) return Promise.resolve({ ok: false, why: 'untrusted' })
  const job = a && typeof a === 'object' ? (a as { job?: unknown }).job : undefined
  if (typeof job !== 'string' || !PDF_JOB.test(job)) return Promise.resolve({ ok: false, why: 'bad-job' })
  return ipcRenderer.invoke(CANVAS_CHANNELS.exportPdf, { doc: asked, p: { job } }).then((r: unknown): ExportPdfAnswer => {
    const m = r && typeof r === 'object' ? r as Record<string, unknown> : null
    if (m?.ok === true) return { ok: true }
    if (m?.ok === false && typeof m.why === 'string' && PDF_WHYS.has(m.why)) return { ok: false, why: m.why as ExportPdfWhy }
    return { ok: false, why: 'failed' }
  }, () => ({ ok: false, why: 'failed' }) as const)
}

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
  // spec 30 #38: `watch` true - main takes `mv:perf watch`, so a 0.30 shell may send it
  perfInfo: () => ({ hz, watch: true }),
  onOpen: (fn) => {
    if (typeof fn !== 'function') return () => {}
    openFns.add(fn)
    return () => { openFns.delete(fn) }
  },
  capture,
  onShow: listen(showFns),
  // spec 31 D3: this document showed a `marver show` - main judges the sender and brings its tab forward
  front: () => { if (doc) ipcRenderer.send(CANVAS_CHANNELS.front, { doc }) },
  exportPdf,
}
contextBridge.exposeInMainWorld('marverApp', api)
