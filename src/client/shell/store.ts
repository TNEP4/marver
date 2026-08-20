import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { tidy, parseLayout, type BoardLayout } from './tidy.ts'
import { stableNodeKey } from './keys.ts'
// @ts-expect-error virtual module provided by the plugin
import shConfig from 'virtual:sh-config'
// @ts-expect-error virtual module: null in dev; a published build inlines manifest+boards
import shData from 'virtual:sh-data'

/** Published-build data. Non-null = static site: no API, no saves, no live events.
 *  `names` is the switcher list (all-scenes only when actually published); `default`
 *  is where `/` opens - never a synthesized aggregate of a filtered build. */
const DATA: { manifest: Manifest; boards: Record<string, unknown>; names: string[]; default: string } | null = shData

/** True on a published static canvas - no dev server, no API, no update checks. */
export const PUBLISHED = DATA !== null

export interface FrameEntry { id: string; file: string; kind: 'tsx' | 'html'; scene: string; title?: string; viewport?: string; theme?: string; variantGroup?: string; variant?: string; intent?: string; contentWidth?: number }
export interface Manifest { frames: FrameEntry[]; scenes: { name: string; frames: number }[] }
export interface Node {
  key: string; frame: string; x: number; y: number; w: number; h: number
  /** RESOLVED theme (what renders): themeUser ?? frame meta.theme ?? viewTheme. */
  theme: string
  /** Renavigation nonce: bumped when the shell wants this iframe on a FRESH URL
   *  (errored frame whose file is back in the manifest). Never persisted. */
  nav?: number
  /** Explicit per-frame override, set by scoped theme actions; cleared by a global set.
   *  The only theme value that persists into the board file. */
  themeUser?: string
  /** Size provenance for CONTENT frames, explicit: 'auto' = measured
   *  (transient - never serialized); 'manual' = the human's - measurements never
   *  overwrite; 'device' = a preset's. UI frames never carry it. Only manual/device
   *  persist, so a reload can tell an authored size from a measured one. */
  sizeMode?: 'auto' | 'manual' | 'device'
  /** Transient (never serialized): this node was sized by the 390x844 GUESS because its
   *  frame was not in the manifest yet AND its file carried no w/h (the create-first
   *  choreography's append-before-scan race). applyManifest corrects ONLY these when the
   *  frame arrives - an authored size on a temporarily-missing frame is never touched. */
  sizeFallback?: boolean
  status: 'loading' | 'ready' | 'error'; error?: string; missing?: boolean
}
/** A Live Jam notification: a persistent bottom-right glass pill for a Marver
 *  reply. Frame-first: the FRAME is the news (icon + title, blue), Marver + preview below. */
export interface JamNote { threadId: string; board: string; preview: string; ts: number; frame?: string; frameTitle?: string; intent?: string }
export interface Toast { id: number; text: string; jam?: JamNote }

export const CONFIG: { viewports: Record<string, { width: number; height: number }>; themes: string[]; zoomSpeed?: number; noTheme: boolean; setup?: boolean; projectName?: string } = shConfig

export { cap, humanize } from './labels.ts'
import { cap, humanize } from './labels.ts'

/** Board names for switchers: the agent's curated boards FIRST (ranked by each board's `order`, then
 *  name), and the auto `all-scenes` everything-board LAST - it is the expensive one, never the landing.
 *  Throws on transport failure - callers keep their last known list. */
export async function fetchBoardNames(): Promise<string[]> {
  if (DATA) return DATA.names
  const list: { name: string; order?: number }[] = await (await fetch(`${ROUTE}/api/boards`)).json()
  const curated = list
    .filter((b) => b.name !== 'all-scenes')
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name))
    .map((b) => b.name)
  return [...curated, 'all-scenes']
}
/** Display name for a board: the reserved 'all-scenes' key reads as "All scenes". */
export const boardLabel = (n: string) => humanize(n)

/** The frames a board pins, straight from its file (dev fetch / published inline) -
 *  membership only, never a load. Cross-board data-goto asks "which board shows this
 *  frame?" without touching the live board state. */
export async function boardFrames(name: string): Promise<string[]> {
  const board: any = DATA
    ? DATA.boards[name]
    : (await (await fetch(`${ROUTE}/api/boards/${name}`)).json())?.board
  return Array.isArray(board?.nodes)
    ? board.nodes.map((n: any) => (n && typeof n.frame === 'string' ? n.frame : '')).filter(Boolean)
    : []
}

const HEADER = 28
let toastSeq = 0
const nodeKey = () => 'n_' + Math.random().toString(36).slice(2, 8)

/** Manifest revision - bumps whenever a manifest lands (boot, switch, sh:manifest).
 *  Stamped into frame URLs so a changed frame set mints genuinely NEW iframe URLs:
 *  the browser can never revive a pre-change document from cache (friction log #20). */
let manifestRev = 0
export const bumpManifestRev = () => { manifestRev++ }

export function frameUrl(frame: FrameEntry, theme: string): string {
  return frame.kind === 'html'
    ? `/${frame.file}?theme=${theme}`
    : `${ROUTE}/frame/?id=${encodeURIComponent(frame.id)}&theme=${theme}&r=${manifestRev}`
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

/** Latest measured content heights, keyed frameId@width. TRANSIENT by design:
 * auto sizes are never serialized - a reload remeasures. */
const measuredHeights = new Map<string, number>()

function defaultSize(frame: FrameEntry) {
  // content frames: own width from Doc layout; height from the latest
  // measurement at that width, or a placeholder until sh:measure lands.
  // meta.viewport, when declared, wins - the existing precedence.
  if (frame.contentWidth && !frame.viewport) {
    const w = frame.contentWidth
    return { w, h: measuredHeights.get(`${frame.id}@${w}`) ?? Math.round(w * 0.75) }
  }
  const vp = CONFIG.viewports[frame.viewport ?? ''] ?? CONFIG.viewports.mobile ?? { width: 390, height: 844 }
  return { w: vp.width, h: vp.height }
}

let resizedInGesture = false

/** sceneRows is the legacy shorthand for a plain rows layout. */
const effectiveLayout = (layout: BoardLayout | null, sceneRows: string[][] | null): BoardLayout | undefined =>
  layout ?? (sceneRows?.length ? { rows: sceneRows.map((r) => [...r]) } : undefined)

const layoutWarn = (msg: string) => {
  console.warn('[marver layout]', msg)
  try { useStore.getState().toast(`layout: ${msg}`) } catch { /* store not ready during boot */ }
}


interface State {
  manifest: Manifest | null
  nodes: Node[]                       // append-only order; NEVER sorted or reordered (iframe law G-1)
  selection: string[]                 // ordered; last entry is the primary (bar anchor)
  interact: string | null
  viewTheme: string                   // the global theme preference; sticky across boards and reloads
  play: { at: string; device: string; theme: string } | null   // play mode; at = current frame id
  gesture: boolean                    // a frame drag/resize is in progress - canvas panning is disabled
  laser: boolean                      // laser/inspect mode: frames outline their structure
  board: string                       // active board name; 'all-scenes' is the auto board
  boardAuto: boolean                  // auto boards gain new frames on arrival; curated boards never do
  deviceView: string | null           // board-wide device preview (viewport name), null = free-form layout
  sceneRows: string[][] | null        // LEGACY scene arrangement; still round-trips through save
  layout: BoardLayout | null          // lane-flow recipe, parsed; wins over sceneRows when both exist
  layoutRaw: unknown                  // the author's layout VERBATIM - save round-trips this, never the parse
  baseLayout: Record<string, { x: number; y: number; w?: number; h?: number }> | null   // snapshot taken on entering a device view; Default restores it exactly (auto content entries carry positions only - their sizes are measured)
  panelOpen: boolean
  scale: number
  toasts: Toast[]
  boardHash: string | null            // sha256 of the board file on disk, when materialized
  dirty: boolean
  // A6/A7 controlled HMR (transient, never persisted): a frame the user is actively using
  // (interact/play target, mid-gesture, laser/comment engaged) is "leased" - a hot update to
  // it is DEFERRED (coalesced to the latest revision) until a safe point, so an agent edit
  // never yanks the user out of their flow.
  pendingFrameRevisions: Record<string, string>            // frameId -> latest deferred revision
  externalLeases: Record<string, { laser?: true; comment?: true }>   // nodeKey -> transient engagement
  playUpdateRevision: string | null                        // a revision arrived while play is open
  playNav: number                                          // bumps to reload the play stage on demand

  boot(): Promise<boolean>
  applyManifest(m: Manifest): void
  frameFor(node: Node): FrameEntry | undefined
  moveNode(key: string, x: number, y: number): void
  resizeNode(key: string, w: number, h: number): void
  measureNode(key: string, frameId: string, ownWidth: number, measuredWidth: number, height: number): void
  setStatus(key: string, status: Node['status'], error?: string): void
  removeNode(key: string): void
  select(key: string | null, additive?: boolean): void
  selectMany(keys: string[]): void
  selectAll(): void
  setInteract(key: string | null): void
  setPlay(p: State['play']): void
  setGesture(g: boolean): void
  setLaser(on: boolean): void
  invalidateFrames(frameIds: string[], revision: string): void
  setExternalLease(nodeKey: string, reason: 'laser' | 'comment', on: boolean): void
  flushFrameUpdates(frameIds?: string[]): void
  applyPlayUpdate(): void
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
  jamToast(note: JamNote): void
  dismissToast(id: number): void
  clearJamToasts(): void
  /** Frames Marver is editing right now (Live Jam presence) - drives the working glow. */
  working: string[]
  /** When each working frame's job started (ms epoch) - phases the animations so parallel
   *  frames never pulse in sync. */
  workingSince: Record<string, number>
  setWorking(frames: string[]): void
  spawn(frameId: string): Node | null
  save(): Promise<boolean>
}

/** A6: is any node of this frame in active use, so a hot update must DEFER? Frame-scoped -
 *  if the same frame is placed twice and one copy is active, both stay on the same revision. */
function frameIsLeased(frameId: string, s: State): boolean {
  return s.nodes.some((n) =>
    n.frame === frameId && n.status !== 'error' && (
      s.interact === n.key ||
      (s.gesture && s.selection.includes(n.key)) ||
      !!s.externalLeases[n.key]))
}

export const useStore = create<State>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveChain: Promise<boolean> = Promise.resolve(true)   // saves are serialized; responses only commit if the board is still active
  let editRev = 0                                    // bumps per edit; a stale save response may never clear dirty over a newer edit
  let loadSeq = 0                                    // stale boot() responses never overwrite a newer board
  let switchSeq = 0                                  // last click wins when board switches race
  const scheduleSave = () => { editRev++; clearTimeout(saveTimer); saveTimer = setTimeout(() => get().save(), 500) }

  // One cancelable, BOARD-SCOPED reflow after content measurements settle.
  // The captured board name is the generation guard - a debounce surviving a board
  // switch fires into a name check and dies, never touching the new board.
  let reflowTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleReflow = () => {
    const boardAt = get().board
    clearTimeout(reflowTimer)
    reflowTimer = setTimeout(() => {
      const s = get()
      if (s.board !== boardAt) return
      if (s.gesture) { scheduleReflow(); return }   // defer, never drop - retries after the drag
      if (s.layout || s.sceneRows?.length) s.runTidy()
    }, 400)
  }

  /** Theme resolution ladder: user pin > the frame's declared meta.theme > viewTheme. */
  const resolveTheme = (frame?: FrameEntry, user?: string) => user ?? frame?.theme ?? get().viewTheme

  /** Published builds are read-only on disk, so pins persist to sessionStorage instead -
   *  parity with dev within a visit (keyed by frame id: virtual boards mint node keys
   *  per load, frame ids are stable). */
  const sessionPins = {
    read(board: string): Record<string, string> {
      try { return JSON.parse(sessionStorage.getItem(`mv-pins-${board}`) ?? '{}') } catch { return {} }
    },
    write(board: string, nodes: Node[]) {
      try {
        const pins: Record<string, string> = {}
        for (const n of nodes) if (n.themeUser) pins[n.frame] = n.themeUser
        sessionStorage.setItem(`mv-pins-${board}`, JSON.stringify(pins))
      } catch { /* storage unavailable */ }
    },
  }

  /** Published parity for content-frame sizes: manual/device sizes persist
   *  to the session the same way theme pins do - a board switch or reload on a
   *  published canvas must not silently drop a hand-resized spec frame. Keys are
   *  frame#occurrence: node keys are minted per load on virtual boards, but the node
   *  ORDER round-trips (board file order / manifest order), so the ordinal is the
   *  stable identity - duplicates of one frame keep their individual sizes. */
  const sizeKey = (nodes: Node[], node: Node) =>
    `${node.frame}#${nodes.filter((n) => n.frame === node.frame).indexOf(node)}`
  const sessionSizes = {
    read(board: string): Record<string, { w: number; h: number; sizeMode: 'manual' | 'device' }> {
      try { return JSON.parse(sessionStorage.getItem(`mv-sizes-${board}`) ?? '{}') } catch { return {} }
    },
    write(board: string, nodes: Node[]) {
      try {
        const sizes: Record<string, { w: number; h: number; sizeMode: string }> = {}
        for (const n of nodes) if (n.sizeMode === 'manual' || n.sizeMode === 'device')
          sizes[sizeKey(nodes, n)] = { w: Math.round(n.w), h: Math.round(n.h), sizeMode: n.sizeMode }
        sessionStorage.setItem(`mv-sizes-${board}`, JSON.stringify(sizes))
      } catch { /* storage unavailable */ }
    },
  }

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
      bumpManifestRev()                        // fresh manifest → fresh iframe URLs
      const manifest: Manifest = {
        frames: (Array.isArray(raw?.frames) ? raw.frames : [])
          .filter((f: any) => f && typeof f.id === 'string' && typeof f.file === 'string'),
        scenes: Array.isArray(raw?.scenes) ? raw.scenes : [],
      }
      let nodes: Node[] = []
      let boardHash: string | null = null
      let boardAuto = boardName === 'all-scenes'
      let deviceView: string | null = null
      let sceneRows: string[][] | null = null
      let layout: BoardLayout | null = null
      let layoutRaw: unknown = undefined
      let baseLayout: State['baseLayout'] = null
      let needTidy = false
      // published build: boards come from the inlined data; absent = fresh (the 404 path)
      let loaded: { board: any; sha256: string } | 'fresh' | null
      if (DATA) loaded = DATA.boards[boardName] ? { board: DATA.boards[boardName], sha256: 'published' } : 'fresh'
      else {
        const res = await fetch(`${ROUTE}/api/boards/${boardName}`)
        if (res.ok) {
          const body = await res.json()
          loaded = body?.board == null ? 'fresh' : body   // board:null = not materialized yet
        }
        else if (res.status === 404) loaded = 'fresh'    // older servers still 404 fresh boards
        else loaded = null                     // anything else must not commit an empty canvas
      }
      if (loaded === null) return null
      if (loaded !== 'fresh') {
        const { board, sha256 } = loaded
        boardHash = sha256
        if (typeof board?.auto === 'boolean') boardAuto = board.auto
        // Agent-authored boards may be just a frame list - fill sizes/keys, tidy on first load.
        // Keys are load-bearing (iframe identity, selection, COMMENT ANCHORS) - dupes/blanks
        // get minted DETERMINISTICALLY (keys.ts): a random key here orphaned every comment
        // created on a never-saved board the moment it reloaded.
        // Board nodes whose file is gone stay, flagged - deletion is surfaced, never silent.
        const seenKeys = new Set<string>()
        const ordinals = new Map<string, number>()   // per-frame keyless-occurrence counter
        nodes = (Array.isArray(board?.nodes) ? board.nodes : [])
          .filter((n: any) => n && typeof n.frame === 'string')
          .map((n: any) => {
            const f = manifest.frames.find((x) => x.id === n.frame)
            const d = f ? defaultSize(f) : { w: 390, h: 844 }
            if (typeof n.x !== 'number' || typeof n.y !== 'number') needTidy = true
            let key = typeof n.key === 'string' && n.key ? n.key : ''
            if (!key || seenKeys.has(key)) {
              let salt = ordinals.get(n.frame) ?? 0
              do { key = stableNodeKey(boardName, n.frame, salt++) } while (seenKeys.has(key))
              ordinals.set(n.frame, salt)
            }
            seenKeys.add(key)
            // content-frame size provenance round-trips; auto nodes saved no
            // w/h, so they fall to defaultSize (placeholder) and remeasure on mount
            const sizeMode = f?.contentWidth
              ? { sizeMode: (n.sizeMode === 'manual' || n.sizeMode === 'device' ? n.sizeMode : 'auto') as Node['sizeMode'] }
              : {}
            return {
              key,
              frame: n.frame,
              x: typeof n.x === 'number' ? n.x : 0, y: typeof n.y === 'number' ? n.y : 0,
              w: typeof n.w === 'number' ? n.w : d.w, h: typeof n.h === 'number' ? n.h : d.h,
              ...(!f && typeof n.w !== 'number' && typeof n.h !== 'number' ? { sizeFallback: true } : {}),
              ...sizeMode,
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
        if (Array.isArray(board?.sceneRows)) {
          const rows = board.sceneRows
            .map((r: unknown) => (Array.isArray(r) ? r.filter((x: unknown) => typeof x === 'string') : []))
            .filter((r: string[]) => r.length)
          if (rows.length) sceneRows = rows
        }
        layoutRaw = board?.layout
        layout = parseLayout(board?.layout, layoutWarn)
        if (layout && sceneRows) layoutWarn('board has layout AND sceneRows - layout wins')
        if (board?.baseLayout && typeof board.baseLayout === 'object') baseLayout = board.baseLayout
      }
      // auto-managed goes both ways (friction log #15): an auto board gains new frames
      // AND sheds deleted ones. Tombstone cards are a curated-board concept.
      // Pruning at load DIRTIES the board (dev only) so the file on disk sheds the
      // tombstones too - otherwise a recreated frame id resurrects its stale node.
      let prunedAtLoad = false
      if (boardAuto) {
        const before = nodes.length
        nodes = nodes.filter((n) => !n.missing)
        prunedAtLoad = !DATA && nodes.length !== before
      }
      // frames not on the board yet → auto boards only (a curated board shows exactly its list).
      // Grouped newcomers land beside their siblings (like the live JOIN); ungrouped ones
      // go past the board's right edge (the live JOIN flows them below) - NEVER at (0,0)
      // (the published all-scenes bug: frames created after the board file was last
      // saved piled up at the origin)
      if (boardAuto) {
        const placed = new Set(nodes.map((n) => n.frame))
        // newcomers get deterministic keys too - on published auto boards (all-scenes)
        // this path mints EVERY key, every visit, and comments anchor to them
        const haveKeys = new Set(nodes.map((n) => n.key))
        const mint = (frame: string) => {
          let salt = 0, k = stableNodeKey(boardName, frame, salt)
          while (haveKeys.has(k)) k = stableNodeKey(boardName, frame, ++salt)
          haveKeys.add(k)
          return k
        }
        let maxX = nodes.reduce((a, n) => Math.max(a, n.x + n.w), 0)
        for (const f of manifest.frames) {
          if (placed.has(f.id)) continue
          placed.add(f.id)
          const d = defaultSize(f)
          const vp = deviceView ? CONFIG.viewports[deviceView] : null
          const w = vp?.width ?? d.w, h = vp?.height ?? d.h
          let x: number, y: number
          const sibling = f.variantGroup
            ? nodes.filter((n) => manifest.frames.find((m) => m.id === n.frame)?.variantGroup === f.variantGroup)
                .reduce<Node | null>((a, n) => (!a || n.x + n.w > a.x + a.w ? n : a), null)
            : null
          if (sibling) { x = sibling.x + sibling.w + Math.max(140, sibling.w * 0.12); y = sibling.y }
          else { x = nodes.length ? maxX + 96 : 0; y = 0 }
          const node: Node = { key: mint(f.id), frame: f.id, x, y, w, h, theme: resolveTheme(f), status: 'loading', ...(f.contentWidth ? { sizeMode: (vp ? 'device' : 'auto') as Node['sizeMode'] } : {}) }
          nodes.push(node)
          maxX = Math.max(maxX, x + w)
        }
      }
      // published: re-apply this visit's pins and content sizes over the inlined data
      if (DATA && nodes.length) {
        const pins = sessionPins.read(boardName)
        const sizes = sessionSizes.read(boardName)
        for (const n of nodes) {
          const pin = pins[n.frame]
          if (pin && CONFIG.themes.includes(pin)) { n.themeUser = pin; n.theme = pin }
          const sz = sizes[sizeKey(nodes, n)]
          if (sz && manifest.frames.find((f) => f.id === n.frame)?.contentWidth
            && Number.isFinite(sz.w) && Number.isFinite(sz.h) && (sz.sizeMode === 'manual' || sz.sizeMode === 'device')) {
            n.w = sz.w; n.h = sz.h; n.sizeMode = sz.sizeMode
          }
        }
      }
      if ((!boardHash || needTidy) && nodes.length) {
        const entryOf = (id: string) => manifest.frames.find((f) => f.id === id)
        const placedAll = tidy(nodes.map((n) => {
          const f = entryOf(n.frame)
          return { key: n.key, frame: n.frame, scene: f?.scene ?? '', group: f?.variantGroup, variant: f?.variant, w: n.w, h: n.h + HEADER }
        }), effectiveLayout(layout, sceneRows), layoutWarn)
        for (const pl of placedAll) { const n = nodes.find((x) => x.key === pl.key)!; n.x = pl.x; n.y = pl.y }
      }
      // dirty matches disk by construction - except when load-time pruning changed the
      // node set; callers see dirty:true and schedule the save that persists the prune
      // surface recipe problems at load (dry-run): materialized boards otherwise
      // never run tidy, so a broken agent-authored layout would fail silently
      if (layout && boardHash && !needTidy && nodes.length) {
        const entryOf2 = (id: string) => manifest.frames.find((f) => f.id === id)
        tidy(nodes.map((n) => {
          const f = entryOf2(n.frame)
          return { key: n.key, frame: n.frame, scene: f?.scene ?? '', group: f?.variantGroup, variant: f?.variant, w: n.w, h: n.h + HEADER }
        }), layout, layoutWarn)
      }
      return { manifest, nodes, boardHash, boardAuto, deviceView, sceneRows, layout, layoutRaw, baseLayout, selection: [], dirty: prunedAtLoad }
    } catch { return null }
  }

  return {
    manifest: null, nodes: [], selection: [], interact: null, viewTheme: initialViewTheme(), play: null, gesture: false, laser: false,
    board: DATA?.default ?? 'all-scenes', boardAuto: (DATA?.default ?? 'all-scenes') === 'all-scenes', deviceView: null, sceneRows: null, layout: null, layoutRaw: undefined, baseLayout: null,
    panelOpen: true, scale: 1, toasts: [], working: [], workingSince: {}, boardHash: null, dirty: false,
    pendingFrameRevisions: {}, externalLeases: {}, playUpdateRevision: null, playNav: 0,

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
      if (next.dirty) scheduleSave()          // load-time prune must reach the disk
      if (live && manifestKey(live) !== manifestKey(next.manifest as Manifest)) get().applyManifest(live)
      return true
    },

    async switchBoard(name) {
      const mySwitch = ++switchSeq             // also cancels any pending switch (incl. re-clicking the current board)
      if (name === get().board) return
      // a resize held across a switch: settle THIS board (retidy if it has a recipe)
      // before the flush, so the torn mid-gesture state is never what reaches disk
      if (resizedInGesture) {
        resizedInGesture = false
        if (get().layout || get().sceneRows?.length) get().runTidy()
      }
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
      if (next.dirty) scheduleSave()           // load-time prune must reach the disk
      if (live && manifestKey(live) !== manifestKey(next.manifest as Manifest)) get().applyManifest(live)
    },

    applyManifest(m) {
      bumpManifestRev()                        // frame set changed → new iframes get fresh URLs
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
        // a grouped newcomer lands BESIDE its siblings, not at the canvas bottom - the
        // badge/caption say "these belong together"; the position must agree
        const sibs = f.variantGroup
          ? next.filter((n) => { const g = m.frames.find((x) => x.id === n.frame)?.variantGroup; return g === f.variantGroup && !n.missing })
          : []
        const right = sibs.length ? sibs.reduce((a, n) => (n.x > a.x ? n : a)) : null
        const mode = f.contentWidth ? { sizeMode: (vp ? 'device' : 'auto') as Node['sizeMode'] } : {}
        // deterministic key (keys.ts): a comment dropped on a live-joined frame must
        // survive the reload, where the SAME key gets minted by the board-load path
        const mintKey = (() => {
          const have = new Set(next.map((n) => n.key))
          let salt = 0, k = stableNodeKey(get().board, f.id, salt)
          while (have.has(k)) k = stableNodeKey(get().board, f.id, ++salt)
          return k
        })()
        const node = right
          ? { key: mintKey, frame: f.id, x: right.x + right.w + Math.max(140, right.w * 0.12), y: right.y, w: vp?.width ?? d.w, h: vp?.height ?? d.h, theme: resolveTheme(f), status: 'loading' as const, ...mode }
          : { key: mintKey, frame: f.id, x: 0, y: maxY + 96, w: vp?.width ?? d.w, h: vp?.height ?? d.h, theme: resolveTheme(f), status: 'loading' as const, ...mode }
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
        if (missing !== !!n.missing) {
          // a node whose frame just ARRIVED (the create-first choreography: the agent
          // appends the board node before the manifest registers the file) was sized by
          // the 390x844 GUESS - its real viewport is only knowable now. ONLY guessed
          // sizes are corrected (sizeFallback): a restored frame keeps its authored w/h.
          const arrived = !missing && m.frames.find((x) => x.id === n.frame)
          if (arrived && n.sizeFallback && !arrived.contentWidth) {
            const d = defaultSize(arrived)
            n.w = vp?.width ?? d.w
            n.h = vp?.height ?? d.h
          }
          if (arrived) delete n.sizeFallback
          n.missing = missing
          changed = true
        }
        // a frame's declared meta.theme may have changed - re-resolve unpinned nodes
        // (derived value: re-render yes, dirty/save no)
        const f = m.frames.find((x) => x.id === n.frame)
        const want = n.themeUser ?? f?.theme ?? get().viewTheme
        if (n.theme !== want) { n.theme = want; retinted = true }
        // content-ness can change live (agent adds/removes the primitives): reconcile
        // provenance or measurements are rejected / UI dims silently omitted from saves.
        // Under an active device view the newcomer joins it as 'device' - a measurement
        // must not override the preset the whole board is showing
        if (f?.contentWidth && !n.sizeMode) { n.sizeMode = deviceView ? 'device' : 'auto'; retinted = true }
        if (!f?.contentWidth && n.sizeMode) { delete n.sizeMode; retinted = true }
        // an errored frame whose file IS in the fresh manifest gets one automatic retry
        // on a rev-stamped URL - the "unknown frame id" dead end must self-heal (#20)
        if (!missing && n.status === 'error') { n.status = 'loading'; n.nav = (n.nav ?? 0) + 1; retinted = true }
      }
      // auto boards prune deleted frames outright - "auto-managed" must manage both
      // directions (friction log #15). Curated boards keep the explicit card.
      let final = next
      if (boardAuto) {
        final = next.filter((n) => !n.missing)
        const dropped = next.length - final.length
        if (dropped) {
          changed = true
          toast(dropped === 1 ? 'removed 1 deleted frame' : `removed ${dropped} deleted frames`)
        }
      }
      set((s) => ({
        manifest: m,
        nodes: changed || retinted ? [...final] : final,
        selection: s.selection.filter((k) => final.some((n) => n.key === k)),
        interact: s.interact && final.some((n) => n.key === s.interact) ? s.interact : null,
        ...(changed ? { dirty: true, baseLayout: nextBase } : {}),
      }))
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
      resizedInGesture = true
      const inGesture = get().gesture
      // a manual resize means the board no longer uniformly shows one device; the resized
      // frame's snapshot entry follows the user's new size so Default will not undo it
      set((s) => {
        const W = Math.max(120, w), H = Math.max(80, h)
        const cur = s.nodes.find((n) => n.key === key)
        // a human-resized CONTENT frame goes 'manual': measurements never overwrite it
        const content = !!s.manifest?.frames.find((x) => x.id === cur?.frame)?.contentWidth
        return {
          nodes: s.nodes.map((n) => (n.key === key ? { ...n, w: W, h: H, ...(content ? { sizeMode: 'manual' as const } : {}) } : n)),
          dirty: true,
          deviceView: null,
          baseLayout: s.baseLayout && cur
            ? { ...s.baseLayout, [key]: { ...(s.baseLayout[key] ?? { x: cur.x, y: cur.y }), w: W, h: H } }
            : s.baseLayout,
        }
      })
      // mid-gesture saves would persist torn state (new sizes, pre-recipe positions);
      // the gesture-end hook saves once, after any retidy
      if (!inGesture) scheduleSave()
    },

    /** sh:measure. Admission: content frames only, finite positive numbers,
     *  clamped. A height only commits when it was measured at the width being applied;
     *  auto sizes are transient - applying one never dirties the board (positions from
     *  the follow-up reflow do, exactly like a human resize). */
    measureNode(key, frameId, ownWidth, measuredWidth, height) {
      const s = get()
      const node = s.nodes.find((n) => n.key === key)
      // Only an explicit DEVICE viewport locks a content frame's height. 'auto' and 'manual' both
      // auto-fit height: a content frame must always grow/shrink to show ALL its content, even after
      // the human drags its WIDTH. 'manual' just means the human owns the WIDTH; the
      // HEIGHT is still measured, so resizing width reflows and refits height (no clipped/empty frame).
      if (!node || node.sizeMode === 'device') return
      if (node.frame !== frameId) return                  // generation guard: a reused node key
                                                          // across a board switch never mis-attributes
      const f = s.manifest?.frames.find((x) => x.id === node.frame)
      if (!f?.contentWidth) return                        // not a content frame - spoof-proofing
      if (![ownWidth, measuredWidth, height].every((v) => Number.isFinite(v) && v > 0)) return
      // Generous cap: a reference doc with many screenshots is legitimately very tall and must fit in
      // FULL (this was 2.5x a viewport ~= 2700px, which clipped image-heavy docs). Still bounded so a
      // broken measurement can't mint an infinite frame.
      const maxH = 40000
      const H = Math.min(maxH, Math.max(80, Math.round(height)))
      const curW = Math.round(node.w)
      measuredHeights.set(`${node.frame}@${Math.round(measuredWidth)}`, H)
      // AUTO owns the width too - adopt the Doc's declared/own width. MANUAL keeps the human's width
      // and only fits the height.
      if (node.sizeMode !== 'manual') {
        // declared meta.viewport WINS over the Doc layout width - the existing precedence
        const vpw = CONFIG.viewports[f.viewport ?? '']?.width
        const W = vpw ?? Math.min(1600, Math.max(320, Math.round(ownWidth)))
        if (W !== curW) {
          // Doc layout changed (document<->wide): adopt the new own width first; the
          // iframe resizes, remeasures, and the height commits on the next message
          set((st) => ({ nodes: st.nodes.map((n) => (n.key === key ? { ...n, w: W } : n)) }))
          scheduleReflow()
          return
        }
      }
      if (Math.round(measuredWidth) !== curW) return      // height only true at the width it was measured at
      if (Math.round(node.h) === H) return
      set((st) => ({ nodes: st.nodes.map((n) => (n.key === key ? { ...n, h: H } : n)) }))
      scheduleReflow()
    },
    setDeviceView(name) {
      const vp = name ? CONFIG.viewports[name] : null
      if (name && !vp) return
      set((s) => {
        // entering a device view from free-form: snapshot the layout so Default restores it.
        // Auto content nodes snapshot POSITIONS only - their w/h are measured (transient by
        // contract) and restore comes from the measurement cache, never from the snapshot
        const baseLayout = name
          ? (s.deviceView === null
              ? Object.fromEntries(s.nodes.map((n) => [n.key, n.sizeMode === 'auto' ? { x: n.x, y: n.y } : { x: n.x, y: n.y, w: n.w, h: n.h }]))
              : s.baseLayout)
          : null
        const nodes = s.nodes.map((n) => {
          const f = s.manifest?.frames.find((x) => x.id === n.frame)
          const content = !!f?.contentWidth
          if (vp) return { ...n, w: vp.width, h: vp.height, ...(content ? { sizeMode: 'device' as const } : {}) }
          // digit 0 on a CONTENT frame = back to auto: measured size, remeasure ahead
          const b = s.baseLayout?.[n.key]
          if (content && f) {
            const d = defaultSize(f)
            return { ...n, ...(b ? { x: b.x, y: b.y } : {}), w: d.w, h: d.h, sizeMode: 'auto' as const }
          }
          if (b) return { ...n, ...b }               // exact free-form layout, positions included
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
          const f = s.manifest?.frames.find((x) => x.id === n.frame)
          const content = !!f?.contentWidth
          if (vp) return { ...n, w: vp.width, h: vp.height, ...(content ? { sizeMode: 'device' as const } : {}) }
          if (!f) return n
          const d = defaultSize(f)
          // digit 0 on a content frame clears provenance back to auto
          return { ...n, w: d.w, h: d.h, ...(content ? { sizeMode: 'auto' as const } : {}) }
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
    // group/scene selection from sidebar rows and canvas captions
    selectMany(keys) {
      set((s) => {
        const valid = keys.filter((k) => s.nodes.some((n) => n.key === k))
        return { selection: valid, interact: s.interact && valid.includes(s.interact) ? s.interact : null }
      })
    },
    // interact is a ONE-frame mode: entering it collapses any multi-selection to the
    // interacted frame (a 4-frame selection double-clicked otherwise leaves all four
    // painted as "interactive"). Exiting keeps the frame selected for continuity.
    setInteract(key) {
      set((s) => ({ interact: key, selection: key ? [key] : s.selection }))
      get().flushFrameUpdates()   // A6: the frame just left interact is no longer leased
    },
    setPlay(play) { set({ play }) },
    setLaser(laser) {
      if (laser) { set({ laser }); return }
      // leaving laser mode drops every laser engagement lease (the bridge stops reporting), but
      // keeps comment engagement; the freed frames may now flush a deferred update
      set((s) => ({
        laser,
        externalLeases: Object.fromEntries(
          Object.entries(s.externalLeases).filter(([, v]) => v.comment).map(([k]) => [k, { comment: true as const }])),
      }))
      get().flushFrameUpdates()
    },
    setGesture(gesture) {
      set({ gesture })
      // A board WITH a layout recipe re-applies it when a resize
      // gesture ends - sizes changed, so lanes and gaps must recompute
      if (!gesture && resizedInGesture) {
        resizedInGesture = false
        if (get().layout || get().sceneRows?.length) get().runTidy()   // schedules the save
        else scheduleSave()
      }
      if (!gesture) get().flushFrameUpdates()   // A6: gesture end is a safe point for deferred updates
    },
    // A6/A7: apply a controlled hot update. A leased frame's revision is deferred (coalesced to
    // the latest) and applied at the next safe point; an idle frame reloads now via its nav nonce.
    invalidateFrames(frameIds, revision) {
      const ids = new Set(frameIds.filter((x) => typeof x === 'string'))
      if (!ids.size) return
      bumpManifestRev()
      const s = get()
      const pending = { ...s.pendingFrameRevisions }
      const nodes = s.nodes.map((n) => {
        if (!ids.has(n.frame)) return n
        if (frameIsLeased(n.frame, s)) { pending[n.frame] = revision; return n }
        return { ...n, status: 'loading' as const, error: undefined, nav: (n.nav ?? 0) + 1 }
      })
      set({ nodes, pendingFrameRevisions: pending, ...(s.play ? { playUpdateRevision: revision } : {}) })
    },
    flushFrameUpdates(frameIds) {
      const s = get()
      const ids = (frameIds ?? Object.keys(s.pendingFrameRevisions)).filter((id) => s.pendingFrameRevisions[id] && !frameIsLeased(id, s))
      if (!ids.length) return
      bumpManifestRev()
      const apply = new Set(ids)
      const pending = { ...s.pendingFrameRevisions }
      for (const id of ids) delete pending[id]
      const nodes = s.nodes.map((n) => apply.has(n.frame)
        ? { ...n, status: 'loading' as const, error: undefined, nav: (n.nav ?? 0) + 1 } : n)
      set({ nodes, pendingFrameRevisions: pending })
    },
    setExternalLease(nodeKey, reason, on) {
      set((s) => {
        const cur = { ...(s.externalLeases[nodeKey] ?? {}) }
        if (on) cur[reason] = true; else delete cur[reason]
        const leases = { ...s.externalLeases }
        if (Object.keys(cur).length) leases[nodeKey] = cur; else delete leases[nodeKey]
        return { externalLeases: leases }
      })
      if (!on) get().flushFrameUpdates()
    },
    applyPlayUpdate() {
      if (!get().playUpdateRevision) return
      bumpManifestRev()
      set((s) => ({ playUpdateRevision: null, playNav: s.playNav + 1 }))
    },
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
      const { nodes, manifest, sceneRows, layout } = get()
      const entryOf = (id: string) => manifest?.frames.find((f) => f.id === id)
      const placed = tidy(nodes.map((n) => {
        const f = entryOf(n.frame)
        return { key: n.key, frame: n.frame, scene: f?.scene ?? '', group: f?.variantGroup, variant: f?.variant, w: n.w, h: n.h + HEADER }
      }), effectiveLayout(layout, sceneRows), layoutWarn)
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
    /** A Live Jam reply notification: persistent (no auto-dismiss), one per thread (a newer reply
     *  supersedes), capped so the stack stays small. */
    jamToast(note) {
      const id = ++toastSeq
      set((s) => ({ toasts: [...s.toasts.filter((t) => t.jam?.threadId !== note.threadId), { id, text: 'Marver replied', jam: note }].slice(-8) }))
    },
    dismissToast(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })) },
    clearJamToasts() { set((s) => ({ toasts: s.toasts.filter((t) => !t.jam) })) },
    setWorking(frames) {
      // preserve each frame's original start time; stamp now() only for newly-working frames -
      // the start phases the working animations so parallel frames never pulse in sync
      const prev = get().workingSince
      const workingSince: Record<string, number> = {}
      for (const f of frames) workingSince[f] = prev[f] ?? Date.now()
      set({ working: frames, workingSince })
    },
    spawn(frameId) {
      const { manifest, nodes, deviceView, baseLayout } = get()
      const f = manifest?.frames.find((x) => x.id === frameId)
      if (!f) return null
      const d = defaultSize(f)
      const vp = deviceView ? CONFIG.viewports[deviceView] : null
      const maxX = nodes.reduce((a, n) => Math.max(a, n.x + n.w), 0)
      const node: Node = { key: nodeKey(), frame: f.id, x: maxX + 96, y: 0, w: vp?.width ?? d.w, h: vp?.height ?? d.h, theme: resolveTheme(f), status: 'loading', ...(f.contentWidth ? { sizeMode: (vp ? 'device' : 'auto') as Node['sizeMode'] } : {}) }
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
      // a resize gesture in flight = torn state (new sizes, pre-recipe positions):
      // even a PREVIOUSLY scheduled timer must defer to the gesture-end save
      if (get().gesture && resizedInGesture) { scheduleSave(); return Promise.resolve(false) }
      // a published canvas is read-only ON DISK: theme pins persist to the
      // session instead, and dirty must clear or switchBoard's save-flush loop wedges
      if (DATA) {
        sessionPins.write(get().board, get().nodes)
        sessionSizes.write(get().board, get().nodes)
        set({ dirty: false })
        return Promise.resolve(true)
      }
      const p = saveChain.then(async () => {
        // recheck INSIDE the serialized chain: a save queued behind an in-flight PUT
        // may only execute after a resize gesture began - the entry guard above ran
        // too early to see it (torn PUT #2 behind blocked PUT #1)
        if (get().gesture && resizedInGesture) { scheduleSave(); return false }
        const rev = editRev
        const { nodes, boardHash, deviceView, baseLayout, board: boardName, boardAuto } = get()
        // Missing nodes persist too - only the explicit remove button drops them.
        const board = {
          version: 1, name: boardName, auto: boardAuto,
          // deviceView and the free-form snapshot persist independently: a scoped
          // exception clears the view but 0 must still restore the snapshot after reload
          ...(deviceView ? { deviceView } : {}),
          ...(get().sceneRows?.length ? { sceneRows: get().sceneRows } : {}),
          ...(get().layoutRaw !== undefined ? { layout: get().layoutRaw } : {}),
          // baseLayout entries for auto content nodes keep POSITIONS only - their
          // measured dimensions are transient and never reach the file
          ...(baseLayout ? {
            baseLayout: Object.fromEntries(Object.entries(baseLayout).map(([k, b]) => {
              const n = nodes.find((x) => x.key === k)
              return n?.sizeMode === 'auto' ? [k, { x: b.x, y: b.y }] : [k, b]
            })),
          } : {}),
          // only PINNED themes persist - inherited values follow viewTheme at load time.
          // Content frames in AUTO save no dimensions: measured sizes are
          // transient - a reflow-triggered save can never leak an auto height to disk.
          // Guessed sizes (sizeFallback: the frame was not in the manifest yet) stay
          // transient too - persisting the 390x844 guess would make it look authored
          // and immortalize it across reloads.
          nodes: nodes.map(({ key, frame, x, y, w, h, themeUser, sizeMode, sizeFallback }) => ({
            key, frame, x: Math.round(x), y: Math.round(y),
            ...(sizeMode === 'auto' || sizeFallback ? {} : { w: Math.round(w), h: Math.round(h) }),
            ...(sizeMode === 'manual' || sizeMode === 'device' ? { sizeMode } : {}),
            ...(themeUser ? { themeUser } : {}),
          })),
        }
        try {
          const res = await fetch(`${ROUTE}/api/boards/${boardName}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            // A9: a board loaded from disk (boardHash set) autosaves with mustExist so a
            // rename/delete out from under us returns 409 instead of resurrecting a ghost.
            body: JSON.stringify({ board, baseHash: boardHash, mustExist: !!boardHash }),
          })
          if (get().board !== boardName) return true   // switched boards mid-flight; stale response must not touch state
          if (res.status === 409) {
            const info = await res.json().catch(() => ({} as { gone?: boolean }))
            if (info?.gone) {
              // renamed/deleted externally - drop the write, don't recreate it or loop
              set({ dirty: false })
              get().toast('this board was renamed or removed - not recreating it')
              return true
            }
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

// dev-only inspection hook for tests/debugging (never installed in published builds)
if (import.meta.env.DEV) (window as unknown as { __mvStore: unknown }).__mvStore = useStore
