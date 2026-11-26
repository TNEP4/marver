/**
 * The draw host (spec 38) - runs inside every drawing frame's iframe (`/__mv/draw/?id=…&theme=…`).
 *
 * Loads the drawing (the dev API, or the published copy), mounts Excalidraw through the adapter, saves the person's
 * changes, applies everyone else's (HMR `sh:draw`), and keeps the shell's bar and panel in step (`sh:draw-state`) while
 * running the shell's commands (`sh:draw-cmd`). The shared bridge does theme, wheel, errors and the interact lease.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-expect-error virtual module: null in dev; a published build inlines manifest+boards
import shData from 'virtual:sh-data'
import '../frame-host/bridge.js'
import './draw.css'
import { ROUTE } from '../const.ts'
import type { DrawCmd, DrawElement, DrawPatch, DrawSave, DrawState, DrawHeader } from '../../shared/draw-protocol.ts'
import { DrawSync } from './sync.ts'
import { panelModel } from './state.ts'
import type { Engine, EngineSnapshot } from './adapter.tsx'

const params = new URLSearchParams(location.search)
const id = params.get('id') ?? ''
const gen = params.get('r') ?? ''
const WS = params.get('ws') ?? ''
const PUBLISHED = (shData as unknown) !== null
const w = window as unknown as Record<string, unknown>
// Excalidraw's fonts come from this canvas (offline, the Mac app, published) - set before the engine module loads
w.EXCALIDRAW_ASSET_PATH = `${location.origin}${ROUTE}/draw-assets/`
// the draw host decides what Escape means (Excalidraw finishing a line or leaving a text keeps it)
w.__mvOwnEscape = true

// Excalidraw ends any gesture in progress when its window gains focus (its "missed pointer-up" cleanup). In a frame
// the shell holds focus, so the first stroke's own press focuses this window and Excalidraw would drop the shape it
// just started. While a pointer is down, that focus event never reaches it (registered before Excalidraw mounts)
let pointerDown = false
addEventListener('pointerdown', () => { pointerDown = true }, true)
addEventListener('pointerup', () => { pointerDown = false }, true)
addEventListener('pointercancel', () => { pointerDown = false }, true)
addEventListener('focus', (e) => { if (pointerDown) e.stopImmediatePropagation() }, true)

let theme: 'light' | 'dark' = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme
document.documentElement.classList.toggle('dark', theme === 'dark')

const post = (msg: Record<string, unknown>) => { if (window.parent !== window) window.parent.postMessage(msg, location.origin) }
const docId = () => w.__mvBoot as string | undefined
const trusted = (e: MessageEvent) => e.source === window.parent && window.parent !== window && (!e.origin || e.origin === location.origin)
const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const headers = (json = false): Record<string, string> => ({ ...(json ? { 'content-type': 'application/json' } : {}), 'x-mv-c': csrf(), ...(WS ? { 'x-mv-ws': WS } : {}) })
const apiUrl = (q = '') => `${ROUTE}/api/draw/${encodeURIComponent(id)}${q}`

interface Loaded { rev: number; header: DrawHeader; elements: DrawElement[]; files: Record<string, unknown>; background?: string }

async function load(): Promise<Loaded> {
  if (PUBLISHED) {
    const r = await fetch(`${ROUTE}/draw-data/${id.split('/').map(encodeURIComponent).join('/')}.excalidraw`)
    if (!r.ok) throw new Error(`drawing "${id}" is not in this published canvas`)
    const f = await r.json()
    return { rev: f.marver?.rev ?? 0, header: f.marver ?? { rev: 0 }, elements: f.elements ?? [], files: f.files ?? {}, background: f.appState?.viewBackgroundColor }
  }
  const r = await fetch(apiUrl(), { headers: headers() })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `drawing "${id}" could not be read (${r.status})`)
  return r.json()
}

function fail(message: string) {
  w.__mvFrameError = message
  w.__mvDrawReady = true          // a shot waits for ready - a failure is ready too (the error is what it reports)
  post({ type: 'sh:error', id, gen, boot: docId(), message })
  const root = document.getElementById('root')!
  root.innerHTML = `<div class="mv-draw-error"><b>drawing failed</b><div>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</div></div>`
}

function Host({ data, DrawEngine }: { data: Loaded; DrawEngine: typeof import('./adapter.tsx').DrawEngine }) {
  // opened on its own (no shell around it) with ?edit=1: drawing mode from the start - tests and debugging
  const [edit, setEdit] = useState(window.parent === window && params.get('edit') === '1' && !PUBLISHED)
  const [th, setTh] = useState(theme)
  const engine = useRef<Engine | null>(null)
  const frameView = useRef<DrawHeader['view'] | null>(data.header.view ?? null)
  const sync = useRef<DrawSync | null>(null)
  const panning = useRef(false)
  const panTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSent = useRef('')
  const queued = useRef(false)
  const editable = !PUBLISHED
  const editRef = useRef(edit)
  editRef.current = edit
  /** play's Hide all UI: null outside play (H is Excalidraw's hand there), else whether the UI is hidden */
  const uiHidden = useRef<boolean | null>(null)

  if (!sync.current) {
    sync.current = new DrawSync(() => engine.current, {
      put: async (body: DrawSave & { sid: string; seq: number }, keepalive?: boolean) => {
        const text = JSON.stringify(body)
        // keepalive (leaving, hiding) only fits a small body; a large one goes as an ordinary request
        const r = await fetch(apiUrl(), { method: 'PUT', headers: headers(true), body: text, keepalive: !!keepalive && text.length < 60_000 })
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `save refused (${r.status})`)
        return r.json()
      },
      since: async (rev: number) => {
        const r = await fetch(apiUrl(`?since=${rev}`), { headers: headers() })
        if (!r.ok) throw new Error(`catch-up refused (${r.status})`)
        const a = await r.json()
        return { rev: a.rev, patches: a.patches ?? [] }
      },
    }, data.rev, data.elements, editable)
    sync.current.knownFiles(Object.keys(data.files ?? {}))
  }

  // the state the shell's bar and panel show, at most once per animation frame, only when it changed
  const sendState = () => {
    if (queued.current) return
    queued.current = true
    requestAnimationFrame(() => {
      queued.current = false
      const eng = engine.current
      if (!eng) return
      const s = eng.appState()
      const model = panelModel(eng.elements() as any, s, editable && editRef.current)
      const v = eng.currentView(), fv = frameView.current
      const state: DrawState = {
        type: 'sh:draw-state', id, boot: docId(), mode: editRef.current ? 'edit' : 'view', editable,
        tool: s.activeTool?.type ?? 'selection', locked: !!s.activeTool?.locked,
        sel: model.sel, sections: model.sections, props: model.props, used: model.used, paper: paperOf(s.viewBackgroundColor, theme === 'dark'),
        zoom: s.zoom?.value ?? 1,
        canUndo: eng.canUndo(), canRedo: eng.canRedo(),
        panning: panning.current, map: { content: eng.contentBox(), view: eng.viewBox() },
        offFrameView: !fv ? false : Math.abs(v.x - fv.x) > 1 || Math.abs(v.y - fv.y) > 1 || Math.abs(v.zoom - fv.zoom) > 0.005,
        rev: sync.current!.rev, pending: sync.current!.pending,
      }
      const key = JSON.stringify(state)
      if (key === lastSent.current) return
      lastSent.current = key
      post(state as unknown as Record<string, unknown>)
    })
  }
  sync.current.onState = sendState
  sync.current.onError = (message) => post({ type: 'sh:draw-error', id, message })

  const lastScroll = useRef('')
  const onChange = (snap: EngineSnapshot) => {
    sync.current!.changed()
    const s = snap.appState
    const scroll = `${s.scrollX}|${s.scrollY}|${s.zoom?.value}`
    if (scroll !== lastScroll.current) {
      if (lastScroll.current) {
        panning.current = true
        if (panTimer.current) clearTimeout(panTimer.current)
        panTimer.current = setTimeout(() => { panning.current = false; sendState() }, 700)
      }
      lastScroll.current = scroll
    }
    sendState()
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!trusted(e)) return
      const m = e.data
      if (m?.type === 'sh:interactive') {
        setEdit(!!m.on && editable)
        // drawing mode takes the keyboard at once (Excalidraw's letters work from the first key)
        if (m.on && editable) { try { window.focus(); (document.querySelector('.excalidraw') as HTMLElement | null)?.focus({ preventScroll: true }) } catch { /* not allowed: the first click focuses */ } }
        if (!m.on) { void sync.current!.flush(); engine.current?.view('frame', frameView.current) }
      }
      else if (m?.type === 'sh:set-theme') { theme = m.theme === 'dark' ? 'dark' : 'light'; setTh(theme) }
      else if (m?.type === 'sh:draw-crisp') crisp(m.scale)
      else if (m?.type === 'sh:draw-cmd') run(m as DrawCmd)
    }
    addEventListener('message', onMsg)
    // what others changed (the dev server's merged revs)
    const hot = import.meta.hot
    const onPatch = (p: DrawPatch) => {
      if (p.frame !== id) return
      if (p.header?.view !== undefined) frameView.current = p.header.view ?? null
      sync.current!.receive(p)
    }
    hot?.on('sh:draw', onPatch)
    // a rev may have landed while the socket was down (decision 8); the first catch-up runs once the engine is ready
    const onConnect = () => sync.current!.resync()
    hot?.on('vite:ws:connect', onConnect)
    const hide = () => { if (document.visibilityState === 'hidden') void sync.current!.flush(true) }
    document.addEventListener('visibilitychange', hide)
    addEventListener('pagehide', () => void sync.current!.flush(true))
    return () => { removeEventListener('message', onMsg); hot?.off?.('sh:draw', onPatch); document.removeEventListener('visibilitychange', hide) }
  }, [])

  // Escape: Excalidraw keeps it while it is finishing something (a line, a text, a crop); otherwise it leaves drawing mode.
  // Play's keys come back to the shell: ⌘\ and ⌘/ (collapse), and H while the UI is hidden (reveal)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = !!engine.current?.appState()?.editingTextElement || (e.target as HTMLElement)?.closest?.('textarea, input')
      if ((e.metaKey || e.ctrlKey) && (e.key === '\\' || e.key === '/') && !typing) { e.preventDefault(); e.stopPropagation(); post({ type: 'sh:draw-key', key: e.key === '/' ? 'toolbar' : 'panel' }); return }
      // ⌥⇧D - the theme (Excalidraw's own key for it): D alone stays the diamond inside a drawing (Nic, 26 Nov)
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyD' && !typing) { e.preventDefault(); e.stopPropagation(); post({ type: 'sh:draw-key', key: 'theme' }); return }
      // H in play: Hide all UI, as play's menus say (Nic, 26 Nov) - reveal when hidden
      if (uiHidden.current !== null && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); e.stopPropagation(); post({ type: 'sh:draw-key', key: uiHidden.current ? 'reveal' : 'hide' }); return }
      if (e.key !== 'Escape') return
      const s = engine.current?.appState()
      const busy = s && (s.editingTextElement || s.newElement || s.multiElement || s.editingLinearElement || s.croppingElementId || s.openDialog || s.openPopup || s.contextMenu)
      if (busy || !editRef.current) return
      e.preventDefault(); e.stopPropagation()
      void sync.current!.flush()
      post({ type: 'sh:exit-interact' })
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])

  const run = (c: DrawCmd) => {
    const eng = engine.current
    if (!eng) return
    if (c.op === 'flush') { void sync.current!.flush().then(() => post({ type: 'sh:draw-flushed', id })); return }
    if (c.op === 'ui') { uiHidden.current = c.hidden; return }
    if (!editable && c.op !== 'view' && c.op !== 'export') return
    switch (c.op) {
      case 'tool': eng.setTool(c.tool); break
      case 'lock': eng.toggleLock(); break
      case 'action': eng.run(c.name, c.value); break
      case 'undo': eng.undo(); break
      case 'redo': eng.redo(); break
      case 'insert-image': eng.insertImage(); break
      case 'mode': setEdit(c.edit && editable); break
      case 'view':
        if (c.v === 'save') { const v = eng.currentView(); frameView.current = v; sync.current!.header({ view: v }) }
        else eng.view(c.v, frameView.current)
        break
      case 'export': void exportAs(eng, c.format, c.dark ?? theme === 'dark'); break
    }
    sendState()
  }

  async function exportAs(eng: Engine, format: 'png' | 'svg' | 'clipboard', dark: boolean) {
    try {
      if (format === 'svg') { const svg = await eng.exportSvg(dark); post({ type: 'sh:draw-export', id, format, data: svg }); return }
      const blob = await eng.exportPng(dark)
      if (format === 'clipboard') {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); post({ type: 'sh:draw-export', id, format, ok: true }); return }
        catch { /* not focused here: the shell writes it */ }
      }
      post({ type: 'sh:draw-export', id, format, blob })
    } catch (err) { post({ type: 'sh:draw-error', id, message: `export failed: ${(err as Error).message}` }) }
  }

  // crisp at the canvas's zoom: the engine's pixel ratio follows the camera's scale (capped), re-rendered on settle
  const nativeDpr = useRef(window.devicePixelRatio || 1)
  const crisp = (scale: number) => {
    const s = Number.isFinite(scale) && scale > 1 ? Math.min(scale, 4 / nativeDpr.current) : 1
    const next = Math.min(4, nativeDpr.current * Math.max(1, s))
    if (Math.abs((window.devicePixelRatio || 1) - next) < 0.05) return
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => next })
    window.dispatchEvent(new Event('resize'))
    engine.current?.rerender()
  }

  return createElement(DrawEngine, {
    initial: { elements: data.elements, files: data.files, view: data.header.view ?? null, background: data.background },
    theme: th, edit, editable,
    onReady: (eng: Engine) => {
      engine.current = eng
      // a handle for tests and `marver shot`: the engine, the sync, and readiness (spec 38 decision 22)
      w.__mvDraw = { engine: eng, sync: sync.current, ready: true, setEdit: (on: boolean) => setEdit(on && editable) }
      // what arrived before the engine applies now, then the first catch-up (a rev between the load and the socket)
      sync.current!.ready()
      sync.current!.resync()
      void document.fonts.ready.then(() => { w.__mvDrawReady = true })
      post({ type: 'sh:ready', id, gen, boot: docId(), doc: document.querySelector('meta[name="mv-doc"]')?.getAttribute('content') ?? '', meta: { kind: 'draw' } })
      sendState()
    },
    onChange,
    onPointerDown: () => sync.current!.pointer(true),
    onPointerUp: () => sync.current!.pointer(false),
  })
}

async function boot() {
  try {
    const [data, mod] = await Promise.all([load(), import('./adapter.tsx')])
    createRoot(document.getElementById('root')!).render(createElement(Host, { data, DrawEngine: mod.DrawEngine }))
  } catch (err) {
    fail((err as Error).message)
  }
}
boot()

/** The paper as Excalidraw draws it: in dark its canvas wears invert(93%) hue-rotate(180deg), so white is #121212 - the
 *  same filter applied here (the hue rotation undoes the inversion's hue flip, so only lightness turns). */
function paperOf(bg: string | undefined, dark: boolean): string {
  const c = (bg ?? '#ffffff').toLowerCase()
  if (!dark) return c
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c)
  if (!m) return '#121212'
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  // invert(93%) per channel, then a 180° hue turn: keep the inverted lightness, take the original hue
  const inv = (v: number) => Math.round(v * 0.07 + (255 - v) * 0.93)
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2, li = (Math.max(inv(r), inv(g), inv(b)) + Math.min(inv(r), inv(g), inv(b))) / 2
  const k = l === 0 ? 0 : li / l
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}
