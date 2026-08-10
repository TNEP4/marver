import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { tidy } from './tidy.ts'
// @ts-expect-error virtual module provided by the plugin
import shConfig from 'virtual:sh-config'

export interface FrameEntry { id: string; file: string; kind: 'tsx' | 'html'; scene: string; title?: string; viewport?: string }
export interface Manifest { frames: FrameEntry[]; scenes: { name: string; frames: number }[]; boards: string[] }
export interface Node {
  key: string; frame: string; x: number; y: number; w: number; h: number; theme: string
  status: 'loading' | 'ready' | 'error'; error?: string; missing?: boolean
}
export interface Toast { id: number; text: string }

export const CONFIG: { viewports: Record<string, { width: number; height: number }>; themes: string[]; noTheme: boolean } = shConfig

const HEADER = 28
let toastSeq = 0
const nodeKey = () => 'n_' + Math.random().toString(36).slice(2, 8)

export function frameUrl(frame: FrameEntry, theme: string): string {
  return frame.kind === 'html'
    ? `/${frame.file}?theme=${theme}`
    : `${ROUTE}/frame/?id=${encodeURIComponent(frame.id)}&theme=${theme}`
}

function defaultSize(frame: FrameEntry) {
  const vp = CONFIG.viewports[frame.viewport ?? ''] ?? CONFIG.viewports.mobile ?? { width: 390, height: 844 }
  return { w: vp.width, h: vp.height }
}

interface State {
  manifest: Manifest | null
  nodes: Node[]                       // append-only order; NEVER sorted or reordered (iframe law G-1)
  selection: string[]                 // ordered; last entry is the primary (bar anchor)
  interact: string | null
  gesture: boolean                    // a frame drag/resize is in progress - canvas panning is disabled
  board: string                       // active board name; 'everything' is the auto board
  boardAuto: boolean                  // auto boards gain new frames on arrival; curated boards never do
  deviceView: string | null           // board-wide device preview (viewport name), null = free-form layout
  baseLayout: Record<string, { x: number; y: number; w: number; h: number }> | null   // snapshot taken on entering a device view; Default restores it exactly
  panelOpen: boolean
  scale: number
  toasts: Toast[]
  boardHash: string | null            // sha256 of everything.json on disk, when materialized
  dirty: boolean

  boot(): Promise<void>
  applyManifest(m: Manifest): void
  frameFor(node: Node): FrameEntry | undefined
  moveNode(key: string, x: number, y: number): void
  resizeNode(key: string, w: number, h: number): void
  setStatus(key: string, status: Node['status'], error?: string): void
  removeNode(key: string): void
  select(key: string | null, additive?: boolean): void
  setInteract(key: string | null): void
  setGesture(g: boolean): void
  setDeviceView(name: string | null): void
  resizeSelected(name: string | null): void
  switchBoard(name: string): Promise<void>
  setScale(s: number): void
  togglePanel(): void
  setTheme(theme: string): void
  runTidy(): void
  toast(text: string): void
  spawn(frameId: string): Node | null
  save(): void
}

export const useStore = create<State>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => get().save(), 500) }

  return {
    manifest: null, nodes: [], selection: [], interact: null, gesture: false, board: 'everything', boardAuto: true, deviceView: null, baseLayout: null,
    panelOpen: true, scale: 1, toasts: [], boardHash: null, dirty: false,

    async boot() {
      const raw = await fetch('/design/manifest.json').then((r) => r.json()).catch(() => null)
      // Malformed manifest fails soft: an empty canvas with a working shell beats a white screen.
      const manifest: Manifest = {
        frames: Array.isArray(raw?.frames) ? raw.frames : [],
        scenes: Array.isArray(raw?.scenes) ? raw.scenes : [],
        boards: Array.isArray(raw?.boards) ? raw.boards : [],
      }
      const boardName = get().board
      let nodes: Node[] = []
      let boardHash: string | null = null
      let boardAuto = boardName === 'everything'
      let deviceView: string | null = null
      let baseLayout: State['baseLayout'] = null
      let needTidy = false
      try {
        const res = await fetch(`${ROUTE}/api/boards/${boardName}`)
        if (res.ok) {
          const { board, sha256 } = await res.json()
          boardHash = sha256
          if (typeof board?.auto === 'boolean') boardAuto = board.auto
          // Agent-authored boards may be just a frame list - fill sizes/keys, tidy on first load.
          // Board nodes whose file is gone stay, flagged - deletion is surfaced, never silent (spec §7).
          nodes = (Array.isArray(board?.nodes) ? board.nodes : [])
            .filter((n: any) => n && typeof n.frame === 'string')
            .map((n: any) => {
              const f = manifest.frames.find((x) => x.id === n.frame)
              const d = f ? defaultSize(f) : { w: 390, h: 844 }
              if (typeof n.x !== 'number' || typeof n.y !== 'number') needTidy = true
              return {
                key: typeof n.key === 'string' ? n.key : nodeKey(),
                frame: n.frame,
                x: typeof n.x === 'number' ? n.x : 0, y: typeof n.y === 'number' ? n.y : 0,
                w: typeof n.w === 'number' ? n.w : d.w, h: typeof n.h === 'number' ? n.h : d.h,
                theme: typeof n.theme === 'string' ? n.theme : (CONFIG.themes[0] ?? 'light'),
                status: 'loading' as const,
                missing: !manifest.frames.some((f2) => f2.id === n.frame),
              }
            })
          // a device view in progress survives reloads - snapshot and all
          if (typeof board?.deviceView === 'string' && CONFIG.viewports[board.deviceView]) {
            deviceView = board.deviceView
            if (board.baseLayout && typeof board.baseLayout === 'object') baseLayout = board.baseLayout
          }
        }
      } catch { /* virtual board */ }
      // frames not on the board yet → auto boards only (a curated board shows exactly its list)
      if (boardAuto) {
        const placed = new Set(nodes.map((n) => n.frame))
        for (const f of manifest.frames) {
          if (placed.has(f.id)) continue
          const { w, h } = defaultSize(f)
          nodes.push({ key: nodeKey(), frame: f.id, x: 0, y: 0, w, h, theme: CONFIG.themes[0] ?? 'light', status: 'loading' })
        }
      }
      if ((!boardHash || needTidy) && nodes.length) {
        const sceneOf = (id: string) => manifest.frames.find((f) => f.id === id)?.scene ?? ''
        const placedAll = tidy(nodes.map((n) => ({ key: n.key, scene: sceneOf(n.frame), w: n.w, h: n.h + HEADER })))
        for (const p of placedAll) { const n = nodes.find((x) => x.key === p.key)!; n.x = p.x; n.y = p.y }
      }
      set({ manifest, nodes, boardHash, boardAuto, deviceView, baseLayout, selection: [] })
    },

    async switchBoard(name) {
      const { dirty, save, board } = get()
      if (name === board) return
      if (dirty) await save()                       // flush pending layout to the old board first
      set({ board: name, selection: [], interact: null, deviceView: null, baseLayout: null, boardHash: null, nodes: [] })
      await get().boot()
    },

    applyManifest(m) {
      const { nodes, toast, boardAuto } = get()
      const known = new Set(nodes.map((n) => n.frame))
      const next = [...nodes]
      let changed = false
      for (const f of m.frames) {
        if (!boardAuto) break                        // curated boards never auto-gain frames
        if (known.has(f.id)) continue
        const { w, h } = defaultSize(f)
        const maxY = next.reduce((a, n) => Math.max(a, n.y + n.h), 0)
        next.push({ key: nodeKey(), frame: f.id, x: 0, y: maxY + 96, w, h, theme: CONFIG.themes[0] ?? 'light', status: 'loading' })
        toast(`agent added ${f.id}`)
        changed = true
      }
      const live = new Set(m.frames.map((f) => f.id))
      for (const n of next) {
        const missing = !live.has(n.frame)
        if (missing !== !!n.missing) { n.missing = missing; changed = true }
      }
      set({ manifest: m, nodes: next, ...(changed ? { dirty: true } : {}) })
      if (changed) scheduleSave()
    },

    removeNode(key) {
      set((s) => ({ nodes: s.nodes.filter((n) => n.key !== key), dirty: true }))
      scheduleSave()
    },

    frameFor(node) { return get().manifest?.frames.find((f) => f.id === node.frame) },

    moveNode(key, x, y) {
      set((s) => ({ nodes: s.nodes.map((n) => (n.key === key ? { ...n, x, y } : n)), dirty: true }))
      scheduleSave()
    },
    resizeNode(key, w, h) {
      // a manual resize means the board no longer uniformly shows one device; the resized
      // frame's snapshot entry follows the user's new size so Default will not undo it
      set((s) => {
        const W = Math.max(120, w), H = Math.max(80, h)
        const cur = s.nodes.find((n) => n.key === key)
        return {
          nodes: s.nodes.map((n) => (n.key === key ? { ...n, w: W, h: H } : n)),
          dirty: true,
          deviceView: null,
          baseLayout: s.baseLayout && cur
            ? { ...s.baseLayout, [key]: { ...(s.baseLayout[key] ?? { x: cur.x, y: cur.y }), w: W, h: H } }
            : s.baseLayout,
        }
      })
      scheduleSave()
    },
    setDeviceView(name) {
      const vp = name ? CONFIG.viewports[name] : null
      if (name && !vp) return
      set((s) => {
        // entering a device view from free-form: snapshot the layout so Default restores it
        const baseLayout = name
          ? (s.deviceView === null
              ? Object.fromEntries(s.nodes.map((n) => [n.key, { x: n.x, y: n.y, w: n.w, h: n.h }]))
              : s.baseLayout)
          : null
        const nodes = s.nodes.map((n) => {
          if (vp) return { ...n, w: vp.width, h: vp.height }
          const b = s.baseLayout?.[n.key]
          if (b) return { ...n, ...b }               // exact free-form layout, positions included
          const f = s.manifest?.frames.find((x) => x.id === n.frame)
          if (!f) return n
          const d = defaultSize(f)                   // frames added mid-device-view get their default
          return { ...n, w: d.w, h: d.h }
        })
        return { deviceView: name, dirty: true, baseLayout, nodes }
      })
      if (name) get().runTidy()                      // restore must NOT tidy - it would destroy positions
      else scheduleSave()
    },
    setStatus(key, status, error) {
      set((s) => ({ nodes: s.nodes.map((n) => (n.key === key ? { ...n, status, error } : n)) }))
    },
    // plain select replaces; additive toggles membership. Interact survives only while its
    // frame stays selected.
    select(key, additive = false) {
      set((s) => {
        const selection = key == null
          ? []
          : additive
            ? (s.selection.includes(key) ? s.selection.filter((k) => k !== key) : [...s.selection, key])
            : [key]
        return { selection, interact: s.interact && selection.includes(s.interact) ? s.interact : null }
      })
    },
    // scoped device sizing: only the selected frames change; null restores their defaults.
    // Always followed by a tidy - a preset change must never scramble the layout.
    resizeSelected(name) {
      const vp = name ? CONFIG.viewports[name] : null
      if (name && !vp) return
      set((s) => {
        const sel = new Set(s.selection)
        const nodes = s.nodes.map((n) => {
          if (!sel.has(n.key)) return n
          if (vp) return { ...n, w: vp.width, h: vp.height }
          const f = s.manifest?.frames.find((x) => x.id === n.frame)
          if (!f) return n
          const d = defaultSize(f)
          return { ...n, w: d.w, h: d.h }
        })
        const baseLayout = s.baseLayout ? { ...s.baseLayout } : null
        if (baseLayout) for (const k of s.selection) {
          const n = nodes.find((x) => x.key === k)
          if (n) baseLayout[k] = { ...(baseLayout[k] ?? { x: n.x, y: n.y }), w: n.w, h: n.h }
        }
        return { nodes, dirty: true, deviceView: null, baseLayout }
      })
      get().runTidy()
    },
    setInteract(key) { set({ interact: key }) },
    setGesture(gesture) { set({ gesture }) },
    setScale(scale) { set({ scale }) },
    togglePanel() { set((s) => ({ panelOpen: !s.panelOpen })) },
    setTheme(theme) {
      set((s) => ({ nodes: s.nodes.map((n) => ({ ...n, theme })), dirty: true }))
      scheduleSave()
    },
    runTidy() {
      const { nodes, manifest } = get()
      const sceneOf = (id: string) => manifest?.frames.find((f) => f.id === id)?.scene ?? ''
      const placed = tidy(nodes.map((n) => ({ key: n.key, scene: sceneOf(n.frame), w: n.w, h: n.h + HEADER })))
      set((s) => ({
        nodes: s.nodes.map((n) => {
          const p = placed.find((x) => x.key === n.key)
          return p ? { ...n, x: p.x, y: p.y } : n
        }),
        dirty: true,
      }))
      scheduleSave()
    },
    toast(text) {
      const id = ++toastSeq
      set((s) => ({ toasts: [...s.toasts, { id, text }] }))
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000)
    },
    spawn(frameId) {
      const { manifest, nodes } = get()
      const f = manifest?.frames.find((x) => x.id === frameId)
      if (!f) return null
      const { w, h } = defaultSize(f)
      const maxX = nodes.reduce((a, n) => Math.max(a, n.x + n.w), 0)
      const node: Node = { key: nodeKey(), frame: f.id, x: maxX + 96, y: 0, w, h, theme: CONFIG.themes[0] ?? 'light', status: 'loading' }
      set((s) => ({ nodes: [...s.nodes, node], dirty: true }))
      scheduleSave()
      get().toast(`added ${f.id}`)
      return node
    },

    async save() {
      const { nodes, boardHash, deviceView, baseLayout, board: boardName, boardAuto } = get()
      // Missing nodes persist too - only the explicit remove button drops them (spec §7).
      const board = {
        version: 1, name: boardName, auto: boardAuto,
        // while a device view is active the free-form snapshot rides along on disk
        ...(deviceView && baseLayout ? { deviceView, baseLayout } : {}),
        nodes: nodes.map(({ key, frame, x, y, w, h, theme }) => ({ key, frame, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), theme })),
      }
      try {
        const res = await fetch(`${ROUTE}/api/boards/${boardName}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ board, baseHash: boardHash }),
        })
        if (res.status === 409) {
          const { sha256 } = await res.json()
          set({ boardHash: sha256 })
          get().toast('board changed on disk - canvas layout reloaded')
          await get().boot()
          return
        }
        if (res.ok) set({ boardHash: (await res.json()).sha256, dirty: false })
      } catch { /* dev server gone; keep local */ }
    },
  }
})
