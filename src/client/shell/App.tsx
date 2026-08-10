import { Component, cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, CONFIG } from './store.ts'
import { Canvas, canvasCtl } from './canvas/Canvas.tsx'
import { BoundingBoxDuoIcon, CaretIcon, CheckIcon, DevicesIcon, GridIcon, MoonIcon, PanelCloseIcon, PanelOpenIcon, PlayIcon, PlusIcon, SignpostIcon, SunIcon, deviceIcon } from './icons.tsx'

/** shadcn-style tooltip: snappy (150ms in, instant out), contrast-flipped, zoom-fade.
 *  Portaled to the app root - glass never nests, and neither do overlays. */
function Tip({ label, children }: { label: string; children: ReactElement }) {
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

/** Selection toolbar: screen-space overlay above the selected frame - constant size at any
 *  zoom. Position derives from --sh-s/tx/ty (written per transform frame in Canvas), so
 *  pan/zoom tracking is pure CSS with zero React re-renders. */
function SelectionBar() {
  const node = useStore((s) => s.nodes.find((n) => n.key === s.selection))
  const frame = useStore((s) => (node ? s.frameFor(node) : undefined))
  if (!node || !frame || node.missing) return null
  const { resizeNode, spawn, toast } = useStore.getState()
  const setNodeTheme = (t: string) =>
    useStore.setState((s) => ({ nodes: s.nodes.map((n) => (n.key === node.key ? { ...n, theme: t } : n)) }))
  return (
    <div
      className="sh-ctx"
      style={{
        // centered over the frame; translateX keeps it centered whatever the bar's width
        left: `calc(var(--sh-tx, 0px) + var(--sh-s, 1) * ${node.x + node.w / 2}px)`,
        top: `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${node.y}px - 52px)`,
        transform: 'translateX(-50%)',
      }}
    >
      {Object.entries(CONFIG.viewports).map(([name, vp]) => (
        <Tip key={name} label={`${vp.width} × ${vp.height}`}>
          <button className={node.w === vp.width ? 'on' : ''}
            onClick={() => resizeNode(node.key, vp.width, vp.height)}>
            {deviceIcon(name, 15)}<span>{cap(name)}</span>
          </button>
        </Tip>
      ))}
      <i className="sep" />
      {CONFIG.themes.map((t) => (
        <Tip key={t} label={`${cap(t)} theme`}>
          <button className={`icon${node.theme === t ? ' on' : ''}`} onClick={() => setNodeTheme(t)}>
            {t === 'dark' ? <MoonIcon size={15} /> : t === 'light' ? <SunIcon size={15} /> : t}
          </button>
        </Tip>
      ))}
      <i className="sep" />
      <Tip label="Copy file path">
        <button className="icon"
          onClick={() => { navigator.clipboard.writeText(frame.file); toast('file path copied') }}><SignpostIcon size={15} /></button>
      </Tip>
      <Tip label="Duplicate frame">
        <button className="icon" onClick={() => spawn(frame.id)}><PlusIcon size={15} /></button>
      </Tip>
    </div>
  )
}

/** Devices view: one click sizes every frame to a device width, tidies, and fits. */
function DeviceMenu() {
  const deviceView = useStore((s) => s.deviceView)
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

  const pick = (name: string | null) => { useStore.getState().setDeviceView(name); setOpen(false); setTimeout(() => canvasCtl.fitAll(), 30) }
  const entries = Object.entries(CONFIG.viewports)
  const app = document.querySelector('.sh-app')
  return (
    <div className="sh-theme" ref={boxRef}>
      <button className="sh-pill-btn" onClick={toggle}
        title={deviceView ? `device view: ${deviceView} (0 resets)` : 'device view (keys 1-' + entries.length + ')'}>
        {deviceIcon(deviceView, 16)}
        <CaretIcon size={11} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && app && createPortal(
        <div className="sh-menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
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
        </div>,
        app,
      )}
    </div>
  )
}

const ZOOMS = [2, 1.5, 1, 0.5, 0.25, 0.1]

/** Zoom preset dropdown on the percentage readout. */
function ZoomMenu() {
  const scale = useStore((s) => s.scale)
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

  const go = (fn: () => void) => { fn(); setOpen(false) }
  const app = document.querySelector('.sh-app')
  return (
    <div className="sh-theme" ref={boxRef}>
      <button className="sh-pill-btn pct" onClick={toggle} title="zoom presets">{Math.round(scale * 100)}%</button>
      {open && app && createPortal(
        <div className="sh-menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          {ZOOMS.map((z) => (
            <button key={z} onClick={() => go(() => canvasCtl.zoomTo(z))}>
              <span>{z * 100}%</span>
              {z === 1 && <kbd>⇧0</kbd>}
              {Math.abs(scale - z) < 0.03 && <CheckIcon size={13} className="chk" />}
            </button>
          ))}
          <i className="div" />
          <button onClick={() => go(canvasCtl.fitAll)}><span>Fit all</span><kbd>⇧1</kbd></button>
          <button onClick={() => go(() => { const k = useStore.getState().selection; if (k) canvasCtl.fitNode(k) })}>
            <span>Fit selection</span><kbd>⇧2</kbd>
          </button>
        </div>,
        app,
      )}
    </div>
  )
}

/** Global theme dropdown: sets every frame at once; the trigger reflects the board when uniform.
 *  The menu is PORTALED out of the pill: an element with backdrop-filter is a backdrop root,
 *  so a nested backdrop-filter samples the pill's surface instead of the page - flat grey. */
function ThemeMenu() {
  const nodes = useStore((s) => s.nodes)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const uniform = nodes.length && nodes.every((n) => n.theme === nodes[0].theme) ? nodes[0].theme : null

  const toggle = () => {
    if (!open && boxRef.current) {
      const r = boxRef.current.getBoundingClientRect()
      setPos({ left: r.left, top: r.bottom + 10 })   // left-aligned under the trigger
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

  const app = document.querySelector('.sh-app')
  return (
    <div className="sh-theme" ref={boxRef}>
      <button className="sh-pill-btn" onClick={toggle} title="theme for all frames (d)">
        {uniform === 'dark' ? <MoonIcon size={16} /> : <SunIcon size={16} />}
        <CaretIcon size={11} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && app && createPortal(
        <div className="sh-menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          {CONFIG.themes.map((t) => (
            <button key={t} onClick={() => { useStore.getState().setTheme(t); setOpen(false) }}>
              {t === 'dark' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
              <span>{t}</span>
              {uniform === t && <CheckIcon size={13} className="chk" />}
            </button>
          ))}
        </div>,
        app,
      )}
    </div>
  )
}

export function App() {
  const { manifest, nodes, panelOpen, toasts } = useStore()
  const { boot, applyManifest, togglePanel, select, setInteract, runTidy, toast, spawn } = useStore.getState()

  useEffect(() => { boot() }, [])

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
      if (e.key === 't') runTidy()
      if (e.key === 'd' && CONFIG.themes.length > 1) {
        // cycle themes from the board's current (uniform or first)
        const cur = s.nodes.length && s.nodes.every((n) => n.theme === s.nodes[0].theme) ? s.nodes[0].theme : CONFIG.themes[0]
        const next = CONFIG.themes[(CONFIG.themes.indexOf(cur) + 1) % CONFIG.themes.length]
        s.setTheme(next)
      }
      if (e.shiftKey && e.code === 'Digit0') canvasCtl.zoom100()
      if (e.shiftKey && e.code === 'Digit1') canvasCtl.fitAll()
      if (e.shiftKey && e.code === 'Digit2' && s.selection) canvasCtl.fitNode(s.selection)
      // plain digits: device views (0 = default, 1..n = configured viewports in order)
      if (!e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        const idx = Number(e.code.slice(5))
        const names = Object.keys(CONFIG.viewports)
        if (idx === 0 || names[idx - 1]) {
          s.setDeviceView(idx === 0 ? null : names[idx - 1])
          setTimeout(() => canvasCtl.fitAll(), 30)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const scenes = manifest?.scenes ?? []
  const frames = manifest?.frames ?? []
  // the shell follows the board: majority-dark frames flip the whole chrome + canvas dark
  const dark = nodes.length > 0 && nodes.filter((n) => n.theme === 'dark').length > nodes.length / 2

  return (
    <div className={`sh-app${dark ? ' dark' : ''}`}>
      <Canvas />
      <SelectionBar />

      {/* floating pill panel (no top bar - spec); panel and fab are both always
          mounted so collapse/expand can crossfade-morph between them */}
      <aside className={`sh-panel${panelOpen ? '' : ' closed'}`} aria-hidden={!panelOpen}>
          <div className="sh-panel-top">
            <BoundingBoxDuoIcon size={21} className="mark" />
            <span className="name">Marver</span>
            <button className="sh-ibtn" onClick={togglePanel} title="collapse panel (⌘\\)" tabIndex={panelOpen ? 0 : -1}><PanelCloseIcon size={17} /></button>
          </div>
          <div className="sh-panel-scroll">
            <div className="hd">Scenes</div>
            {scenes.map((sc) => (
              <SceneGroup key={sc.name} name={sc.name} count={sc.frames}>
                {frames.filter((f) => f.scene === sc.name).map((f) => (
                  <div key={f.id} className="sub" onClick={() => {
                    const n = useStore.getState().nodes.find((x) => x.frame === f.id)
                    if (n) { select(n.key); canvasCtl.fitNode(n.key) }
                  }}>{cap(f.id.split('/').slice(1).join('/') || f.id)}</div>
                ))}
              </SceneGroup>
            ))}
            {frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
          </div>
      </aside>
      <button className={`sh-fab${panelOpen ? ' hidden' : ''}`} onClick={togglePanel} title="open panel (⌘\\)"
        aria-hidden={panelOpen} tabIndex={panelOpen ? -1 : 0}><PanelOpenIcon size={18} /></button>

      {/* floating pill nav, top right */}
      <nav className="sh-pill">
        <DeviceMenu />
        <ThemeMenu />
        <i className="sep" />
        <ZoomMenu />
        <button className="sh-pill-btn" onClick={runTidy} title="tidy layout (t)"><GridIcon size={16} /></button>
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
