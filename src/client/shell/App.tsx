import { Component, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, CONFIG, PUBLISHED, boardLabel, boardFrames, cap, humanize, fetchBoardNames, type FrameEntry } from './store.ts'
import { Tip } from './Tip.tsx'
import { PKG, ROUTE } from '../const.ts'
import { animateLayout, Canvas, canvasCtl } from './canvas/Canvas.tsx'
import { frameByWindow } from './canvas/frame-registry.ts'
import { enterPlay, playCtl, PlayOverlay } from './Play.tsx'
import { bootHash, parseHash, writeHash } from './hash.ts'
import { CardsIcon, CardsThreeIcon, CaretIcon, CheckIcon, ColumnsIcon, FrameRectIcon, IntentGlyph, MoonIcon, PanelFilledIcon, PanelHollowIcon, ParallelogramDuoIcon, ParallelogramFillIcon, PencilSimpleIcon, PlayIcon, SignpostIcon, SunIcon, VariantsIcon, XIcon, deviceIcon } from './icons.tsx'
import { CommentsController, revealThread } from './Comments.tsx'
import { poweredByUrl } from '../../shared/utm.ts'
import { useComments } from './comments-store.ts'
import { CommentButton, DevicePicker, HideUIButton, LaserButton, Popover, ThemePicker, toggleHideUI, usePopover } from './Toolbar.tsx'

const commentsStore = () => useComments.getState()

let booted = false                             // survives Fast Refresh; see the boot effect

/** Copy text to the clipboard, toasting the outcome. Success is confirmed out loud; a
 *  blocked clipboard (no user gesture / permission) says so instead of failing silently. */
function copyToClipboard(text: string, okMsg: string) {
  const { toast } = useStore.getState()
  navigator.clipboard.writeText(text).then(() => toast(okMsg), () => toast('copy blocked - click the canvas first'))
}

/** The address a frame copies - the same string from the sidebar right-click, the floating
 *  toolbar, and ⇧P: the board it sits on, the frame id, and its file. */
const framePath = (board: string, f: { id: string; file: string }) => `board: ${board} · frame: ${f.id}  (${f.file})`

type MenuItem = { label: string; icon: ReactNode; onClick: () => void }
type MenuState = { x: number; y: number; items: MenuItem[] }

/** A right-click menu for the sidebar. One instance lives in App; `open(e, items)` positions
 *  it at the cursor, CLAMPED into the viewport. It closes on outside pointerdown, on pick, and
 *  on Escape - the Escape listener runs in CAPTURE phase so it does not also trip App's global
 *  keydown (which would clear the selection/laser underneath the menu). */
function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const open = (e: { preventDefault(): void; clientX: number; clientY: number }, items: MenuItem[]) => {
    e.preventDefault()
    const MENU_W = 184
    const h = items.length * 32 + 12
    setMenu({ x: Math.min(e.clientX, window.innerWidth - MENU_W - 8), y: Math.min(e.clientY, window.innerHeight - h - 8), items })
  }
  return { menu, open, close: () => setMenu(null) }
}

function ContextMenu({ menu, close }: { menu: MenuState | null; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as globalThis.Node)) close() }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() } }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onEsc, true)   // capture: beat App's bubble-phase Escape
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onEsc, true) }
  }, [menu])
  const app = document.querySelector('.sh-app')
  if (!menu || !app) return null
  return createPortal(
    <div className="sh-menu sh-ctxmenu" ref={ref} style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((it) => (
        <button key={it.label} onClick={() => { it.onClick(); close() }}>{it.icon}<span>{it.label}</span></button>
      ))}
    </div>,
    app,
  )
}

/** One collapsible scene group in the sidebar. `held` marks a scene that contains a
 *  selected frame - a quiet secondary wash so ancestry survives collapsing the group. */
function SceneGroup({ name, count, held, onPick, onContextMenu, children }: { name: string; count: number; held: boolean; onPick?: () => void; onContextMenu?: (e: ReactMouseEvent) => void; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button className={`it${held ? ' held' : ''}`} onClick={() => setOpen(!open)} onContextMenu={onContextMenu}>
        <CaretIcon size={11} className="tw" style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
        {/* the NAME selects every frame in the scene; the caret/row still collapses */}
        <span onClick={(e) => { if (!onPick) return; e.stopPropagation(); onPick() }}>{humanize(name) || '(root)'}</span>
        <small>{count}</small>
      </button>
      {open && children}
    </div>
  )
}

/** A shell bug shows a banner, never a white screen. */
export class ShellBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div style={{ fontFamily: 'ui-monospace, monospace', padding: 32 }}>
        <b style={{ color: '#a81f16' }}>shell crashed</b>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.err.message}</pre>
        <button onClick={() => location.reload()}>reload</button>
      </div>
    )
  }
}

/** Boards live flat in the sidebar - always visible, one click to switch. The list
 *  refreshes on mount, window focus, and a slow poll so agent-created board files
 *  appear without a reload. Active board = accent icon + wash, same language as scenes. */
const BOARD_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

function BoardList({ onMenu }: { onMenu: (e: { preventDefault(): void; clientX: number; clientY: number }, items: MenuItem[]) => void }) {
  const board = useStore((s) => s.board)
  const [names, setNames] = useState<string[]>(['all-scenes'])
  const [editing, setEditing] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)               // board being dragged
  // insertion index in the CURATED list (0..len): one value per gap, so the divider lands
  // once between two boards - not twice (A's bottom-half and B's top-half were separate spots)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  // genRef invalidates every async setNames: a mutation bumps it, so a poll/fetch that
  // STARTED earlier can never clobber a fresh optimistic reorder or a just-renamed list.
  const genRef = useRef(0)
  const busyRef = useRef(0)                                            // reorders in flight; while >0 polls hold off
  const commitBusy = useRef(false)                                    // guards Enter+blur firing two renames
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())         // serializes reorder POSTs
  // reorder runs on pointer events, NOT native drag-and-drop: native DnD hands the cursor to
  // the OS (arrow/move), so a grabbing hand can't persist. Owning the gesture lets us hold
  // the grabbing cursor for the whole drag via a body class.
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number; name: string; dragging: boolean; el: HTMLElement } | null>(null)
  const refresh = () => {
    if (busyRef.current > 0) return   // a reorder is mid-flight; its optimistic order stands until it settles
    const gen = genRef.current
    fetchBoardNames().then((list) => { if (gen === genRef.current) setNames(list) }).catch(() => { /* keep last known */ })
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 8000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(t); window.removeEventListener('focus', refresh) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pick = async (name: string) => {
    if (name === useStore.getState().board) return
    await useStore.getState().switchBoard(name)
    setTimeout(() => canvasCtl.fitAll(), 60)
  }
  const commit = async (old: string, raw: string) => {
    if (commitBusy.current) return                          // Enter already fired this; ignore the follow-up blur
    const next = raw.trim()
    if (!next || next === old) { setEditing(null); return }
    if (!BOARD_NAME_RE.test(next) || next.length > 64 || next === 'all-scenes' || names.includes(next)) {
      useStore.getState().toast('use a free name - lowercase letters, numbers and dashes'); return   // stay editing
    }
    commitBusy.current = true
    try {
      const r = await useStore.getState().renameBoard(old, next)
      if (r.ok) { setEditing(null); genRef.current++; refresh() }
      else useStore.getState().toast(r.error ?? 'rename failed')                                      // stay editing
    } finally { commitBusy.current = false }
  }
  // the INSERTION INDEX (in the curated list, 0..len) nearest the pointer - one value per
  // gap, so a single divider lands between two boards instead of one per row-half
  const indexAt = (x: number, y: number): number | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-board-row]') as HTMLElement | null
    const name = el?.dataset.board
    if (!name) return null
    const curated = names.filter((n) => n !== 'all-scenes')
    if (name === 'all-scenes') return curated.length            // over the pinned last row = end slot
    const ci = curated.indexOf(name)
    if (ci < 0) return null
    const r = el!.getBoundingClientRect()
    return y > r.top + r.height / 2 ? ci + 1 : ci
  }
  const resetPointer = () => {
    const g = gestureRef.current
    gestureRef.current = null
    if (g) { try { g.el.releasePointerCapture(g.pointerId) } catch { /* already released */ } }
    document.body.classList.remove('sh-board-dragging')
    setDrag(null)
    setDropIndex(null)
  }
  // move the dragged board to the insertion index and persist the new order optimistically
  const applyReorder = (dragName: string, dropIndex: number) => {
    if (dragName === 'all-scenes') return
    const curated = names.filter((n) => n !== 'all-scenes')
    const from = curated.indexOf(dragName)
    if (from < 0) return
    const to = dropIndex > from ? dropIndex - 1 : dropIndex      // removing `from` shifts later indices left
    if (to === from) return                                      // dropped in its own slot - no move
    curated.splice(from, 1)
    curated.splice(to, 0, dragName)
    const prev = names
    genRef.current++
    const gen = genRef.current
    busyRef.current++                                             // hold polls off until this settles
    setNames(names.includes('all-scenes') ? [...curated, 'all-scenes'] : curated)
    chainRef.current = chainRef.current.then(async () => {
      try {
        const ok = await useStore.getState().reorderBoards(curated)
        if (gen !== genRef.current) return                        // a newer drop superseded this one
        if (!ok) { setNames(prev); useStore.getState().toast('could not save order') }
      } catch { if (gen === genRef.current) { setNames(prev); useStore.getState().toast('could not save order') } }
      finally { busyRef.current-- }
    })
  }
  const onBoardPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, n: string) => {
    if (e.button !== 0) return                                    // left button only; right-click opens the menu
    const el = e.currentTarget
    try { el.setPointerCapture(e.pointerId) } catch { /* capture can fail on rapid input */ }
    gestureRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, name: n, dragging: false, el }
  }
  const onBoardPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 5) return   // click vs drag threshold
      g.dragging = true
      setDrag(g.name)
      document.body.classList.add('sh-board-dragging')            // holds the grabbing cursor for the whole drag
    }
    const idx = indexAt(e.clientX, e.clientY)
    // hide the seam at the dragged board's OWN slot (index from or from+1 = no move)
    const from = names.filter((nm) => nm !== 'all-scenes').indexOf(g.name)
    setDropIndex(idx === null || idx === from || idx === from + 1 ? null : idx)
  }
  const onBoardPointerUp = (e: ReactPointerEvent<HTMLButtonElement>, n: string) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    const dragged = g.dragging
    const idx = dragged ? indexAt(e.clientX, e.clientY) : null
    resetPointer()
    if (dragged) { if (idx !== null) applyReorder(n, idx) }
    else void pick(n)                                             // a tap switches boards (the trailing mouse click is ignored)
  }
  // cancel a drag on Escape (capture phase, so the app's global Escape never sees it) or focus loss
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && gestureRef.current?.dragging) { e.preventDefault(); e.stopPropagation(); resetPointer() } }
    const onBlur = () => { if (gestureRef.current) resetPointer() }
    window.addEventListener('keydown', onEsc, true)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onEsc, true); window.removeEventListener('blur', onBlur); resetPointer() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const menuFor = (n: string): MenuItem[] => [
    { label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(`board: ${n}`, 'path copied') },
    ...(!PUBLISHED && n !== 'all-scenes' ? [{ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setEditing(n) }] : []),
  ]
  const curated = names.filter((nm) => nm !== 'all-scenes')
  return (
    <>
      {names.map((n) => {
        if (editing === n) return (
          <div key={n} className="it board editing">
            {n === 'all-scenes' ? <CardsThreeIcon size={14} /> : <CardsIcon size={14} />}
            <input autoFocus defaultValue={n} spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commit(n, e.currentTarget.value) }
                else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
              }}
              onBlur={(e) => { if (editing === n) void commit(n, e.currentTarget.value) }} />
          </div>
        )
        const canDrag = !PUBLISHED && n !== 'all-scenes'
        // ONE seam per gap, from the insertion index: drop-before the row AT that index, or
        // drop-after the last curated row when the index is the end. Overlay (::after), so no
        // layout shift. Never on the row being dragged.
        const ci = curated.indexOf(n)
        const dropCls = drag == null || dropIndex == null || n === drag ? ''
          : ci === dropIndex ? ' drop-before'
          : dropIndex === curated.length && ci === curated.length - 1 ? ' drop-after'
          : ''
        return (
          <button key={n} data-board-row data-board={n} data-reorderable={canDrag || undefined}
            className={`it board${n === board ? ' cur' : ''}${drag === n ? ' dragging' : ''}${dropCls}`}
            // draggable rows switch on the pointer tap (onPointerUp), so their trailing mouse
            // click (detail >= 1) must be ignored to avoid a double switch; keyboard clicks
            // (detail === 0) and non-draggable rows (all-scenes) switch here as normal
            onClick={(e) => { if (!canDrag || e.detail === 0) void pick(n) }}
            onContextMenu={(e) => onMenu(e, menuFor(n))}
            onPointerDown={canDrag ? (e) => onBoardPointerDown(e, n) : undefined}
            onPointerMove={canDrag ? onBoardPointerMove : undefined}
            onPointerUp={canDrag ? (e) => onBoardPointerUp(e, n) : undefined}
            onPointerCancel={canDrag ? () => resetPointer() : undefined}
            onLostPointerCapture={canDrag ? (e) => { if (gestureRef.current?.pointerId === e.pointerId) resetPointer() } : undefined}>
            {n === 'all-scenes' ? <CardsThreeIcon size={14} /> : <CardsIcon size={14} />}
            <span>{boardLabel(n)}</span>
          </button>
        )
      })}
    </>
  )
}

/** Selection toolbar: screen-space overlay above the selected frame - constant size at any
 *  zoom. Position derives from --sh-s/tx/ty (written per transform frame in Canvas), so
 *  pan/zoom tracking is pure CSS with zero React re-renders. */
function SelectionBar() {
  const selection = useStore((s) => s.selection)
  const node = useStore((s) => s.nodes.find((n) => n.key === s.selection[s.selection.length - 1]))
  const frame = useStore((s) => (node ? s.frameFor(node) : undefined))
  const nodes = useStore((s) => s.nodes)
  // measured width feeds the viewport clamp below; a callback ref because the bar
  // mounts/unmounts with the selection (an effect with [] would miss remounts)
  const [barW, setBarW] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const barRef = (el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (el) {
      roRef.current = new ResizeObserver(() => setBarW(el.offsetWidth))
      roRef.current.observe(el)
    }
  }
  // the copy-path icon flashes into a check on a successful copy - from the icon OR the
  // Shift+P shortcut. pathPulse (store) bumps on each copy; these hooks sit ABOVE the
  // early return so their order never changes with the selection.
  const pathPulse = useStore((s) => s.pathPulse)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!pathPulse) return
    setCopied(true)
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [pathPulse])
  if (!node || !frame || node.missing) return null
  // anchor: centered over the bounding box of ALL selected frames, above the topmost
  const selNodes = nodes.filter((n) => selection.includes(n.key))
  const bx0 = Math.min(...selNodes.map((n) => n.x))
  const bx1 = Math.max(...selNodes.map((n) => n.x + n.w))
  const by0 = Math.min(...selNodes.map((n) => n.y))
  const { resizeSelected, toast } = useStore.getState()
  const multi = selection.length > 1
  const applyDevice = (name: string) => {
    animateLayout()
    resizeSelected(name)
    setTimeout(() => canvasCtl.fitNodes(useStore.getState().selection), 30)
  }
  const setNodeTheme = (t: string) => useStore.getState().setSelectedTheme(t)
  const selectedFrames = () => {
    const st = useStore.getState()
    return st.selection
      .map((k) => { const n = st.nodes.find((x) => x.key === k); return n ? st.frameFor(n) : undefined })
      .filter((f): f is NonNullable<typeof f> => !!f)
  }
  // centered over the selection's bounding box, then CLAMPED into the viewport: the
  // controls for a selected frame must stay reachable when its top edge is panned
  // off-screen, and must never drift off the sides (friction log #23)
  const centerX = `calc(var(--sh-tx, 0px) + var(--sh-s, 1) * ${(bx0 + bx1) / 2}px)`
  // a grouped frame carries a caption above it - clear it EXACTLY, in screen terms:
  // frame top - the caption offset (8px screen, world-capped) - the caption's height
  // (screen-clamped 12..18px font) - the bar. Gate on the TOP edge of the selection,
  // not the last-selected frame: a mixed selection whose topmost frames are variants
  // still has a caption to clear.
  const capAtTop = selNodes.some((n) => n.y === by0 && useStore.getState().frameFor(n)?.variantGroup)
  const rawTop = capAtTop
    ? `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${by0}px - clamp(4px * var(--sh-s, 1), 8px, 40px * var(--sh-s, 1)) - (clamp(12px, 17px * var(--sh-s, 1), 18px) * 1.4) - 44px)`
    : `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${by0}px - 52px)`
  return (
    <div
      className="sh-ctx"
      ref={barRef}
      style={{
        left: barW
          ? `clamp(8px, calc(${centerX} - ${Math.round(barW / 2)}px), calc(100vw - ${barW + 8}px))`
          : centerX,
        top: `clamp(8px, ${rawTop}, calc(100vh - 52px))`,
        transform: barW ? undefined : 'translateX(-50%)',
      }}
    >
      {multi && <>
        <Tip label={`${selection.length} frames selected`}><span className="cnt">{selection.length}</span></Tip>
        <i className="sep" />
      </>}
      {Object.entries(CONFIG.viewports).map(([name, vp], vi) => {
        const active = node.w === vp.width
        return (
          <Tip key={name} label={<><b>{cap(name)}</b><span>{vp.width} × {vp.height}</span><span className="k">{vi + 1}</span></>}>
            <button className={active ? 'on' : 'icon'} onClick={() => applyDevice(name)}>
              {deviceIcon(name, 15)}{active && <span>{cap(name)}</span>}
            </button>
          </Tip>
        )
      })}
      <i className="sep" />
      {CONFIG.themes.map((t) => (
        <Tip key={t} label={`${cap(t)} theme`}>
          <button className={`icon${node.theme === t ? ' on' : ''}`} onClick={() => setNodeTheme(t)}>
            {t === 'dark' ? <MoonIcon size={15} /> : t === 'light' ? <SunIcon size={15} /> : t}
          </button>
        </Tip>
      ))}
      <i className="sep" />
      <Tip label={<><b>{multi ? `Copy ${selection.length} paths` : 'Copy path'}</b><span className="k">⇧P</span></>}>
        <button className="icon"
          onClick={() => {
            const brd = useStore.getState().board
            const text = selectedFrames().map((f) => framePath(brd, f)).join('\n')
            navigator.clipboard.writeText(text).then(
              () => { toast(multi ? `${selection.length} paths copied` : 'path copied'); useStore.getState().pulsePath() },
              () => toast('copy blocked - click the canvas first'))
          }}>{copied ? <CheckIcon size={15} /> : <SignpostIcon size={15} />}</button>
      </Tip>
    </div>
  )
}

/** Devices view: one click sizes frames to a device width, tidies, and fits. Scoped
 *  like the digit keys: the selection when one exists, the whole board otherwise. The
 *  dropdown chrome is the shared DevicePicker; this adapter owns the canvas wiring. */
function DeviceMenu() {
  const deviceView = useStore((s) => s.deviceView)
  const selection = useStore((s) => s.selection)
  const nodes = useStore((s) => s.nodes)
  const scoped = selection.length > 0
  const pick = (name: string | null) => {
    animateLayout()
    const st = useStore.getState()
    if (scoped) {
      st.resizeSelected(name)
      setTimeout(() => canvasCtl.fitNodes(useStore.getState().selection), 30)
    } else {
      st.setDeviceView(name)
      setTimeout(() => canvasCtl.fitAll(), 30)
    }
  }
  const entries = Object.entries(CONFIG.viewports)
  // active check: board-wide it is the device view; scoped, the device every selected frame wears
  const selNodes = scoped ? nodes.filter((n) => selection.includes(n.key)) : []
  const active = scoped
    ? entries.find(([, vp]) => selNodes.length > 0 && selNodes.every((n) => n.w === vp.width))?.[0] ?? null
    : deviceView
  const hint = scoped ? `${selection.length} selected` : deviceView ? cap(deviceView) : `keys 1-${entries.length}`
  return <DevicePicker value={active} onSelect={pick} includeDefault hint={hint} />
}

/** Update pill (dev only): the daily registry check surfaces here - same glass, same
 *  pill, bottom-center. Click the command to copy it; × dismisses THIS version for
 *  good (localStorage), so the pill returns only when the next release lands. */
function UpdatePill() {
  const [latest, setLatest] = useState<string | null>(null)
  const play = useStore((s) => s.play)
  useEffect(() => {
    if (PUBLISHED) return                     // a shared canvas never nags its viewers
    fetch(`${ROUTE}/api/update`)
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (u?.latest && localStorage.getItem('mv-update-seen') !== u.latest) setLatest(u.latest)
      })
      .catch(() => { /* dev server gone or endpoint absent - stay quiet */ })
  }, [])
  if (!latest || play) return null
  // init rides along so managed files (AGENTS.md, instructions/) refresh with the code
  const cmd = `npm i -D ${PKG}@latest && npx marver init`
  const dismiss = () => {
    try { localStorage.setItem('mv-update-seen', latest) } catch { /* storage unavailable */ }
    setLatest(null)
  }
  return (
    <div className="sh-update">
      <span><b>{latest}</b> is out</span>
      <Tip side="top" label="Copy, then paste to your terminal or your agent">
        <button className="cmd" onClick={() => {
          const t = useStore.getState().toast
          navigator.clipboard?.writeText(cmd).then(() => t('update command copied'), () => t('copy blocked - select it manually'))
            ?? t('copy unavailable - select it manually')
        }}><code>{cmd}</code></button>
      </Tip>
      <Tip side="top" label="Dismiss this version">
        <button className="x" onClick={dismiss}><XIcon size={13} /></button>
      </Tip>
    </div>
  )
}

const ZOOMS = [2, 1.5, 1, 0.5, 0.25, 0.1]

/** Zoom preset dropdown on the percentage readout. */
function ZoomMenu() {
  const scale = useStore((s) => s.scale)
  const pop = usePopover()
  const go = (fn: () => void) => { fn(); pop.setOpen(false) }
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <Tip side="bottom" label="Zoom presets">
        <button className="sh-pill-btn pct" onClick={pop.toggle}>{Math.round(scale * 100)}%</button>
      </Tip>
      <Popover pop={pop}>
        {ZOOMS.map((z) => (
          <button key={z} onClick={() => go(() => canvasCtl.zoomTo(z))}>
            <span>{z * 100}%</span>
            {z === 1 && <kbd>⇧0</kbd>}
            {Math.abs(scale - z) < 0.03 && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
        <i className="div" />
        <button onClick={() => go(canvasCtl.fitAll)}><span>Fit all</span><kbd>⇧1</kbd></button>
        <button onClick={() => go(() => { const k = useStore.getState().selection; if (k.length) canvasCtl.fitNodes(k) })}>
          <span>Fit selection</span><kbd>⇧2</kbd>
        </button>
      </Popover>
    </div>
  )
}

/** Theme dropdown, scoped like the device digits: the selection when one exists, every
 *  frame otherwise. The trigger reflects the scope's MAJORITY (per-frame overrides never
 *  flip a board-level trigger - it reports the level it acts on, same rule as the shell).
 *  The dropdown chrome is the shared ThemePicker; this adapter owns the canvas wiring. */
function ThemeMenu() {
  const nodes = useStore((s) => s.nodes)
  const selection = useStore((s) => s.selection)
  const viewTheme = useStore((s) => s.viewTheme)
  const scoped = selection.length > 0
  const scope = scoped ? nodes.filter((n) => selection.includes(n.key)) : []
  const majority = scoped
    ? (scope.length ? [...scope.reduce((m, n) => m.set(n.theme, (m.get(n.theme) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0][0] : viewTheme)
    : viewTheme
  // the tick shows only a UNIFORM scope (mixed selection = no theme is "the" one), while
  // the trigger reports the majority - the level the control acts on
  const uniform = scoped ? (scope.length && scope.every((n) => n.theme === scope[0].theme) ? scope[0].theme : null) : viewTheme
  const pick = (t: string) => {
    const st = useStore.getState()
    scoped ? st.setSelectedTheme(t) : st.setTheme(t)
  }
  const hint = scoped ? `${selection.length} selected · D` : 'all frames · D'
  return <ThemePicker value={majority} checked={uniform} onSelect={pick} hint={hint} />
}

export function App() {
  // B0.1: per-field selectors, NOT `useStore()` (which subscribes to the whole store and
  // re-rendered the entire shell on every setScale tick during a pan/zoom).
  const manifest = useStore((s) => s.manifest)
  const nodes = useStore((s) => s.nodes)
  const panelOpen = useStore((s) => s.panelOpen)
  const toasts = useStore((s) => s.toasts)
  const selection = useStore((s) => s.selection)
  const laser = useStore((s) => s.laser)
  const commentMode = useComments((s) => s.commentMode)
  // Laser/comment paint live outlines + do element-picking INSIDE the live frame; a scriptless
  // lean cover would hide them, so a body class suppresses the cover while either mode is active.
  useEffect(() => { document.body.classList.toggle('sh-laser', laser) }, [laser])
  useEffect(() => { document.body.classList.toggle('sh-commenting', commentMode) }, [commentMode])
  const { boot, applyManifest, togglePanel, select, setInteract, runTidy, toast, spawn } = useStore.getState()
  const [pillOpen, setPillOpen] = useState(true)
  const cm = useContextMenu()   // shared sidebar right-click menu (boards + scenes)

  // boot honors the deep link: board before load, play mode after it.
  // Selection + camera intent are restored by the Canvas boot effect. The module-level
  // guard makes boot single-shot: Fast Refresh re-runs mount effects on every App edit,
  // and a re-boot would revert live state to the long-consumed deep link.
  useEffect(() => {
    if (booted) return
    booted = true
    const start = async () => {
      if (bootHash.board) {
        if (bootHash.board !== useStore.getState().board)   // a deep link wins
          useStore.setState({ board: bootHash.board, boardAuto: bootHash.board === 'all-scenes' })
      } else if (!PUBLISHED) {
        // fresh open, no deep link: LAND on the first curated board (a tight, fast board = a good first
        // impression) instead of the auto all-scenes everything-board, which renders every frame at once.
        const first = (await fetchBoardNames().catch(() => [] as string[])).find((n) => n !== 'all-scenes')
        if (first && first !== useStore.getState().board) useStore.setState({ board: first, boardAuto: false })
      }
      const ok = await boot()
      urlReady.current = true
      if (ok && bootHash.play) enterPlay(bootHash.play)     // #/p/<board> alone = board start
    }
    void start()
  }, [])

  // the URL is a projection of state: design views replace in place; entering play and
  // every in-play navigation push, so browser back walks the flow
  const playState = useStore((s) => s.play)
  const prevPlay = useRef(playState)
  const urlReady = useRef(false)               // never clobber a deep link before boot restores it
  useEffect(() => {
    if (!urlReady.current) return
    const s = useStore.getState()
    if (playState) {
      const push = !prevPlay.current || prevPlay.current.at !== playState.at
      writeHash({ board: s.board, play: playState }, push)
    } else {
      writeHash({ board: s.board, n: s.selection })
    }
    prevPlay.current = playState
  })

  // browser back/forward: re-apply the URL as a whole - board first, then play or
  // selection against the newly loaded state. writeHash skips identical hashes, so
  // restores never echo back into history.
  useEffect(() => {
    const onPop = async () => {
      const h = parseHash()
      let s = useStore.getState()
      if (h.board && h.board !== s.board) {
        if (s.play) s.setPlay(null)            // a stale overlay must never survive into another board
        await s.switchBoard(h.board)
        s = useStore.getState()
        if (s.board !== h.board) return        // switch failed; the projection effect will re-sync the URL
      }
      if (h.play) {
        if (s.play) playCtl.sync(h.play)
        else enterPlay(h.play)
      } else {
        if (s.play) s.setPlay(null)
        const keys = (h.n ?? []).filter((k) => s.nodes.some((n) => n.key === k))
        useStore.setState({ selection: keys })
        setTimeout(() => (keys.length ? canvasCtl.fitNodes(keys) : canvasCtl.fitAll()), 60)
      }
    }
    // hashchange too: pasting a link into the same tab or editing the URL bar changes
    // the hash WITHOUT a popstate - ignoring it let the projection rewrite the URL back.
    // Our own writeHash never fires either event (history API), so there is no echo;
    // back/forward fires both, and the handler is idempotent under the double call.
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop) }
  }, [])

  // page title follows the open board
  const board = useStore((s) => s.board)
  useEffect(() => { document.title = board ? `${boardLabel(board)} - Marver` : 'Marver' }, [board])

  // favicon follows the mode: blue pack in design mode, purple pack in interact.
  // The links are rebuilt (not toggled) so the set stays deterministic; the .ico is
  // design-blue only, so interact mode omits it and the browser takes the purple PNGs.
  const interactingIcon = useStore((s) => s.interact !== null)
  useEffect(() => {
    const sfx = interactingIcon ? '-interactive' : ''
    document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((l) => l.remove())
    const add = (rel: string, href: string, attrs: Record<string, string> = {}) => {
      const l = document.createElement('link')
      l.rel = rel
      l.href = href
      for (const [k, v] of Object.entries(attrs)) l.setAttribute(k, v)
      document.head.appendChild(l)
    }
    if (!interactingIcon) add('icon', `${ROUTE}/favicon/favicon.ico`, { sizes: '48x48' })
    add('icon', `${ROUTE}/favicon/favicon-32x32${sfx}.png`, { type: 'image/png', sizes: '32x32' })
    add('icon', `${ROUTE}/favicon/favicon-16x16${sfx}.png`, { type: 'image/png', sizes: '16x16' })
    add('apple-touch-icon', `${ROUTE}/favicon/apple-touch-icon${sfx}.png`)
  }, [interactingIcon])

  // focus rings appear ONLY during real Tab navigation: the browser flips into keyboard
  // modality on ANY keystroke, so a shortcut press painted the stock double ring on
  // whatever was last clicked. Tab arms body.sh-kbd; any pointer use disarms it.
  useEffect(() => {
    const arm = (e: KeyboardEvent) => { if (e.key === 'Tab') document.body.classList.add('sh-kbd') }
    const disarm = () => document.body.classList.remove('sh-kbd')
    window.addEventListener('keydown', arm, true)
    window.addEventListener('pointerdown', disarm, true)
    return () => { window.removeEventListener('keydown', arm, true); window.removeEventListener('pointerdown', disarm, true) }
  }, [])

  // browser pinch-zoom is disabled inside the app: a pinch over the chrome (or anywhere
  // off-canvas) was scaling the PAGE and wrecking the layout. Canvas zoom is unaffected
  // (rzpp handles its own events), and keyboard cmd +/- is never intercepted.
  useEffect(() => {
    const block = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }
    const blockGesture = (e: Event) => e.preventDefault()
    window.addEventListener('wheel', block, { passive: false })
    document.addEventListener('gesturestart', blockGesture)
    return () => {
      window.removeEventListener('wheel', block)
      document.removeEventListener('gesturestart', blockGesture)
    }
  }, [])

  // live updates from the dev server (source-served shell has import.meta.hot)
  useEffect(() => {
    if (!import.meta.hot) return
    import.meta.hot.on('sh:manifest', (m: any) => applyManifest(m))
    // Live Jam presence: the daemon broadcasts the set of frames Marver is editing.
    // Camera-safe by construction - this only toggles a glow class, never moves the view.
    import.meta.hot.on('sh:jam-activity', (m: any) => useStore.getState().setWorking(Array.isArray(m?.frames) ? m.frames.filter((x: unknown) => typeof x === 'string') : []))
    // Live Jam reply delivery: the daemon just wrote to a board's log - fetch it NOW instead of
    // waiting out the 30s comment poll, so the reply + notification land within a second.
    import.meta.hot.on('sh:jam-comment', (m: any) => { if (typeof m?.board === 'string') useComments.getState().poke(m.board) })
    // A7 controlled HMR: a frame file changed. Reload exactly the affected frames through the
    // lease-aware path (idle frames now, leased ones deferred to a safe point) - never a shell
    // reload, never a React Fast Refresh yanking a frame the user is in.
    import.meta.hot.on('sh:frame-invalidated', (m: any) => {
      const frameIds = Array.isArray(m?.frameIds) ? m.frameIds.filter((x: unknown) => typeof x === 'string') : []
      if (frameIds.length && typeof m?.revision === 'string') useStore.getState().invalidateFrames(frameIds, m.revision)
    })
    // multi-viewer sync: another viewer (or an agent) saved this board. A clean canvas
    // re-boots silently, keeping whatever selection survives; a dirty one keeps its
    // edits and converges through the 409 path on its next save (disk wins).
    import.meta.hot.on('sh:board', (m: any) => {
      const s = useStore.getState()
      if (m?.name !== s.board || m?.sha256 === s.boardHash || s.dirty) return
      const sel = s.selection
      s.boot().then((ok) => {
        if (!ok) return
        const nodes = useStore.getState().nodes
        useStore.setState({ selection: sel.filter((k) => nodes.some((n) => n.key === k)) })
      })
    })
  }, [])

  // frame -> shell messages; source validated against known iframes
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('sh:')) return
      if (e.origin && e.origin !== location.origin) return   // a cross-origin-navigated frame keeps its WindowProxy; reject it
      // B0.3: O(1) registry lookup - also the security gate (unknown source = not a
      // registered frame = dropped), replacing a per-message iframe scan + DOM walk.
      const reg = frameByWindow(e.source)
      if (!reg) return
      const { key: nodeKey, iframe: el } = reg
      const s = useStore.getState()

      if (data.type === 'sh:ready') {
        s.setStatus(nodeKey, 'ready')
      } else if (data.type === 'sh:error') {
        s.setStatus(nodeKey, 'error', String(data.message ?? 'unknown error'))
      } else if (data.type === 'sh:exit-interact') {
        if (s.interact === nodeKey) setInteract(null)
      } else if (data.type === 'sh:measure') {
        // Generation guard: the sender echoes ITS document's URL rev; a
        // WindowProxy survives navigation, so a stale pre-navigation message would
        // otherwise route as if it came from the current document. Compare against
        // the iframe's CURRENT src - mismatched generations are dropped.
        const gen = el.src.match(/[?&]r=(\d+)/)?.[1] ?? ''
        if (String(data.gen ?? '') !== gen) return
        // measureNode does the rest of the admission (content frames only,
        // frame-id match, finite positive, clamped)
        s.measureNode(nodeKey, String(data.frame ?? ''), Number(data.ownWidth), Number(data.measuredWidth), Number(data.height))
      } else if (data.type === 'sh:laser-copy') {
        // laser click = copy the element's full address for the agent: WHERE it lives on
        // the canvas ([board ▸ scene]) + frame source file + css path (+ jsx source loc)
        const n = s.nodes.find((x) => x.key === nodeKey)
        const f = n && s.frameFor(n)
        // drop a stale post that outran a frame swap (the sender echoes its frame id)
        if (f && String(data.id ?? '') === f.id) {
          const addr = `[${s.board} ▸ ${f.scene || '(root)'}]  ${f.file} · ${String(data.path ?? '')}${data.source ? ` (${String(data.source)})` : ''}`
          // success confirms IN the frame's hover label (right where the eyes are);
          // only failure needs the toast
          navigator.clipboard.writeText(addr).then(
            () => el.contentWindow?.postMessage({ type: 'sh:copy-ok', seq: data.seq }, location.origin),
            () => toast('copy blocked - click the canvas first'))
        }
      } else if (data.type === 'sh:frame-down') {
        // clicks INSIDE a frame never reach the shell document - the frame reports
        // them so an open thread card dismisses modal-style from anywhere
        const c = commentsStore()
        if (c.active) c.setActive(null)
      } else if (data.type === 'sh:picked') {
        // comment mode: the frame reports the picked element - stage the draft on
        // that node (picking while a thread is open replaces it, modal-style);
        // the CommentLayer opens the composer at the pin
        const c = commentsStore()
        if (c.active) c.setActive(null)
        if (c.commentMode) c.setDraft({ nodeKey, frame: String(data.id ?? ''), anchor: data.anchor })
      } else if (data.type === 'sh:go') {
        const target = String(data.target ?? '')
        const carry = s.interact === nodeKey   // a goto from inside an interacting frame
        // CARRIES interact mode to the target - walking a flow must not eject you to
        // design mode at every hop (and must survive a board switch)
        const existing = s.nodes.find((n) => n.frame === target && !n.missing)
        if (existing) {
          gotoSeq++                                  // a local goto supersedes any cross-board one in flight
          select(existing.key)
          if (carry) setInteract(existing.key)
          setTimeout(() => canvasCtl.fitNode(existing.key), 50)
        } else void gotoAcrossBoards(target, carry)
      } else if (data.type === 'sh:wheel') {
        // B0.2: a passive frame forwarded a wheel event; the canvas owns it. Never for the
        // interact target or play (the app scrolls itself - the parent stays authoritative).
        if (s.play || s.interact === nodeKey) return
        const nums = [data.deltaX, data.deltaY, data.clientX, data.clientY].map(Number)
        if (!nums.every(Number.isFinite)) return
        const [deltaX, deltaY, localX, localY] = nums
        const rect = el.getBoundingClientRect()
        // iframe-local (untransformed CSS px) -> shell-screen px: rect is the frame's
        // transformed size, so rect.width/clientWidth is its effective on-screen scale.
        // Plain rect.left+localX would put the zoom origin in the wrong place when zoomed.
        const sx = el.clientWidth ? rect.width / el.clientWidth : 1
        const sy = el.clientHeight ? rect.height / el.clientHeight : 1
        canvasCtl.wheel({
          deltaX, deltaY, deltaMode: Number(data.deltaMode) || 0,
          ctrlKey: !!data.ctrlKey, metaKey: !!data.metaKey,
          clientX: rect.left + localX * sx, clientY: rect.top + localY * sy,
        })
      } else if (data.type === 'sh:interaction') {
        // A6: the frame reports transient laser/comment engagement (pointer inside + mode on).
        // While engaged the frame is leased, so a hot update to it defers until disengage.
        s.setExternalLease(nodeKey, 'laser', !!data.laser)
        s.setExternalLease(nodeKey, 'comment', !!data.comment)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // keyboard: t tidy · d theme · ⌘\ panel · Escape exit · shift+0/1/2 zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const s = useStore.getState()
      if (s.play) return                       // play mode owns the keyboard (Play.tsx)
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); togglePanel(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); setPillOpen((o) => !o); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); s.selectAll(); return }
      if (e.metaKey || e.ctrlKey) return
      if (e.key === 'Escape') {
        const c = commentsStore()
        if (c.commentMode || c.active || c.draft) { c.setMode(false); c.setActive(null); c.setDraft(null) }
        else if (s.laser) s.setLaser(false)          // Escape also exits laser mode (parity with comment)
        else s.interact ? setInteract(null) : select(null)
      }
      if (e.key === 'p') enterPlay()
      // H hides all chrome (shared binary Hide-UI); press again to reveal. Not persisted,
      // so a refresh always restores it (the safety net for a forgotten toggle).
      if (e.key === 'h') { toggleHideUI(); return }
      if (e.key === 't') { animateLayout(); runTidy() }
      // laser and comment mode are one-at-a-time: comment mode already highlights
      // what you'd click, so stacking the full rainbow on top only adds noise
      if (e.key === 'l') {
        if (!s.laser) commentsStore().setMode(false)
        s.setLaser(!s.laser)
      }
      // C = comment mode (the Figma/Miro convention) · Shift+C = hide/show
      // pins · Shift+P = copy file path(s) (P alone is play; D6, changelog 0.4.0)
      if (e.key === 'c' && !e.shiftKey) {
        const c = commentsStore()
        if (!c.commentMode) s.setLaser(false)
        c.setMode(!c.commentMode)
        toast(c.commentMode ? 'comment mode off' : 'comment mode - click an element in a frame')
      }
      if (e.key === 'C' && e.shiftKey) { const c = commentsStore(); c.setShow(!c.show) }
      // Shift+L = laser comment: the laser-sharp lighting on the element a comment tags
      // (pick hover, compose lock, open-thread highlight). Pins and cards stay - this
      // only dims the lighting inside the artwork.
      if (e.key === 'L' && e.shiftKey) {
        const c = commentsStore()
        c.setShowAnchor(!c.showAnchor)
        toast(c.showAnchor ? 'laser comment off' : 'laser comment on')
      }
      if (e.key === 'P' && e.shiftKey && s.selection.length) {
        const paths = s.selection
          .map((k) => { const n = s.nodes.find((x) => x.key === k); const f = n && s.frameFor(n); return f ? framePath(s.board, f) : undefined })
          .filter((p): p is string => !!p)
        if (paths.length) {
          // pulse the toolbar icon into a check ONLY on a real copy success
          navigator.clipboard.writeText(paths.join('\n')).then(
            () => { toast(paths.length > 1 ? `${paths.length} paths copied` : 'path copied'); s.pulsePath() },
            () => toast('copy blocked - click the canvas first'))
        }
      }
      if (e.key === 'd' && CONFIG.themes.length > 1) {
        // scoped like the device digits: selection pins those frames; no selection cycles
        // the global VIEW theme (sticky across boards - the user's preference)
        if (s.selection.length) {
          const scope = s.nodes.filter((n) => s.selection.includes(n.key))
          const cur = scope.length && scope.every((n) => n.theme === scope[0].theme) ? scope[0].theme : CONFIG.themes[0]
          s.setSelectedTheme(CONFIG.themes[(CONFIG.themes.indexOf(cur) + 1) % CONFIG.themes.length])
        } else {
          s.setTheme(CONFIG.themes[(CONFIG.themes.indexOf(s.viewTheme) + 1) % CONFIG.themes.length])
        }
      }
      if (e.shiftKey && e.code === 'Digit0') canvasCtl.zoom100()
      if (e.shiftKey && e.code === 'Digit1') canvasCtl.fitAll()
      if (e.shiftKey && e.code === 'Digit2' && s.selection.length) canvasCtl.fitNodes(s.selection)
      // plain digits: 0 = default, 1..n = devices. Scoped to the selection when one
      // exists, board-wide otherwise. Every path tidies - presets never scramble layout.
      if (!e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        const idx = Number(e.code.slice(5))
        const names = Object.keys(CONFIG.viewports)
        if (idx !== 0 && !names[idx - 1]) return
        const name = idx === 0 ? null : names[idx - 1]
        animateLayout()
        if (s.selection.length) {
          s.resizeSelected(name)
          setTimeout(() => canvasCtl.fitNodes(useStore.getState().selection), 30)
        } else {
          s.setDeviceView(name)
          setTimeout(() => canvasCtl.fitAll(), 30)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the sidebar reflects the ACTIVE BOARD: only scenes/frames with a node on this board
  const onBoard = new Set(nodes.map((n) => n.frame))
  const frames = (manifest?.frames ?? []).filter((f) => onBoard.has(f.id))
  // scene groups follow the CANVAS reading order (earliest node y, then x), the
  // same law as frame rows - a story board's phases list top-to-bottom as laid out
  const scenes = [...new Set(frames.map((f) => f.scene))].sort((a, b) => {
    const min = (sc: string) => nodes.reduce((acc, n) => {
      const f = frames.find((x) => x.id === n.frame)
      if (f?.scene !== sc) return acc
      return !acc || n.y < acc.y || (n.y === acc.y && n.x < acc.x) ? { y: n.y, x: n.x } : acc
    }, null as { y: number; x: number } | null)
    const ma = min(a), mb = min(b)
    if (!ma || !mb) return ma ? -1 : mb ? 1 : a.localeCompare(b)
    return ma.y - mb.y || ma.x - mb.x || a.localeCompare(b)
  })
    .map((name) => ({ name, frames: frames.filter((f) => f.scene === name).length }))
  // frame ids currently selected, for marking their parent scenes as `held`
  const selFrames = new Set(nodes.filter((n) => selection.includes(n.key)).map((n) => n.frame))
  // the shell follows the user's VIEW theme - per-frame pins never flip the chrome
  const dark = useStore((s) => s.viewTheme) === 'dark'
  // interact mode re-accents the ENTIRE shell purple - one token override class,
  // everything derived from --accent follows (mark, sidebar, bars, handles, beams)
  const interacting = useStore((s) => s.interact !== null)

  // leaving interact returns keyboard focus to the shell: while a frame held focus its
  // document swallowed every shortcut (the bridge only forwards Escape), so d/t/digits
  // appeared dead after an interact session
  const appRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!interacting) appRef.current?.focus({ preventScroll: true })
  }, [interacting])

  return (
    <div ref={appRef} tabIndex={-1} className={`sh-app${dark ? ' dark' : ''}${interacting ? ' interacting' : ''}`}>
      <Canvas />
      <SelectionBar />

      {/* floating pill panel (no top bar - spec); panel and fab are both always
          mounted so collapse/expand can crossfade-morph between them */}
      <aside className={`sh-panel${panelOpen ? '' : ' closed'}`} aria-hidden={!panelOpen}>
          <div className="sh-panel-top">
            {/* the mark links to the marver site; the title is the humanized repo name (C2: names
                the project so two concurrent canvases are never confused), ellipsed if long */}
            <Tip side="bottom" label="marver.design">
              <a className="mark-link" href={poweredByUrl(CONFIG.projectName, PUBLISHED ? 'published-canvas' : 'dev-canvas', 'shell')} target="_blank" rel="noreferrer" aria-label="marver.design" tabIndex={panelOpen ? 0 : -1}>
                <ParallelogramDuoIcon size={21} className="mark" />
              </a>
            </Tip>
            <span className="name" title={CONFIG.projectName || 'Marver'}>{CONFIG.projectName ? humanize(CONFIG.projectName) : 'Marver'}</span>
            <Tip side="bottom" label={<><b>Collapse panel</b><span>⌘\</span></>}><button className="sh-ibtn" onClick={togglePanel} tabIndex={panelOpen ? 0 : -1}><PanelFilledIcon size={17} /></button></Tip>
          </div>
          <div className="sh-panel-scroll">
            <div className="hd">Boards</div>
            <BoardList onMenu={cm.open} />
            <div className="hd" style={{ marginTop: 10 }}>Scenes</div>
            {scenes.map((sc) => (
              <SceneGroup key={sc.name} name={sc.name} count={sc.frames}
                held={frames.some((f) => f.scene === sc.name && selFrames.has(f.id))}
                onContextMenu={(e) => cm.open(e, [{
                  label: 'Copy path',
                  icon: <SignpostIcon size={15} />,
                  onClick: () => copyToClipboard(sc.name
                    ? `board: ${useStore.getState().board} · scene: ${sc.name}  (design/scenes/${sc.name}/)`
                    : `board: ${useStore.getState().board} · scene: (root)`, 'path copied'),
                }])}
                onPick={() => {
                  const keys = nodes.filter((n) => frames.some((f) => f.scene === sc.name && f.id === n.frame) && !n.missing).map((n) => n.key)
                  if (!keys.length) return
                  useStore.getState().selectMany(keys)
                  canvasCtl.fitNodes(keys)
                }}>
                {(() => {
                  // variant groups render as ONE surface row with A/B/C chips
                  const nodeFor = (id: string) => nodes.find((x) => x.frame === id && !x.missing) ?? nodes.find((x) => x.frame === id)
                  // sidebar order follows the CANVAS (reading order: rows top-to-bottom,
                  // left-to-right) - a story board's list must tell the same story as its
                  // layout. Grouped frames anchor at their group's earliest position so
                  // the run stays contiguous; members sort by letter within it.
                  const pos = (id: string) => { const n = nodeFor(id); return n ? { y: n.y, x: n.x } : { y: Number.MAX_SAFE_INTEGER, x: 0 } }
                  const sceneFrames = frames.filter((f) => f.scene === sc.name)
                  const groupPos = new Map<string, { y: number; x: number }>()
                  for (const f of sceneFrames) {
                    if (!f.variantGroup) continue
                    const p = pos(f.id), g = groupPos.get(f.variantGroup)
                    if (!g || p.y < g.y || (p.y === g.y && p.x < g.x)) groupPos.set(f.variantGroup, p)
                  }
                  const keyOf = (f: FrameEntry) => f.variantGroup ? groupPos.get(f.variantGroup)! : pos(f.id)
                  sceneFrames.sort((a, b) => {
                    const ka = keyOf(a), kb = keyOf(b)
                    return ka.y - kb.y || ka.x - kb.x || (a.variant ?? '').localeCompare(b.variant ?? '')
                  })
                  const go = (id: string, shift: boolean) => {
                    const n = nodeFor(id)
                    if (!n) return
                    select(n.key, shift)
                    if (!shift) canvasCtl.fitNode(n.key)
                  }
                  const frameMenu = (fr: FrameEntry): MenuItem[] => [
                    { label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(framePath(useStore.getState().board, fr), 'path copied') },
                  ]
                  const seen = new Set<string>()
                  const rows: ReactNode[] = []
                  for (const f of sceneFrames) {
                    if (f.variantGroup && !seen.has(f.variantGroup)) {
                      seen.add(f.variantGroup)
                      const members = sceneFrames.filter((m) => m.variantGroup === f.variantGroup)
                        .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
                      if (members.length > 1) {
                        const rel = f.variantGroup === sc.name ? 'Variants'
                          : cap(f.variantGroup.slice(sc.name.length + 1).replace(/-/g, ' '))
                        const memberKeys = members.map((m) => nodeFor(m.id)?.key).filter((k): k is string => !!k)
                        const allOn = memberKeys.length > 0 && memberKeys.every((k) => selection.includes(k))
                        // held = SOME member active (same quiet wash as scene headers) - the
                        // group participates without claiming full selection
                        const held = !allOn && memberKeys.some((k) => selection.includes(k) || useStore.getState().interact === k)
                        // group header: click selects EVERY variant (the quick compare-and-test grab)
                        // the group row leads with the flask - variant-ness IS the row's
                        // identity; members carry their letter chips, indented below it
                        rows.push(
                          <div key={`g:${f.variantGroup}`} className={`sub vgroup${allOn ? ' on' : ''}${held ? ' held' : ''}`}
                            title="Select all variants"
                            onClick={() => { useStore.getState().selectMany(memberKeys); canvasCtl.fitNodes(memberKeys) }}>
                            <VariantsIcon size={13} className="iicon" />
                            <span className="glabel">{rel}</span>
                          </div>,
                        )
                        // one row per variant: [letter chip] + name, individually selectable
                        for (const m of members) {
                          const n = nodeFor(m.id)
                          const on = !!n && selection.includes(n.key)
                          const nm = m.title ?? cap((m.id.split('/').pop() ?? '').replace(/^[a-z]-/, '').replace(/-/g, ' '))
                          rows.push(
                            <div key={m.id} className={`sub vrow${on ? ' on' : ''}`} onClick={(e) => go(m.id, e.shiftKey)}
                              onContextMenu={(e) => cm.open(e, frameMenu(m))}>
                              <span className={`chip${on ? ' on' : ''}`}>{(m.variant ?? '?').toUpperCase()}</span><span className="nm">{nm}</span>
                            </div>,
                          )
                        }
                        continue
                      }
                    } else if (f.variantGroup) continue
                    const n = nodeFor(f.id)
                    const on = !!n && selection.includes(n.key)
                    rows.push(
                      <div key={f.id} className={`sub${on ? ' on' : ''}`} onClick={(e) => go(f.id, e.shiftKey)} onContextMenu={(e) => cm.open(e, frameMenu(f))} title={f.intent}>
                        {/* every frame leads with an icon: intent glyph for content
                            frames, the plain frame rectangle for UI frames */}
                        {f.intent
                          ? <IntentGlyph intent={f.intent} size={13} className="iicon" aria-label={f.intent} />
                          : <FrameRectIcon size={13} className="iicon" />}
                        {cap(f.id.split('/').slice(1).join('/') || f.id)}
                      </div>,
                    )
                  }
                  return rows
                })()}
              </SceneGroup>
            ))}
            {frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
          </div>
      </aside>
      <Tip side="bottom" label={<><b>Open panel</b><span>⌘\</span></>}>
        <button className={`sh-fab${panelOpen ? ' hidden' : ''}`} onClick={togglePanel}
          aria-hidden={panelOpen} tabIndex={panelOpen ? -1 : 0}><PanelHollowIcon size={18} /></button>
      </Tip>

      {/* floating pill nav, top right; collapses to a chip (same ladder as panel/fab) */}
      <nav className={`sh-pill${pillOpen ? '' : ' closed'}`} aria-hidden={!pillOpen}>
        {/* far-left section: actions - comment mode, laser, tidy */}
        <CommentButton />
        <LaserButton />
        <Tip side="bottom" label={<><b>Tidy layout</b><span>T</span></>}>
          <button className="sh-pill-btn" onClick={() => { animateLayout(); runTidy() }}><ColumnsIcon size={16} /></button>
        </Tip>
        <i className="sep" />
        <DeviceMenu />
        <ThemeMenu />
        <i className="sep" />
        <ZoomMenu />
        <i className="sep" />
        {/* far right: view management - prototype, hide, collapse */}
        <Tip side="bottom" label={<><b>Prototype view</b><span>P</span></>}>
          <button className="sh-pill-btn" onClick={() => enterPlay()}><PlayIcon size={15} /></button>
        </Tip>
        <HideUIButton />
        <Tip side="bottom" label={<><b>Collapse toolbar</b><span>⌘/</span></>}>
          <button className="sh-pill-btn" onClick={() => setPillOpen(false)} tabIndex={pillOpen ? 0 : -1}>
            <PanelFilledIcon size={17} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </Tip>
      </nav>
      <Tip side="bottom" label={<><b>Open toolbar</b><span>⌘/</span></>}>
        <button className={`sh-pill-fab${pillOpen ? ' hidden' : ''}`} onClick={() => setPillOpen(true)}
          aria-hidden={pillOpen} tabIndex={pillOpen ? -1 : 0}><PanelHollowIcon size={18} style={{ transform: 'rotate(90deg)' }} /></button>
      </Tip>

      <PlayOverlay />
      <CommentsController />
      <ContextMenu menu={cm.menu} close={cm.close} />

      {CONFIG.setup
        ? <div className="sh-banner">no app detected - designs would be built from nothing. See design/instructions/setup.md, then restart</div>
        : CONFIG.noTheme && <div className="sh-banner">no theme configured - frames render unstyled. Create design/theme.css importing your app's stylesheet (or set theme in design/config.ts)</div>}
      <UpdatePill />

      <JamToasts toasts={toasts} />
    </div>
  )
}

/** The bottom-right notification corner. Plain toasts render as before.
 *  Jam pills are FRAME-FIRST (icon + frame title, then Marver · preview) and stack as a DECK:
 *  1-2 show in full; 3+ collapse to the newest pill with two card edges peeking beneath and a
 *  +N badge - click to expand the full list (newest first, timestamps, Clear all). */
function JamToasts({ toasts }: { toasts: import('./store.ts').Toast[] }) {
  const [expanded, setExpanded] = useState(false)
  const plain = toasts.filter((t) => !t.jam)
  const jams = toasts.filter((t) => t.jam)
  useEffect(() => { if (jams.length <= 2) setExpanded(false) }, [jams.length])
  const deck = jams.length > 2 && !expanded
  const newest = jams[jams.length - 1]
  return (
    <div className="sh-toasts">
      {plain.slice(-2).map((t) => <div key={t.id} className="sh-toast"><CheckIcon size={12} /> {t.text}</div>)}
      {expanded && jams.length > 2 && (
        <div className="sh-jam-list">
          <div className="sh-jam-listhead">
            <span>{jams.length} NOTIFICATIONS</span>
            <button onClick={() => { useStore.getState().clearJamToasts(); setExpanded(false) }}>Clear all</button>
            <button aria-label="Collapse" onClick={() => setExpanded(false)}><XIcon size={12} /></button>
          </div>
          {[...jams].reverse().map((t) => <JamToast key={t.id} id={t.id} note={t.jam!} />)}
        </div>
      )}
      {!expanded && (deck
        ? (
          <div className="sh-jam-deck" onClick={() => setExpanded(true)} role="button" aria-label={`${jams.length} notifications - expand`}>
            <div className="sh-jam-ghost g2" />
            <div className="sh-jam-ghost g1" />
            {newest?.jam && <JamToast id={newest.id} note={newest.jam} badge={jams.length - 1} inert />}
          </div>
        )
        : jams.map((t) => <JamToast key={t.id} id={t.id} note={t.jam!} />))}
    </div>
  )
}

/** A data-goto whose target frame is not on the current board follows the frame HOME:
 *  the first curated board (switcher rank) that pins it is switched to and the frame
 *  focused there - a link is navigation, and navigation never edits a board. Only a
 *  frame NO board pins spawns onto the current board (the original prototype behavior
 *  for unpinned targets); an id the manifest doesn't know stays a toast. Every goto
 *  bumps `gotoSeq` so a slow older resolution can never override newer navigation. */
let gotoSeq = 0
async function gotoAcrossBoards(target: string, carry: boolean) {
  const s = useStore.getState()
  // an id the manifest doesn't know resolves NOWHERE - a tombstone pin on some board
  // must not send us on a trip that ends in a silent timeout
  if (!s.manifest?.frames.some((f) => f.id === target)) return s.toast(`unknown goto target "${target}"`)
  const seq = ++gotoSeq
  let home: string | null = null
  try {
    const names = (await fetchBoardNames()).filter((n) => n !== s.board && n !== 'all-scenes')
    for (const name of names) {
      if ((await boardFrames(name)).includes(target)) { home = name; break }
    }
  } catch {
    // a transport failure is NOT proof the frame is unpinned - spawning here would
    // recreate the board mutation this function exists to prevent
    return useStore.getState().toast(`goto: could not read the boards - try again`)
  }
  if (seq !== gotoSeq) return                        // superseded by newer navigation
  if (!home) {
    // no curated board pins it - the original prototype behavior: spawn beside you
    const st = useStore.getState()
    const node = st.spawn(target)
    if (!node) return st.toast(`unknown goto target "${target}"`)
    st.select(node.key)
    if (carry) st.setInteract(node.key)
    setTimeout(() => canvasCtl.fitNode(node.key), 50)
    return
  }
  await s.switchBoard(home)
  for (let i = 0; i < 12; i++) {                     // the board commits async - retry like viewNote
    if (seq !== gotoSeq) return
    const st = useStore.getState()
    if (st.board === home) {                         // a cancelled/failed switch must not select here
      const node = st.nodes.find((n) => n.frame === target && !n.missing)
      if (node) {
        st.select(node.key)
        if (carry) st.setInteract(node.key)
        setTimeout(() => canvasCtl.fitNode(node.key), 50)
        return
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** View from a notification: threads are frame-scoped, so first try to reveal RIGHT HERE
 *  (the current board may show the thread's frame); only when it doesn't, switch to the
 *  note's origin board and retry while its comments load. Dismiss only on success: a
 *  cross-board note must never be a destructive no-op. */
async function viewNote(note: import('./store.ts').JamNote, dismiss: () => void) {
  if (revealThread(note.threadId)) { dismiss(); return }
  const s = useStore.getState()
  if (note.board && s.board !== note.board) await s.switchBoard(note.board)
  for (let i = 0; i < 12; i++) {
    if (revealThread(note.threadId)) { dismiss(); return }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** One jam pill, frame-first: row 1 = intent icon + FRAME TITLE (blue) · age; row 2 = Marver · preview.
 *  `badge` shows the +N deck count (replacing View); `inert` disables inner clicks (the deck handles it). */
function JamToast({ id, note, badge, inert }: { id: number; note: import('./store.ts').JamNote; badge?: number; inert?: boolean }) {
  const dismiss = () => useStore.getState().dismissToast(id)
  return (
    <div className="sh-toast jam">
      <span className="sh-jam-mark"><ParallelogramFillIcon size={17} /></span>
      <div className="sh-jam-txt">
        <b className="sh-jam-frame"><span className="t">{note.frameTitle ?? note.board}</span></b>
        <span className="sh-jam-prev">{note.preview}</span>
      </div>
      {badge != null
        ? <span className="sh-jam-badge">+{badge}</span>
        : !inert && <>
            <button className="sh-jam-view" onClick={() => void viewNote(note, dismiss)}>View</button>
            <button className="sh-jam-x" aria-label="Dismiss" onClick={dismiss}><XIcon size={13} /></button>
          </>}
    </div>
  )
}
