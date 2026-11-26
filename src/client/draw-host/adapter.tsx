/**
 * The adapter (spec 38, D1) - the ONLY module that imports `@excalidraw/excalidraw`. Everything Marver needs from the
 * engine goes through `DrawEngine` and the `Engine` controller it hands back, so a version bump touches one file.
 *
 * Excalidraw's own UI (toolbar, menus, panel, footer) is hidden by draw.css; Marver's bar and panel live in the shell
 * and drive the engine by message. Commands run Excalidraw's OWN actions: one hidden action, registered at mount,
 * receives Excalidraw's app in `perform`; from then on `run('changeStrokeColor', …)` is exactly what its own panel does
 * (text re-measure, elbow routing, z-order with fractional indices, the undo stack). Pinned to 0.18.1; the adapter test
 * runs every action in DRAW_ACTIONS against it.
 */
import { useEffect, useRef } from 'react'
import { Excalidraw, CaptureUpdateAction, FONT_FAMILY, reconcileElements, restoreElements, exportToBlob, exportToSvg, getSceneVersion, getCommonBounds, viewportCoordsToSceneCoords, sceneCoordsToViewportCoords, getTextFromElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { DrawAction, DrawElement, DrawTool, DrawViewOp, Box } from '../../shared/draw-protocol.ts'
import { DRAW_ACTIONS } from '../../shared/draw-protocol.ts'

type Api = any   // ExcalidrawImperativeAPI - typed loosely on purpose: the adapter is the type boundary
type App = any   // Excalidraw's App instance, as an action's perform receives it

export interface EngineSnapshot {
  elements: readonly DrawElement[]          // including deleted (the save diff needs the deletes)
  appState: any
  sceneVersion: number
}

/** What the rest of the draw host may do with the engine. */
export interface Engine {
  run(name: DrawAction, value?: unknown): boolean
  setTool(tool: DrawTool): void
  toggleLock(): void
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  view(op: DrawViewOp, frameView?: { x: number; y: number; zoom: number } | null): void
  /** the current view, in the file's `marver.view` shape */
  currentView(): { x: number; y: number; zoom: number }
  /** apply a merged rev from the server - authoritative (spec 38 decision 3): it replaces each element, except those in
   *  `protect` (the person's unconfirmed changes); off the undo stack; agent revs get Excalidraw's repair */
  applyRemote(upserts: DrawElement[], deletes: { id: string; version: number }[], protect: Set<string>, repair: boolean, files?: Record<string, unknown>): void
  files(): Record<string, unknown>
  elements(): readonly DrawElement[]
  appState(): any
  contentBox(): Box | null
  viewBox(): Box
  /** the drawing at 3x (its longest side capped at 8192 px), and the scale it came out at; `ids`: only those elements
   *  (and what belongs to them - a shape's label, a frame's children) */
  exportPng(dark: boolean, ids?: string[]): Promise<{ blob: Blob; scale: number }>
  exportSvg(dark: boolean): Promise<string>
  /** re-render every element canvas at the current pixel ratio (after a crispness change) */
  rerender(): void
  insertImage(): void
  /** spec 39: the element a comment would go on at this point of the iframe (client px) - by its own geometry, never
   *  by the selection's box; locked elements count; a closed shape by its inside too; null = the paper */
  hit(clientX: number, clientY: number): Hit | null
  /** spec 39: a live element's geometry in drawing units (null: gone or deleted) */
  geo(id: string): Geo | null
  /** drawing units -> iframe px, and back */
  toView(x: number, y: number): { x: number; y: number }
  toScene(clientX: number, clientY: number): { x: number; y: number }
  /** the camera: scroll and zoom */
  camera(): { scrollX: number; scrollY: number; zoom: number }
  /** scroll so this box of the drawing is in view (a comment opened on purpose) */
  reveal(box: Box): void
  /** spec 39 A6: Excalidraw's right-click menu as it stands (its own actions, filtered by their predicates), or null */
  menu(): { rows: { name: string; labelKey: string }[]; top: number; left: number; element: boolean } | null
  closeMenu(): void
  /** the selection as Excalidraw's own clipboard JSON (what its Copy writes) - written by the shell, inside the click */
  clipboardJson(): string
  /** the selection's words, as Excalidraw's Copy as text */
  selectionText(): string
  /** the selection (bound text and frame children included) as SVG; all of it when nothing is selected */
  selectionSvg(dark: boolean): Promise<string>
  /** paste Excalidraw clipboard JSON or plain text at the pointer, as its own paste does */
  paste(text: string): void
}

/** spec 39: a hit element, as a comment needs it */
export interface Hit { id: string; type: string; label: string }
/** spec 39: an element's unrotated box, its angle, and where a pin with no click point attaches (drawing units) */
export interface Geo { type: string; x: number; y: number; w: number; h: number; angle: number; label: string; attach: { x: number; y: number } }

/** shapes whose inside takes a comment even with no fill (spec 39 A1); a frame's inside only when nothing else is hit */
const CLOSED = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'])
/** a point in an element's unrotated box, as fractions (rotated back around its centre first) */
function local(el: any, x: number, y: number): { fx: number; fy: number } {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2, a = -(el.angle || 0)
  const dx = x - cx, dy = y - cy
  const rx = dx * Math.cos(a) - dy * Math.sin(a) + cx, ry = dx * Math.sin(a) + dy * Math.cos(a) + cy
  return { fx: el.width ? (rx - el.x) / el.width : 0.5, fy: el.height ? (ry - el.y) / el.height : 0.5 }
}
function inside(el: any, x: number, y: number): boolean {
  const { fx, fy } = local(el, x, y)
  if (el.type === 'ellipse') return (fx - 0.5) ** 2 + (fy - 0.5) ** 2 <= 0.25
  if (el.type === 'diamond') return Math.abs(fx - 0.5) + Math.abs(fy - 0.5) <= 0.5
  return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1
}
export { local as localPoint }

const CU = CaptureUpdateAction
/** Excalidraw's font ids to the faces it registers */
const FAMILY_NAME: Record<number, string> = Object.fromEntries(Object.entries(FONT_FAMILY as Record<string, number>).map(([name, id]) => [id, name]))
const GRAB_KEY = 'F19'

export function DrawEngine({ initial, theme, edit, editable, picking = false, onReady, onChange, onPointerDown, onPointerUp }: {
  initial: { elements: DrawElement[]; files?: Record<string, unknown>; view?: { x: number; y: number; zoom: number } | null; background?: string }
  theme: 'light' | 'dark'
  edit: boolean
  editable: boolean
  /** spec 39: comment mode picking - the drawing shows read-only while it lasts; its tool and selection come back after */
  picking?: boolean
  onReady: (engine: Engine) => void
  onChange: (snap: EngineSnapshot) => void
  onPointerDown?: () => void
  onPointerUp?: () => void
}) {
  const apiRef = useRef<Api>(null)
  const appRef = useRef<App>(null)
  const readyRef = useRef(false)
  const cbs = useRef({ onChange, onPointerDown, onPointerUp, onReady })
  cbs.current = { onChange, onPointerDown, onPointerUp, onReady }

  // the hidden action that hands us Excalidraw's app; triggered once by a synthetic key on its container
  const grab = (api: Api) => {
    api.registerAction({
      name: 'mvGrab', label: 'mvGrab', trackEvent: false,
      keyTest: (e: KeyboardEvent) => e.key === GRAB_KEY && (e as KeyboardEvent & { mvGrab?: boolean }).mvGrab === true,
      perform: (_e: unknown, _s: unknown, _v: unknown, app: App) => { appRef.current = app; return false },
    })
  }
  const tryGrab = () => {
    if (appRef.current) return true
    const host = document.querySelector('.excalidraw')
    if (!host) return false
    // 1. React's tree: from Excalidraw's container up to the component that owns the action manager. Works in view
    //    mode too (Excalidraw ignores keys there, so the key path below cannot reach the hidden action at rest)
    const fiberKey = Object.keys(host).find((k) => k.startsWith('__reactFiber$'))
    let f = fiberKey ? (host as unknown as Record<string, any>)[fiberKey] : null
    for (let i = 0; f && i < 60; i++, f = f.return) {
      const sn = f.stateNode
      if (sn && typeof sn === 'object' && sn.actionManager && typeof sn.actionManager.executeAction === 'function') { appRef.current = sn; break }
    }
    if (appRef.current) return true
    // 2. the hidden action's key (edit mode only)
    const ev = new KeyboardEvent('keydown', { key: GRAB_KEY, bubbles: true, cancelable: true }) as KeyboardEvent & { mvGrab?: boolean }
    ev.mvGrab = true
    host.dispatchEvent(ev)
    return !!appRef.current
  }

  const engine: Engine = {
    run(name, value) {
      if (!appRef.current) tryGrab()
      const app = appRef.current
      if (!app || !(DRAW_ACTIONS as readonly string[]).includes(name)) return false
      const action = app.actionManager?.actions?.[name]
      if (!action) return false
      // its own predicate, checked again as it runs (a menu row from a moment ago may no longer apply - spec 39 B8)
      if (action.predicate) {
        let ok = true
        try { ok = !!action.predicate(app.scene?.getNonDeletedElements?.() ?? [], app.state, app.props, app) } catch { ok = true }
        if (!ok) return false
      }
      app.actionManager.executeAction(action, 'ui', value)
      return true
    },
    setTool(tool) {
      const api = apiRef.current
      if (!api) return
      if (tool === 'image') { engine.insertImage(); return }
      api.setActiveTool({ type: tool })
    },
    toggleLock() { appRef.current?.toggleLock?.('ui') },
    undo() { const am = appRef.current?.actionManager; am && am.executeAction(am.actions.undo, 'ui') },
    redo() { const am = appRef.current?.actionManager; am && am.executeAction(am.actions.redo, 'ui') },
    canUndo() { const h = appRef.current?.history; return !!h && typeof h.isUndoStackEmpty === 'boolean' ? !h.isUndoStackEmpty : !!h && !h.isUndoStackEmpty?.() },
    canRedo() { const h = appRef.current?.history; return !!h && typeof h.isRedoStackEmpty === 'boolean' ? !h.isRedoStackEmpty : !!h && !h.isRedoStackEmpty?.() },
    view(op, frameView) {
      const api = apiRef.current, am = appRef.current?.actionManager
      if (!api) return
      const z = api.getAppState().zoom.value
      if (op === 'in' && am) am.executeAction(am.actions.zoomIn, 'ui')
      else if (op === 'out' && am) am.executeAction(am.actions.zoomOut, 'ui')
      else if (op === 'reset' && am) am.executeAction(am.actions.resetZoom, 'ui')
      else if (op === 'fit') fitContent(api)
      else if (op === 'selection' && am) am.executeAction(am.actions.zoomToFitSelection, 'ui')
      else if (op === 'frame') { if (frameView) setView(api, frameView); else fitContent(api) }
      void z
    },
    currentView() {
      const s = apiRef.current?.getAppState()
      return s ? { x: round(s.scrollX), y: round(s.scrollY), zoom: Math.round(s.zoom.value * 1000) / 1000 } : { x: 0, y: 0, zoom: 1 }
    },
    applyRemote(upserts, deletes, protect, repair, files) {
      const api = apiRef.current
      if (!api) return
      if (files && Object.keys(files).length) api.addFiles(Object.values(files) as any)
      const local = api.getSceneElementsIncludingDeleted() as DrawElement[]
      const map = new Map(local.map((e) => [e.id, e]))
      const incoming = upserts.filter((u) => !protect.has(u.id))
      if (incoming.length) {
        // repaired against the WHOLE scene (an arrow's unchanged endpoints, a label's unchanged container), and only the
        // incoming elements taken from the result - a partial patch must never strip a binding
        const ids = new Set(incoming.map((u) => u.id))
        // in fractional-index order: restoreElements normalises indices by array order (r2 #3)
        const byIndex = (a: DrawElement, b: DrawElement) => { const ia = a.index ?? '', ib = b.index ?? ''; return ia < ib ? -1 : ia > ib ? 1 : 0 }
        const scene = [...map.values()].filter((e) => !ids.has(e.id)).concat(incoming as DrawElement[]).sort(byIndex)
        const restored = restoreElements(scene as any, null, { refreshDimensions: repair, repairBindings: repair }) as unknown as DrawElement[]
        for (const el of restored) if (ids.has(el.id)) map.set(el.id, el)
      }
      for (const d of deletes) {
        if (protect.has(d.id)) continue
        const m = map.get(d.id)
        if (m) map.set(d.id, { ...m, isDeleted: true, version: Math.max(m.version + 1, d.version), versionNonce: 0 })
      }
      const next = [...map.values()].sort((a, b) => { const ia = a.index ?? '', ib = b.index ?? ''; return ia < ib ? -1 : ia > ib ? 1 : 0 })
      api.updateScene({ elements: next, captureUpdate: CU.NEVER })
    },
    files() { return (apiRef.current?.getFiles() ?? {}) as Record<string, unknown> },
    elements() { return (apiRef.current?.getSceneElementsIncludingDeleted() ?? []) as DrawElement[] },
    appState() { return apiRef.current?.getAppState() },
    contentBox() {
      const els = (apiRef.current?.getSceneElements() ?? []) as any[]
      if (!els.length) return null
      const [x1, y1, x2, y2] = getCommonBounds(els)
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    },
    viewBox() {
      const s = apiRef.current?.getAppState()
      if (!s) return { x: 0, y: 0, w: 0, h: 0 }
      const z = s.zoom.value
      return { x: -s.scrollX, y: -s.scrollY, w: s.width / z, h: s.height / z }
    },
    async exportPng(dark, ids) {
      const api = apiRef.current
      // the scale through getDimensions - the one way exportToBlob reads it (appState.exportScale is the dialog's): 3x,
      // sharp on any screen and in a slide, the longest side kept within 8192 px
      let scale = 1
      const blob = await exportToBlob({
        elements: ids ? withAttached(api.getSceneElements(), ids) : api.getSceneElements(), files: api.getFiles(), mimeType: 'image/png', exportPadding: 24,
        appState: { exportBackground: true, viewBackgroundColor: dark ? '#121212' : '#ffffff', exportWithDarkMode: dark },
        getDimensions: (w: number, h: number) => { scale = Math.max(1, Math.min(3, 8192 / Math.max(w, h, 1))); return { width: Math.round(w * scale), height: Math.round(h * scale), scale } },
      } as any)
      return { blob, scale }
    },
    async exportSvg(dark) {
      const api = apiRef.current
      const svg = await exportToSvg({
        elements: api.getSceneElements(), files: api.getFiles(), exportPadding: 24,
        appState: { exportBackground: true, viewBackgroundColor: dark ? '#121212' : '#ffffff', exportWithDarkMode: dark },
      } as any)
      return svg.outerHTML
    },
    rerender() {
      const api = apiRef.current
      if (!api) return
      // element canvases are cached per zoom: a nudge of the zoom by a hair regenerates them at the new pixel ratio,
      // and the next frame puts the exact zoom back - no visible change, every element re-rasterised
      const s = api.getAppState()
      const z = s.zoom.value
      api.updateScene({ appState: { zoom: { value: z * 1.000001 } }, captureUpdate: CU.NEVER })
      requestAnimationFrame(() => api.updateScene({ appState: { zoom: { value: z } }, captureUpdate: CU.NEVER }))
      api.refresh()
    },
    insertImage() {
      const api = apiRef.current
      if (!api) return
      api.setActiveTool({ type: 'image', insertOnCanvasDirectly: true })
    },
    hit(clientX, clientY) {
      const api = apiRef.current
      if (!api) return null
      if (!appRef.current) tryGrab()
      const app = appRef.current
      const { x, y } = engine.toScene(clientX, clientY)
      const els = (api.getSceneElements() as any[])
      const byId = new Map(els.map((e) => [e.id, e]))
      let top: any = null, frame: any = null
      for (const el of els) {
        if (el.type === 'text' && el.containerId) continue          // a label is its shape (its hit counts for it)
        // Excalidraw's own geometry, never the selection's box (considerBoundingBox false): strokes by their distance
        let hit = false
        try { hit = app ? !!app.hitElement(x, y, el, false) : false } catch { hit = false }
        const isFrame = el.type === 'frame' || el.type === 'magicframe'
        if (!hit && CLOSED.has(el.type) && !isFrame) hit = inside(el, x, y)
        // frame clipping: an element in a frame is hit only inside that frame
        if (hit && el.frameId) { const f = byId.get(el.frameId); if (f && !inside(f, x, y)) hit = false }
        if (hit) top = el
        else if (isFrame && inside(el, x, y)) frame = el
      }
      const el = top ?? frame
      return el ? { id: el.id, type: el.type, label: labelOf(el, byId) } : null
    },
    geo(id) {
      const api = apiRef.current
      if (!api) return null
      const els = api.getSceneElements() as any[]
      const byId = new Map(els.map((e) => [e.id, e]))
      const el = byId.get(id)
      if (!el) return null
      return { type: el.type, x: el.x, y: el.y, w: el.width, h: el.height, angle: el.angle || 0, label: labelOf(el, byId), attach: attachOf(el, byId) }
    },
    toView(x, y) {
      const s = apiRef.current?.getAppState()
      if (!s) return { x, y }
      const p = sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, s)
      return { x: p.x - (s.offsetLeft || 0), y: p.y - (s.offsetTop || 0) }
    },
    toScene(clientX, clientY) {
      const s = apiRef.current?.getAppState()
      if (!s) return { x: clientX, y: clientY }
      return viewportCoordsToSceneCoords({ clientX: clientX + (s.offsetLeft || 0), clientY: clientY + (s.offsetTop || 0) }, s)
    },
    camera() {
      const s = apiRef.current?.getAppState()
      return s ? { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value } : { scrollX: 0, scrollY: 0, zoom: 1 }
    },
    menu() {
      const api = apiRef.current
      if (!api) return null
      if (!appRef.current) tryGrab()
      const app = appRef.current
      const st = api.getAppState()
      const cm = st.contextMenu
      if (!cm || !app) return null
      const els = app.scene?.getNonDeletedElements?.() ?? api.getSceneElements()
      const rows: { name: string; labelKey: string }[] = []
      for (const item of cm.items as any[]) {
        if (!item) continue
        if (item === 'separator') { rows.push({ name: '|', labelKey: '' }); continue }
        let ok = true
        try { ok = !item.predicate || !!item.predicate(els, st, app.props, app) } catch { ok = false }
        if (!ok) continue
        let labelKey = ''
        try { labelKey = typeof item.label === 'function' ? String(item.label(els, st, app)) : String(item.label ?? '') } catch { labelKey = '' }
        rows.push({ name: String(item.name), labelKey })
      }
      const element = (cm.items as any[]).some((i) => i?.name === 'copy' || i?.name === 'cut' || i?.name === 'deleteSelectedElements')
      return { rows, top: cm.top - (st.offsetTop || 0), left: cm.left - (st.offsetLeft || 0), element }
    },
    closeMenu() { apiRef.current?.updateScene({ appState: { contextMenu: null }, captureUpdate: CU.NEVER }) },
    clipboardJson() {
      const api = apiRef.current
      const sel = api.getAppState().selectedElementIds ?? {}
      const elements = withAttached(api.getSceneElements(), Object.keys(sel).filter((k) => sel[k]))
      const files: Record<string, unknown> = {}
      const all = api.getFiles() ?? {}
      for (const e of elements as any[]) if (e.fileId && all[e.fileId]) files[e.fileId] = all[e.fileId]
      return JSON.stringify({ type: 'excalidraw/clipboard', elements, files })
    },
    selectionText() {
      const api = apiRef.current
      const sel = api.getAppState().selectedElementIds ?? {}
      return getTextFromElements(withAttached(api.getSceneElements(), Object.keys(sel).filter((k) => sel[k])) as any)
    },
    async selectionSvg(dark) {
      const api = apiRef.current
      const sel = api.getAppState().selectedElementIds ?? {}
      const ids = Object.keys(sel).filter((k) => sel[k])
      const svg = await exportToSvg({
        elements: ids.length ? withAttached(api.getSceneElements(), ids) : api.getSceneElements(), files: api.getFiles(), exportPadding: 24,
        appState: { exportBackground: false, viewBackgroundColor: dark ? '#121212' : '#ffffff', exportWithDarkMode: dark },
      } as any)
      return svg.outerHTML
    },
    paste(text) {
      // Excalidraw's own paste path (its document listener), at the pointer: a clipboard event carrying the data
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    reveal(box) {
      const api = apiRef.current
      if (!api) return
      const s = api.getAppState()
      const z = s.zoom.value
      const vw = s.width / z, vh = s.height / z
      const vx = -s.scrollX, vy = -s.scrollY
      const pad = 60 / z
      // already comfortably in view: leave the camera alone
      if (box.x >= vx + pad && box.y >= vy + pad && box.x + box.w <= vx + vw - pad && box.y + box.h <= vy + vh - pad) return
      // centred, at the current zoom unless it cannot fit (then just enough to fit, never above 100 %)
      const fit = Math.min(z, (s.width - 120) / Math.max(1, box.w), (s.height - 120) / Math.max(1, box.h))
      const nz = Math.max(0.1, Math.min(z, fit))
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2
      api.updateScene({ appState: { zoom: { value: nz }, scrollX: s.width / nz / 2 - cx, scrollY: s.height / nz / 2 - cy }, captureUpdate: CU.NEVER })
    },
  }

  // view mode follows `edit` (at rest and published: view; drawing mode: tools live)
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    if (!edit) api.updateScene({ appState: { selectedElementIds: {}, editingTextElement: null }, captureUpdate: CU.NEVER })
    // Excalidraw keeps a pan begun in view mode in a module flag that only its window pointer-up clears: entering
    // drawing mode releases it, or the person's first stroke would be eaten as the end of that pan
    else for (const type of ['pointerup', 'pointercancel']) window.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse' }))
  }, [edit])

  // picking pauses the tool (spec 39 B1): the tool and the selection are remembered and put back, and a pan begun while
  // picking is released as on entering drawing mode (or the first stroke after would be eaten)
  const paused = useRef<{ tool: any; sel: Record<string, true> } | null>(null)
  useEffect(() => {
    const api = apiRef.current
    if (!api || !edit) return
    if (picking) {
      const st = api.getAppState()
      paused.current = { tool: st.activeTool, sel: { ...(st.selectedElementIds ?? {}) } }
    } else if (paused.current) {
      const p = paused.current
      paused.current = null
      for (const type of ['pointerup', 'pointercancel']) window.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse' }))
      requestAnimationFrame(() => {
        if (p.tool?.type && p.tool.type !== 'custom') api.setActiveTool({ type: p.tool.type, locked: !!p.tool.locked })
        api.updateScene({ appState: { selectedElementIds: p.sel }, captureUpdate: CU.NEVER })
      })
    }
  }, [picking])

  return (
    <div className={`mv-draw ${edit ? 'mv-edit' : 'mv-view'}${picking ? ' mv-picking' : ''}`} style={{ position: 'absolute', inset: 0 }}>
      <Excalidraw
        excalidrawAPI={(api: Api) => {
          if (apiRef.current) return
          apiRef.current = api
          grab(api)
          api.onPointerDown(() => cbs.current.onPointerDown?.())
          api.onPointerUp(() => cbs.current.onPointerUp?.())
          // the first commit: grab the app, set the view, hand the engine out
          const start = (tries = 0) => {
            if (!tryGrab() && tries < 60) { requestAnimationFrame(() => start(tries + 1)); return }
            if (initial.view) setView(api, initial.view)
            else fitContent(api, true)
            readyRef.current = true
            ;(window as unknown as { __mvApp?: App }).__mvApp = appRef.current   // tests read it
            cbs.current.onReady(engine)
            // texts measured again once the hand-drawn fonts are in: measured with a fallback font first, a box is too
            // narrow and the words are cut off. Only the boxes change - nothing to save, nothing to undo.
            const remeasure = () => {
              const els = api.getSceneElementsIncludingDeleted() as unknown as DrawElement[]
              if (!els.some((e) => e.type === 'text' && !e.isDeleted)) return
              // (0.18.1 refreshes dimensions only inside its binding repair: both flags, and only the boxes are taken)
              // wrapped anew from the words as written (originalText): restoreElements keeps the line breaks a text
              // holds, so breaks made under the fallback font would stay (release review)
              const unwrapped = els.map((e) => (e.type === 'text' && typeof (e as any).originalText === 'string' ? { ...e, text: (e as any).originalText } : e))
              const fresh = new Map((restoreElements(unwrapped as any, null, { refreshDimensions: true, repairBindings: true }) as unknown as DrawElement[]).map((e) => [e.id, e]))
              let changed = false
              // the whole refreshed layout - its line breaks and place with its box (a label wrapped anew in its shape, a
              // fixed-width text that now takes two lines), never a new box around the old lines (release review)
              const next = els.map((e) => {
                const f = fresh.get(e.id) as (DrawElement & { text?: string }) | undefined
                const t = e as DrawElement & { text?: string }
                if (e.type !== 'text' || !f || (f.width === e.width && f.height === e.height && f.text === t.text && f.x === e.x && f.y === e.y)) return e
                changed = true
                const laid = { ...e, text: f.text, x: f.x, y: f.y, width: f.width, height: f.height }
                // a shape's label placed again in it by its alignment (restoreElements resizes it but leaves it where it
                // was - a two-line label that is now one line would sit high: release review r5); arrows place their own
                const box = (e as any).containerId ? els.find((c) => c.id === (e as any).containerId) : undefined
                return box && box.type !== 'arrow' && box.type !== 'line' ? { ...laid, ...labelPosition(box, laid) } : laid
              })
              if (changed) api.updateScene({ elements: next as any, captureUpdate: CU.NEVER })
            }
            // the exact faces the texts need (Excalidraw loads them by unicode range, lazily): loaded, then measured
            const texts = (api.getSceneElements() as unknown as DrawElement[]).filter((e) => e.type === 'text')
            const wants = new Map<string, string>()
            for (const t of texts) {
              const fam = FAMILY_NAME[Number((t as any).fontFamily)] ?? 'Excalifont'
              const key = `${Number((t as any).fontSize) || 20}px "${fam}"`
              wants.set(key, (wants.get(key) ?? '') + String((t as any).text ?? ''))
            }
            void Promise.all([...wants].map(([font, sample]) => document.fonts.load(font, sample).catch(() => []))).then(remeasure)
            document.fonts.addEventListener('loadingdone', remeasure)
            for (const ms of [500, 1500, 4000]) setTimeout(remeasure, ms)   // faces Excalidraw registers after mount
          }
          requestAnimationFrame(() => start())
        }}
        initialData={{
          // measured as it loads: a text's stored box (an agent's estimate, another font's) never cuts its words off
          elements: restoreElements(initial.elements as any, null, { refreshDimensions: true, repairBindings: true }) as any,
          files: initial.files as any,
          appState: { viewBackgroundColor: initial.background ?? '#ffffff', currentItemRoughness: 1, theme, gridSize: null } as any,
          scrollToContent: false,
        }}
        theme={theme}
        viewModeEnabled={!edit || !editable || picking}
        zenModeEnabled={false}
        gridModeEnabled={false}
        handleKeyboardGlobally={false}
        detectScroll={false}
        autoFocus={edit}
        aiEnabled={false}
        UIOptions={{
          canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false },
          tools: { image: true },
        }}
        onChange={(elements: any, appState: any) => {
          if (!readyRef.current) return
          cbs.current.onChange({ elements: elements as DrawElement[], appState, sceneVersion: getSceneVersion(elements) })
        }}
      />
    </div>
  )
}

const round = (n: number) => Math.round(n * 10) / 10

function setView(api: Api, v: { x: number; y: number; zoom: number }) {
  const zoom = Math.min(30, Math.max(0.1, v.zoom || 1))
  api.updateScene({ appState: { scrollX: v.x, scrollY: v.y, zoom: { value: zoom } }, captureUpdate: CU.NEVER })
}

function fitContent(api: Api, initial = false) {
  const els = api.getSceneElements()
  if (!els.length) { api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, captureUpdate: CU.NEVER }); return }
  // fit with a margin, never above 100 % (a three-box sketch should not fill the frame at 400 %)
  api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.9, animate: !initial, duration: 220, maxZoom: 1 } as any)
}

/** Where a label sits in its shape - Excalidraw 0.18.1's computeBoundTextPosition (element/textElement.ts), not exported
 *  from the package: the shape's inner box (padding 5; an ellipse's and a diamond's inscribed one), then the label's
 *  alignment in it. */
function labelPosition(box: DrawElement, t: DrawElement): { x: number; y: number } {
  const P = 5
  const w = Number(box.width), h = Number(box.height)
  let ox = P, oy = P, mw = w - P * 2, mh = h - P * 2
  if (box.type === 'ellipse') { ox += (w / 2) * (1 - Math.SQRT2 / 2); oy += (h / 2) * (1 - Math.SQRT2 / 2); mw = Math.round((w / 2) * Math.SQRT2) - P * 2; mh = Math.round((h / 2) * Math.SQRT2) - P * 2 }
  if (box.type === 'diamond') { ox += w / 4; oy += h / 4; mw = Math.round(w / 2) - P * 2; mh = Math.round(h / 2) - P * 2 }
  const cx = Number(box.x) + ox, cy = Number(box.y) + oy, tw = Number(t.width), th = Number(t.height)
  const va = (t as any).verticalAlign, ta = (t as any).textAlign
  const y = va === 'top' ? cy : va === 'bottom' ? cy + (mh - th) : cy + (mh / 2 - th / 2)
  const x = ta === 'left' ? cx : ta === 'right' ? cx + (mw - tw) : cx + (mw / 2 - tw / 2)
  return { x, y }
}

/** An element's words: a text's own, a shape's label (its bound text), else none. */
function labelOf(el: any, byId: Map<string, any>): string {
  if (el.type === 'text') return String(el.originalText ?? el.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const t = (el.boundElements ?? []).find((b: any) => b?.type === 'text')
  const te = t && byId.get(t.id)
  return te ? String(te.originalText ?? te.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) : ''
}

/** Where a pin with no click point attaches (spec 39 B3): a shape's or text's first label line's end, a line's, arrow's
 *  or stroke's top-right, in drawing units. */
function attachOf(el: any, byId: Map<string, any>): { x: number; y: number } {
  const lin = el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw'
  const t = el.type === 'text' ? el : (() => { const b = (el.boundElements ?? []).find((x: any) => x?.type === 'text'); return b ? byId.get(b.id) : null })()
  if (!lin && t) {
    const lh = (Number(t.fontSize) || 20) * (Number(t.lineHeight) || 1.25)
    const lines = String(t.text ?? '').split('\n')
    // the first line's width, in proportion to its share of the longest line (no measuring context here)
    const longest = Math.max(1, ...lines.map((l: string) => l.length))
    const w = Number(t.width) * Math.min(1, (lines[0]?.length ?? 0) / longest)
    const left = t.textAlign === 'center' ? t.x + (t.width - w) / 2 : t.textAlign === 'right' ? t.x + t.width - w : t.x
    return { x: left + w, y: t.y + lh / 2 }
  }
  const [x1, y1, x2] = getCommonBounds([el])
  return { x: x2, y: y1 }
}

/** These elements and what belongs to them - a shape's label, an arrow's label, a frame's children (Excalidraw's own
 *  selection export takes them too) */
function withAttached(all: readonly any[], ids: string[]): any[] {
  const want = new Set(ids)
  for (const e of all) {
    if (want.has(e.id)) for (const b of e.boundElements ?? []) if (b?.type === 'text') want.add(b.id)
  }
  for (const e of all) {
    if (e.frameId && want.has(e.frameId)) want.add(e.id)
    if (e.type === 'text' && e.containerId && want.has(e.containerId)) want.add(e.id)
  }
  return all.filter((e) => want.has(e.id))
}
