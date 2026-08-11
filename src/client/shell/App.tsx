import { Component, cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, CONFIG } from './store.ts'
import { ROUTE } from '../const.ts'
import { animateLayout, Canvas, canvasCtl } from './canvas/Canvas.tsx'
import { CaretIcon, CheckIcon, DevicesIcon, GridIcon, MoonIcon, PanelFilledIcon, PanelHollowIcon, ParallelogramDuoIcon, PlayIcon, PlusIcon, SignpostIcon, StackIcon, SunIcon, deviceIcon } from './icons.tsx'

/** shadcn-style tooltip: snappy (150ms in, instant out), contrast-flipped, zoom-fade.
 *  Portaled to the app root - glass never nests, and neither do overlays. */
function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    timer.current = window.setTimeout(() => setPos({ x: r.left + r.width / 2, y: r.top - 7 }), 150)
  }
  const hide = () => { window.clearTimeout(timer.current); setPos(null) }
  const app = document.querySelector('.sh-app')
  const child = children as ReactElement<any>
  return (
    <>
      {cloneElement(child, {
        onMouseEnter: (e: React.MouseEvent) => { child.props.onMouseEnter?.(e); show(e) },
        onMouseLeave: (e: React.MouseEvent) => { child.props.onMouseLeave?.(e); hide() },
        onClick: (e: React.MouseEvent) => { child.props.onClick?.(e); hide() },
      })}
      {pos && app && createPortal(<div className="sh-tip" style={{ left: pos.x, top: pos.y }}>{label}</div>, app)}
    </>
  )
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** One collapsible scene group in the sidebar. */
function SceneGroup({ name, count, children }: { name: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button className="it" onClick={() => setOpen(!open)}>
        <CaretIcon size={11} className="tw" style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
        <span>{cap(name) || '(root)'}</span>
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

/** Shared popover machinery: trigger position, outside-click close, portal to the app
 *  root (glass never nests - a nested backdrop-filter cannot sample the page). */
function usePopover() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const toggle = () => {
    if (!open && boxRef.current) {
      const r = boxRef.current.getBoundingClientRect()
      setPos({ left: r.left, top: r.bottom + 10 })
    }
    setOpen(!open)
  }
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      const t = e.target as globalThis.Node
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  return { open, setOpen, pos, boxRef, menuRef, toggle }
}

function Popover({ pop, children }: { pop: ReturnType<typeof usePopover>; children: ReactNode }) {
  const app = document.querySelector('.sh-app')
  if (!pop.open || !app) return null
  return createPortal(
    <div className="sh-menu" ref={pop.menuRef} style={{ left: pop.pos.left, top: pop.pos.top }}>{children}</div>,
    app,
  )
}

/** Board switcher: one board on screen at a time. Boards are agent-authored files in
 *  design/boards/ - the list is fetched fresh on every open so new files show instantly. */
function BoardMenu() {
  const board = useStore((s) => s.board)
  const [names, setNames] = useState<string[]>([])
  const pop = usePopover()

  const toggle = async () => {
    if (!pop.open) {
      try {
        const list: { name: string }[] = await (await fetch(`${ROUTE}/api/boards`)).json()
        setNames(['everything', ...list.map((b) => b.name).filter((n) => n !== 'everything')])
      } catch { setNames(['everything']) }
    }
    pop.toggle()
  }
  const pick = async (name: string) => {
    pop.setOpen(false)
    await useStore.getState().switchBoard(name)
    setTimeout(() => canvasCtl.fitAll(), 60)
  }
  return (
    <div className="sh-board" ref={pop.boxRef}>
      <button className="it" onClick={toggle}>
        <StackIcon size={14} className="tw" />
        <span>{cap(board)}</span>
        <CaretIcon size={11} style={{ transform: pop.open ? 'rotate(180deg)' : undefined, color: 'var(--glass-ink-3)' }} />
      </button>
      <Popover pop={pop}>
        {names.map((n) => (
          <button key={n} onClick={() => pick(n)}>
            <StackIcon size={14} /><span>{cap(n)}</span>
            {n === board && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
      </Popover>
    </div>
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
  if (!node || !frame || node.missing) return null
  // anchor: centered over the bounding box of ALL selected frames, above the topmost
  const selNodes = nodes.filter((n) => selection.includes(n.key))
  const bx0 = Math.min(...selNodes.map((n) => n.x))
  const bx1 = Math.max(...selNodes.map((n) => n.x + n.w))
  const by0 = Math.min(...selNodes.map((n) => n.y))
  const { resizeSelected, spawn, toast } = useStore.getState()
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
  return (
    <div
      className="sh-ctx"
      style={{
        // centered over the selection's bounding box; translateX keeps it centered at any width
        left: `calc(var(--sh-tx, 0px) + var(--sh-s, 1) * ${(bx0 + bx1) / 2}px)`,
        top: `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${by0}px - 52px)`,
        transform: 'translateX(-50%)',
      }}
    >
      {multi && <>
        <Tip label={`${selection.length} frames selected`}><span className="cnt">{selection.length}</span></Tip>
        <i className="sep" />
      </>}
      {Object.entries(CONFIG.viewports).map(([name, vp]) => {
        const active = node.w === vp.width
        return (
          <Tip key={name} label={<><b>{cap(name)}</b><span>{vp.width} × {vp.height}</span></>}>
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
      <Tip label={multi ? `Copy ${selection.length} file paths` : 'Copy file path'}>
        <button className="icon"
          onClick={() => { navigator.clipboard.writeText(selectedFrames().map((f) => f.file).join('\n')); toast(multi ? `${selection.length} file paths copied` : 'file path copied') }}><SignpostIcon size={15} /></button>
      </Tip>
      <Tip label={multi ? 'Duplicate frames' : 'Duplicate frame'}>
        <button className="icon" onClick={() => selectedFrames().forEach((f) => spawn(f.id))}><PlusIcon size={15} /></button>
      </Tip>
    </div>
  )
}

/** Devices view: one click sizes every frame to a device width, tidies, and fits. */
function DeviceMenu() {
  const deviceView = useStore((s) => s.deviceView)
  const pop = usePopover()
  const pick = (name: string | null) => {
    animateLayout()
    useStore.getState().setDeviceView(name)
    pop.setOpen(false)
    setTimeout(() => canvasCtl.fitAll(), 30)
  }
  const entries = Object.entries(CONFIG.viewports)
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <button className="sh-pill-btn" onClick={pop.toggle}
        title={deviceView ? `device view: ${deviceView} (0 resets)` : 'device view (keys 1-' + entries.length + ')'}>
        {deviceIcon(deviceView, 16)}
        <CaretIcon size={11} style={{ transform: pop.open ? 'rotate(180deg)' : undefined }} />
      </button>
      <Popover pop={pop}>
        <button onClick={() => pick(null)} title="every frame at its own default size">
          <DevicesIcon size={15} /><span>Default</span><kbd>0</kbd>
          {deviceView === null && <CheckIcon size={13} className="chk" />}
        </button>
        <i className="div" />
        {entries.map(([name, vp], i) => (
          <button key={name} onClick={() => pick(name)} title={`${vp.width} × ${vp.height}`}>
            {deviceIcon(name)}<span>{cap(name)}</span><kbd>{i < 9 ? i + 1 : ''}</kbd>
            {deviceView === name && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
      </Popover>
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
      <button className="sh-pill-btn pct" onClick={pop.toggle} title="zoom presets">{Math.round(scale * 100)}%</button>
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

/** Global theme dropdown: sets every frame at once; the trigger reflects the board when uniform.
 *  The menu is PORTALED out of the pill: an element with backdrop-filter is a backdrop root,
 *  so a nested backdrop-filter samples the pill's surface instead of the page - flat grey. */
function ThemeMenu() {
  const nodes = useStore((s) => s.nodes)
  const pop = usePopover()
  const uniform = nodes.length && nodes.every((n) => n.theme === nodes[0].theme) ? nodes[0].theme : null
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <button className="sh-pill-btn" onClick={pop.toggle} title="theme for all frames (d)">
        {uniform === 'dark' ? <MoonIcon size={16} /> : <SunIcon size={16} />}
        <CaretIcon size={11} style={{ transform: pop.open ? 'rotate(180deg)' : undefined }} />
      </button>
      <Popover pop={pop}>
        {CONFIG.themes.map((t) => (
          <button key={t} onClick={() => { useStore.getState().setTheme(t); pop.setOpen(false) }}>
            {t === 'dark' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
            <span>{t}</span>
            {uniform === t && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
      </Popover>
    </div>
  )
}

export function App() {
  const { manifest, nodes, panelOpen, toasts, selection } = useStore()
  const { boot, applyManifest, togglePanel, select, setInteract, runTidy, toast, spawn } = useStore.getState()

  useEffect(() => { boot() }, [])

  // page title follows the open board
  const board = useStore((s) => s.board)
  useEffect(() => { document.title = board ? `${cap(board)} - Marver` : 'Marver' }, [board])

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
    if (import.meta.hot) import.meta.hot.on('sh:manifest', (m: any) => applyManifest(m))
  }, [])

  // frame -> shell messages (spec §6 protocol); source validated against known iframes
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('sh:')) return
      const iframes = [...document.querySelectorAll('iframe')]
      const el = iframes.find((f) => f.contentWindow === e.source) as HTMLIFrameElement | undefined
      if (!el) return
      const nodeKey = el.closest('[data-node]')?.getAttribute('data-node')
      if (!nodeKey) return
      const s = useStore.getState()

      if (data.type === 'sh:ready') {
        s.setStatus(nodeKey, 'ready')
      } else if (data.type === 'sh:error') {
        s.setStatus(nodeKey, 'error', String(data.message ?? 'unknown error'))
      } else if (data.type === 'sh:exit-interact') {
        if (s.interact === nodeKey) setInteract(null)
      } else if (data.type === 'sh:go') {
        const target = String(data.target ?? '')
        const existing = s.nodes.find((n) => n.frame === target && !n.missing)
        const node = existing ?? spawn(target)
        if (!node) return toast(`unknown goto target "${target}"`)
        select(node.key)
        // a goto from inside an interacting frame CARRIES interact mode to the target -
        // walking a flow must not eject you to design mode at every hop
        if (s.interact === nodeKey) setInteract(node.key)
        setTimeout(() => canvasCtl.fitNode(node.key), 50)
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
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); togglePanel(); return }
      if (e.metaKey || e.ctrlKey) return
      if (e.key === 'Escape') s.interact ? setInteract(null) : select(null)
      if (e.key === 't') { animateLayout(); runTidy() }
      if (e.key === 'd' && CONFIG.themes.length > 1) {
        // cycle themes from the board's current (uniform or first)
        const cur = s.nodes.length && s.nodes.every((n) => n.theme === s.nodes[0].theme) ? s.nodes[0].theme : CONFIG.themes[0]
        const next = CONFIG.themes[(CONFIG.themes.indexOf(cur) + 1) % CONFIG.themes.length]
        s.setTheme(next)
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
  const scenes = [...new Set(frames.map((f) => f.scene))].sort()
    .map((name) => ({ name, frames: frames.filter((f) => f.scene === name).length }))
  // the shell follows the board: majority-dark frames flip the whole chrome + canvas dark
  const dark = nodes.length > 0 && nodes.filter((n) => n.theme === 'dark').length > nodes.length / 2
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
            <ParallelogramDuoIcon size={21} className="mark" />
            <span className="name">Marver</span>
            <button className="sh-ibtn" onClick={togglePanel} title="collapse panel (⌘\\)" tabIndex={panelOpen ? 0 : -1}><PanelFilledIcon size={17} /></button>
          </div>
          <div className="sh-panel-scroll">
            <div className="hd">Board</div>
            <BoardMenu />
            <div className="hd" style={{ marginTop: 10 }}>Scenes</div>
            {scenes.map((sc) => (
              <SceneGroup key={sc.name} name={sc.name} count={sc.frames}>
                {frames.filter((f) => f.scene === sc.name).map((f) => {
                  const n = nodes.find((x) => x.frame === f.id && !x.missing) ?? nodes.find((x) => x.frame === f.id)
                  const on = !!n && selection.includes(n.key)
                  return (
                    <div key={f.id} className={`sub${on ? ' on' : ''}`} onClick={(e) => {
                      if (!n) return
                      select(n.key, e.shiftKey)
                      if (!e.shiftKey) canvasCtl.fitNode(n.key)
                    }}>{cap(f.id.split('/').slice(1).join('/') || f.id)}</div>
                  )
                })}
              </SceneGroup>
            ))}
            {frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
          </div>
      </aside>
      <button className={`sh-fab${panelOpen ? ' hidden' : ''}`} onClick={togglePanel} title="open panel (⌘\\)"
        aria-hidden={panelOpen} tabIndex={panelOpen ? -1 : 0}><PanelHollowIcon size={18} /></button>

      {/* floating pill nav, top right */}
      <nav className="sh-pill">
        <DeviceMenu />
        <ThemeMenu />
        <i className="sep" />
        <ZoomMenu />
        <button className="sh-pill-btn" onClick={() => { animateLayout(); runTidy() }} title="tidy layout (t)"><GridIcon size={16} /></button>
        <i className="sep" />
        <button className="sh-pill-btn off" title="play mode ships in M2"><PlayIcon size={15} /></button>
      </nav>

      {CONFIG.noTheme && <div className="sh-banner">no theme configured - frames render unstyled (design/config.ts → theme)</div>}

      <div className="sh-toasts">
        {toasts.map((t) => <div key={t.id} className="sh-toast"><CheckIcon size={12} /> {t.text}</div>)}
      </div>
    </div>
  )
}
