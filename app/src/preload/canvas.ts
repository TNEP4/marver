/**
 * The canvas preload (spec 28 A2.9, A2.14 #9, v1.12 r1 #1): `window.marverApp` for local canvases.
 * Owner: the trust stream.
 *
 * It runs sandboxed, in the main frame only: one bundle of its own that may `require` only `electron`
 * (test/unit/bundle.test.ts). As `MarverAppV1` (src/shared/app-api.ts):
 * - one synchronous `mv:doc` at document start, answered whether or not the document is trusted: `{ reopen }`;
 * - nothing is sent before an `mv:admit { doc }`: the page's latest hello, theme, busy and menu - each a whole
 *   state - are held, and on every admit with a new `doc` all four go, hello first, stamped with it; later ones go
 *   as they come, with the latest admit's `doc`. The same admit again (main repeats it at `dom-ready`) replays
 *   nothing. The shell never sees a `doc`: `window.marverApp` is the same before and after;
 * - one `ipcRenderer.on` per main-to-page channel, fanning out to the page's listeners, for this document's `doc`
 *   alone: a message main meant for an earlier document never reaches this one.
 * What the page passes is copied as JSON before it is held: no getter, function or live object crosses.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { APP_API_VERSION, BOUNDS, CANVAS_CHANNELS, type AppState, type DocAnswer, type MarverAppV1, type MenuClick } from '../../../src/shared/app-api.ts'

type Report = 'hello' | 'theme' | 'busy' | 'menu'
const ORDER: readonly Report[] = ['hello', 'theme', 'busy', 'menu']

let answer: DocAnswer = { reopen: false }
try {
  const a = ipcRenderer.sendSync(CANVAS_CHANNELS.doc) as Partial<DocAnswer> | null
  if (a && typeof a.reopen === 'boolean') answer = { reopen: a.reopen }
} catch { /* answered no */ }

let doc: string | null = null
const held = new Map<Report, unknown>()
const stateFns = new Set<(s: AppState) => void>()
const clickFns = new Set<(p: MenuClick) => void>()

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

const listen = <T>(set: Set<(x: T) => void>) => (fn: (x: T) => void): (() => void) => {
  if (typeof fn !== 'function') return () => {}
  set.add(fn)
  return () => { set.delete(fn) }
}

const api: MarverAppV1 = {
  v: APP_API_VERSION as 1,
  topInset: 0,
  reopen: answer.reopen,
  hello: say('hello'),
  theme: say('theme'),
  busy: say('busy'),
  menu: say('menu'),
  onAppState: listen(stateFns),
  onMenuClick: listen(clickFns),
}
contextBridge.exposeInMainWorld('marverApp', api)
