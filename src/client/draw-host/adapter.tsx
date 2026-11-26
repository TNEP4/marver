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
import { Excalidraw, CaptureUpdateAction, reconcileElements, restoreElements, exportToBlob, exportToSvg, getSceneVersion, getCommonBounds } from '@excalidraw/excalidraw'
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
  exportPng(dark: boolean): Promise<Blob>
  exportSvg(dark: boolean): Promise<string>
  /** re-render every element canvas at the current pixel ratio (after a crispness change) */
  rerender(): void
  insertImage(): void
}

const CU = CaptureUpdateAction
const GRAB_KEY = 'F19'

export function DrawEngine({ initial, theme, edit, editable, onReady, onChange, onPointerDown, onPointerUp }: {
  initial: { elements: DrawElement[]; files?: Record<string, unknown>; view?: { x: number; y: number; zoom: number } | null; background?: string }
  theme: 'light' | 'dark'
  edit: boolean
  editable: boolean
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
    async exportPng(dark) {
      const api = apiRef.current
      return exportToBlob({
        elements: api.getSceneElements(), files: api.getFiles(), mimeType: 'image/png', exportPadding: 24,
        appState: { exportBackground: true, viewBackgroundColor: dark ? '#121212' : '#ffffff', exportWithDarkMode: dark, exportScale: 2 },
      } as any)
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

  return (
    <div className={`mv-draw ${edit ? 'mv-edit' : 'mv-view'}`} style={{ position: 'absolute', inset: 0 }}>
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
        viewModeEnabled={!edit || !editable}
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
