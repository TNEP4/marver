import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { tidy } from './tidy.ts'
// @ts-expect-error virtual module provided by the plugin
import shConfig from 'virtual:sh-config'
// @ts-expect-error virtual module: null in dev; a published build inlines manifest+boards
import shData from 'virtual:sh-data'

/** Published-build data. Non-null = static site: no API, no saves, no live events.
 *  `names` is the switcher list (all-scenes only when actually published); `default`
 *  is where `/` opens - never a synthesized aggregate of a filtered build. */
const DATA: { manifest: Manifest; boards: Record<string, unknown>; names: string[]; default: string } | null = shData

export interface FrameEntry { id: string; file: string; kind: 'tsx' | 'html'; scene: string; title?: string; viewport?: string; theme?: string }
export interface Manifest { frames: FrameEntry[]; scenes: { name: string; frames: number }[] }
export interface Node {
  key: string; frame: string; x: number; y: number; w: number; h: number
  /** RESOLVED theme (what renders): themeUser ?? frame meta.theme ?? viewTheme. */
  theme: string
  /** Explicit per-frame override, set by scoped theme actions; cleared by a global set.
   *  The only theme value that persists into the board file. */
  themeUser?: string
  status: 'loading' | 'ready' | 'error'; error?: string; missing?: boolean
}
export interface Toast { id: number; text: string }

export const CONFIG: { viewports: Record<string, { width: number; height: number }>; themes: string[]; zoomSpeed?: number; noTheme: boolean } = shConfig

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Board names for switchers: all-scenes first, the rest sorted. Throws on transport
 *  failure - callers keep their last known list. */
export async function fetchBoardNames(): Promise<string[]> {
  if (DATA) return DATA.names
  const list: { name: string }[] = await (await fetch(`${ROUTE}/api/boards`)).json()
  return ['all-scenes', ...list.map((b) => b.name).filter((n) => n !== 'all-scenes').sort()]
}
/** Display name for a board: the reserved 'all-scenes' key reads as "All scenes". */
export const boardLabel = (n: string) => (n === 'all-scenes' ? 'All scenes' : cap(n))

const HEADER = 28
let toastSeq = 0
const nodeKey = () => 'n_' + Math.random().toString(36).slice(2, 8)

export function frameUrl(frame: FrameEntry, theme: string): string {
  return frame.kind === 'html'
    ? `/${frame.file}?theme=${theme}`
    : `${ROUTE}/frame/?id=${encodeURIComponent(frame.id)}&theme=${theme}`
}

/** The global view theme: the user's sticky preference, applied across boards and
 *  reloads. Frames resolve to it unless they declare meta.theme or carry a user pin. */
const initialViewTheme = () => {
  try {
    const t = localStorage.getItem('mv-view-theme')
    if (t && CONFIG.themes.includes(t)) return t
  } catch { /* storage unavailable */ }
  return CONFIG.themes[0] ?? 'light'
}
const manifestKey = (m: Manifest) => JSON.stringify(m.frames)   // any change counts, not just added/removed ids

function defaultSize(frame: FrameEntry) {
  const vp = CONFIG.viewports[frame.viewport ?? ''] ?? CONFIG.viewports.mobile ?? { width: 390, height: 844 }
  return { w: vp.width, h: vp.height }
}

interface State {
  manifest: Manifest | null
  nodes: Node[]                       // append-only order; NEVER sorted or reordered (iframe law G-1)
  selection: string[]                 // ordered; last entry is the primary (bar anchor)
  interact: string | null
  viewTheme: string                   // the global theme preference; sticky across boards and reloads
  play: { at: string; device: string; theme: string } | null   // play mode (SPEC-M2 §1); at = current frame id
  gesture: boolean                    // a frame drag/resize is in progress - canvas panning is disabled
  board: string                       // active board name; 'all-scenes' is the auto board
  boardAuto: boolean                  // auto boards gain new frames on arrival; curated boards never do
  deviceView: string | null           // board-wide device preview (viewport name), null = free-form layout
  baseLayout: Record<string, { x: number; y: number; w: number; h: number }> | null   // snapshot taken on entering a device view; Default restores it exactly
  panelOpen: boolean
  scale: number
  toasts: Toast[]
  boardHash: string | null            // sha256 of the board file on disk, when materialized
  dirty: boolean

  boot(): Promise<boolean>
  applyManifest(m: Manifest): void
  frameFor(node: Node): FrameEntry | undefined
  moveNode(key: string, x: number, y: number): void
  resizeNode(key: string, w: number, h: number): void
  setStatus(key: string, status: Node['status'], error?: string): void
  removeNode(key: string): void
  select(key: string | null, additive?: boolean): void
  selectAll(): void
  setInteract(key: string | null): void
  setPlay(p: State['play']): void
  setGesture(g: boolean): void
  moveSelectedBy(dx: number, dy: number, starts: Record<string, { x: number; y: number }>): void
  setSelectedTheme(theme: string): void
  setDeviceView(name: string | null): void
  resizeSelected(name: string | null): void
  switchBoard(name: string): Promise<void>
  setScale(s: number): void
  togglePanel(): void
  setTheme(theme: string): void
  runTidy(): void
  toast(text: string): void
  spawn(frameId: string): Node | null
  save(): Promise<boolean>
}

export const useStore = create<State>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveChain: Promise<boolean> = Promise.resolve(true)   // saves are serialized; responses only commit if the board is still active
  let editRev = 0                                    // bumps per edit; a stale save response may never clear dirty over a newer edit
  let loadSeq = 0                                    // stale boot() responses never overwrite a newer board
  let switchSeq = 0                                  // last click wins when board switches race
  const scheduleSave = () => { editRev++; clearTimeout(saveTimer); saveTimer = setTimeout(() => get().save(), 500) }

  /** Theme resolution ladder: user pin > the frame's declared meta.theme > viewTheme. */
  const resolveTheme = (frame?: FrameEntry, user?: string) => user ?? frame?.theme ?? get().viewTheme

  /** Fetch + normalize a board into ready-to-commit state, WITHOUT touching the store.
   *  null = failure (transport, malformed manifest, non-404 board error) - the caller
   *  keeps whatever board is currently mounted. */
  const loadBoardState = async (boardName: string): Promise<Partial<State> | null> => {
    try {
      let raw: any
      if (DATA) raw = DATA.manifest
      else {
        const mRes = await fetch('/design/manifest.json')
        if (!mRes.ok) return null
        raw = await mRes.json().catch(() => undefined)
      }
      if (raw === undefined || raw === null || typeof raw !== 'object') return null
      const manifest: Manifest = {
        frames: (Array.isArray(raw?.frames) ? raw.frames : [])
          .filter((f: any) => f && typeof f.id === 'string' && typeof f.file === 'string'),
        scenes: Array.isArray(raw?.scenes) ? raw.scenes : [],
      }
      let nodes: Node[] = []
      let boardHash: string | null = null
      let boardAuto = boardName === 'all-scenes'
      let deviceView: string | null = null
      let baseLayout: State['baseLayout'] = null
      let needTidy = false
      // published build: boards come from the inlined data; absent = fresh (the 404 path)
      let loaded: { board: any; sha256: string } | 'fresh' | null
      if (DATA) loaded = DATA.boards[boardName] ? { board: DATA.boards[boardName], sha256: 'published' } : 'fresh'
      else {
        const res = await fetch(`${ROUTE}/api/boards/${boardName}`)
        if (res.ok) loaded = await res.json()
        else if (res.status === 404) loaded = 'fresh'
        else loaded = null                     // only 404 means "fresh board"; anything else must not commit an empty canvas
      }
      if (loaded === null) return null
      if (loaded !== 'fresh') {
        const { board, sha256 } = loaded
        boardHash = sha256
        if (typeof board?.auto === 'boolean') boardAuto = board.auto
        // Agent-authored boards may be just a frame list - fill sizes/keys, tidy on first load.
        // Keys are load-bearing (iframe identity, selection) - dupes/blanks get reminted.
        // Board nodes whose file is gone stay, flagged - deletion is surfaced, never silent (spec §7).
        const seenKeys = new Set<string>()
        nodes = (Array.isArray(board?.nodes) ? board.nodes : [])
          .filter((n: any) => n && typeof n.frame === 'string')
          .map((n: any) => {
            const f = manifest.frames.find((x) => x.id === n.frame)
            const d = f ? defaultSize(f) : { w: 390, h: 844 }
            if (typeof n.x !== 'number' || typeof n.y !== 'number') needTidy = true
            let key = typeof n.key === 'string' && n.key ? n.key : nodeKey()
            if (seenKeys.has(key)) key = nodeKey()
            seenKeys.add(key)
            return {
              key,
              frame: n.frame,
              x: typeof n.x === 'number' ? n.x : 0, y: typeof n.y === 'number' ? n.y : 0,
              w: typeof n.w === 'number' ? n.w : d.w, h: typeof n.h === 'number' ? n.h : d.h,
              // pins persist as their own field (exact round-trip). Legacy boards stored a
              // theme on EVERY node: only values differing from the frame's static default
              // were deliberate - the rest follow viewTheme
              ...(() => {
                const stored = typeof n.theme === 'string' ? n.theme : undefined
                const themeUser = typeof n.themeUser === 'string' && CONFIG.themes.includes(n.themeUser)
                  ? n.themeUser
                  : stored && stored !== (f?.theme ?? CONFIG.themes[0] ?? 'light') ? stored : undefined
                return { theme: resolveTheme(f, themeUser), themeUser }
              })(),
              status: 'loading' as const,
              missing: !manifest.frames.some((f2) => f2.id === n.frame),
            }
          })
        // device view and the free-form snapshot survive reloads - independently:
        // a scoped "exception" clears deviceView but the snapshot must keep restoring
        if (typeof board?.deviceView === 'string' && CONFIG.viewports[board.deviceView]) deviceView = board.deviceView
        if (board?.baseLayout && typeof board.baseLayout === 'object') baseLayout = board.baseLayout
      }
      // frames not on the board yet → auto boards only (a curated board shows exactly its list)
      if (boardAuto) {
        const placed = new Set(nodes.map((n) => n.frame))
        for (const f of manifest.frames) {
          if (placed.has(f.id)) continue
          placed.add(f.id)
          const d = defaultSize(f)
          const vp = deviceView ? CONFIG.viewports[deviceView] : null
          nodes.push({ key: nodeKey(), frame: f.id, x: 0, y: 0, w: vp?.width ?? d.w, h: vp?.height ?? d.h, theme: resolveTheme(f), status: 'loading' })
        }
      }
      if ((!boardHash || needTidy) && nodes.length) {
        const sceneOf = (id: string) => manifest.frames.find((f) => f.id === id)?.scene ?? ''
        const placedAll = tidy(nodes.map((n) => ({ key: n.key, scene: sceneOf(n.frame), w: n.w, h: n.h + HEADER })))
        for (const pl of placedAll) { const n = nodes.find((x) => x.key === pl.key)!; n.x = pl.x; n.y = pl.y }
      }
      // dirty: false - the committed state matches disk by construction
      return { manifest, nodes, boardHash, boardAuto, deviceView, baseLayout, selection: [], dirty: false }
    } catch { return null }
  }

  return {
    manifest: null, nodes: [], selection: [], interact: null, viewTheme: initialViewTheme(), play: null, gesture: false,
    board: DATA?.default ?? 'all-scenes', boardAuto: (DATA?.default ?? 'all-scenes') === 'all-scenes', deviceView: null, baseLayout: null,
    panelOpen: true, scale: 1, toasts: [], boardHash: null, dirty: false,

    async boot() {
      const seq = ++loadSeq
      const boardName = get().board
      const revAtStart = editRev
      const next = await loadBoardState(boardName)
      if (seq !== loadSeq) return false        // a newer load superseded this one
      if (!next) { get().toast(`board "${boardName}" failed to load`); return false }
      // the user kept editing while we fetched - their newer state wins over the reload
      if (get().board !== boardName || editRev !== revAtStart) return false
      const live = get().manifest             // a WS manifest update may have landed mid-fetch
      set(next)
      if (live && manifestKey(live) !== manifestKey(next.manifest as Manifest)) get().applyManifest(live)
      return true
    },

    async switchBoard(name) {
      const mySwitch = ++switchSeq             // also cancels any pending switch (incl. re-clicking the current board)
      if (name === get().board) return
      // flush loop: an edit landing mid-save keeps dirty set and gets its own pass
      let ok = true
      for (let i = 0; i < 5 && get().dirty && ok; i++) { clearTimeout(saveTimer); ok = await get().save() }
      if (mySwitch !== switchSeq) return
      if (get().dirty) { get().toast('current board could not be saved - staying here'); return }
      // load the target while the current board stays mounted; commit atomically on success -
      // there is never an empty intermediate state and nothing to roll back
      const next = await loadBoardState(name)
      if (mySwitch !== switchSeq) return
      if (!next) { get().toast(`could not load "${name}" - staying on ${get().board}`); return }
      // edits may have landed on the still-mounted old board during the target load
      for (let i = 0; i < 5 && get().dirty && ok; i++) { clearTimeout(saveTimer); ok = await get().save() }
      if (mySwitch !== switchSeq) return
      if (get().dirty) { get().toast('current board could not be saved - staying here'); return }
      clearTimeout(saveTimer)                  // a scheduled-but-clean timer must not fire against the new board
      ++loadSeq                                // invalidate any in-flight boot of the old board
      const live = get().manifest              // a WS manifest update may have landed mid-load
      set({ board: name, interact: null, ...next })
      if (live && manifestKey(live) !== manifestKey(next.manifest as Manifest)) get().applyManifest(live)
    },

    applyManifest(m) {
      const { nodes, toast, boardAuto } = get()
      const known = new Set(nodes.map((n) => n.frame))
      const next = [...nodes]
      let changed = false
      const { deviceView, baseLayout } = get()
      const vp = deviceView ? CONFIG.viewports[deviceView] : null
      let nextBase = baseLayout
      for (const f of m.frames) {
        if (!boardAuto) break                        // curated boards never auto-gain frames
        if (known.has(f.id)) continue
        const d = defaultSize(f)
        const maxY = next.reduce((a, n) => Math.max(a, n.y + n.h), 0)
        const node = { key: nodeKey(), frame: f.id, x: 0, y: maxY + 96, w: vp?.width ?? d.w, h: vp?.height ?? d.h, theme: resolveTheme(f), status: 'loading' as const }
        next.push(node)
        // in a device view, the snapshot learns the newcomer's DEFAULT size so 0 restores it sanely
        if (vp && nextBase) nextBase = { ...nextBase, [node.key]: { x: node.x, y: node.y, w: d.w, h: d.h } }
        toast(`agent added ${f.id}`)
        changed = true
      }
      const live = new Set(m.frames.map((f) => f.id))
      let retinted = false
      for (const n of next) {
        const missing = !live.has(n.frame)
        if (missing !== !!n.missing) { n.missing = missing; changed = true }
        // a frame's declared meta.theme may have changed - re-resolve unpinned nodes
        // (derived value: re-render yes, dirty/save no)
        const f = m.frames.find((x) => x.id === n.frame)
        const want = n.themeUser ?? f?.theme ?? get().viewTheme
        if (n.theme !== want) { n.theme = want; retinted = true }
      }
      set({ manifest: m, nodes: changed || retinted ? [...next] : next, ...(changed ? { dirty: true, baseLayout: nextBase } : {}) })
      if (changed) scheduleSave()
    },

    removeNode(key) {
      set((s) => ({
        nodes: s.nodes.filter((n) => n.key !== key),
        selection: s.selection.filter((k) => k !== key),
        interact: s.interact === key ? null : s.interact,
        dirty: true,
      }))
      scheduleSave()
    },

    frameFor(node) { return get().manifest?.frames.find((f) => f.id === node.frame) },

    moveNode(key, x, y) {
      set((s) => ({ nodes: s.nodes.map((n) => (n.key === key ? { ...n, x, y } : n)), dirty: true }))
      scheduleSave()
    },
    // group drag: every selected node moves by the same delta from its gesture-start position
    moveSelectedBy(dx, dy, starts) {
      set((s) => ({
        nodes: s.nodes.map((n) => (starts[n.key] ? { ...n, x: starts[n.key].x + dx, y: starts[n.key].y + dy } : n)),
        dirty: true,
      }))
      scheduleSave()
    },
    // scoped theme = an explicit per-frame PIN; it survives board reloads and yields
    // only to the next global set
    setSelectedTheme(theme) {
      set((s) => {
        const sel = new Set(s.selection)
        return { nodes: s.nodes.map((n) => (sel.has(n.key) ? { ...n, theme, themeUser: theme } : n)), dirty: true }
      })
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
    selectAll() {
      set((s) => ({ selection: s.nodes.map((n) => n.key) }))
    },
    // interact is a ONE-frame mode: entering it collapses any multi-selection to the
    // interacted frame (a 4-frame selection double-clicked otherwise leaves all four
    // painted as "interactive"). Exiting keeps the frame selected for continuity.
    setInteract(key) { set((s) => ({ interact: key, selection: key ? [key] : s.selection })) },
    setPlay(play) { set({ play }) },
    setGesture(gesture) { set({ gesture }) },
    setScale(scale) { set({ scale }) },
    togglePanel() { set((s) => ({ panelOpen: !s.panelOpen })) },
    // global theme = the VIEW preference: persists across boards + reloads, clears
    // per-frame pins. Frames declaring meta.theme keep their mode (they only work there).
    setTheme(theme) {
      try { localStorage.setItem('mv-view-theme', theme) } catch { /* storage unavailable */ }
      set((s) => ({
        viewTheme: theme,
        nodes: s.nodes.map((n) => {
          const f = s.manifest?.frames.find((x) => x.id === n.frame)
          return { ...n, themeUser: undefined, theme: f?.theme ?? theme }
        }),
        dirty: true,
      }))
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
      const { manifest, nodes, deviceView, baseLayout } = get()
      const f = manifest?.frames.find((x) => x.id === frameId)
      if (!f) return null
      const d = defaultSize(f)
      const vp = deviceView ? CONFIG.viewports[deviceView] : null
      const maxX = nodes.reduce((a, n) => Math.max(a, n.x + n.w), 0)
      const node: Node = { key: nodeKey(), frame: f.id, x: maxX + 96, y: 0, w: vp?.width ?? d.w, h: vp?.height ?? d.h, theme: resolveTheme(f), status: 'loading' }
      set((s) => ({
        nodes: [...s.nodes, node],
        dirty: true,
        ...(vp && baseLayout ? { baseLayout: { ...baseLayout, [node.key]: { x: node.x, y: node.y, w: d.w, h: d.h } } } : {}),
      }))
      scheduleSave()
      get().toast(`added ${f.id}`)
      return node
    },

    save() {
      // a published canvas is read-only by design (spec §12): edits are ephemeral, and
      // dirty must clear or switchBoard's save-flush loop wedges forever
      if (DATA) { set({ dirty: false }); return Promise.resolve(true) }
      const p = saveChain.then(async () => {
        const rev = editRev
        const { nodes, boardHash, deviceView, baseLayout, board: boardName, boardAuto } = get()
        // Missing nodes persist too - only the explicit remove button drops them (spec §7).
        const board = {
          version: 1, name: boardName, auto: boardAuto,
          // deviceView and the free-form snapshot persist independently: a scoped
          // exception clears the view but 0 must still restore the snapshot after reload
          ...(deviceView ? { deviceView } : {}),
          ...(baseLayout ? { baseLayout } : {}),
          // only PINNED themes persist - inherited values follow viewTheme at load time
          nodes: nodes.map(({ key, frame, x, y, w, h, themeUser }) => ({ key, frame, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), ...(themeUser ? { themeUser } : {}) })),
        }
        try {
          const res = await fetch(`${ROUTE}/api/boards/${boardName}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ board, baseHash: boardHash }),
          })
          if (get().board !== boardName) return true   // switched boards mid-flight; stale response must not touch state
          if (res.status === 409) {
            const reloaded = await get().boot()   // hash advances only when the authoritative reload commits
            if (reloaded) get().toast('board changed on disk - canvas layout reloaded')
            return reloaded   // false keeps dirty set; the next debounce retries once edits settle
          }
          if (res.ok) {
            const { sha256 } = await res.json()
            // an edit that landed after this save started keeps dirty set for the next save
            set({ boardHash: sha256, ...(editRev === rev ? { dirty: false } : {}) })
            return true
          }
          return false
        } catch { return false /* dev server gone; edits stay local and dirty */ }
      })
      saveChain = p
      return p
    },
  }
})
