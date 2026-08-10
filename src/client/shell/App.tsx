import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, CONFIG } from './store.ts'
import { Canvas, canvasCtl } from './canvas/Canvas.tsx'
import { BoundingBoxDuoIcon, CaretIcon, CheckIcon, GridIcon, MoonIcon, PanelCloseIcon, PanelOpenIcon, PlayIcon, SunIcon } from './icons.tsx'

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
      <button className="sh-pill-btn" onClick={toggle} title="theme for all frames">
        {uniform === 'dark' ? <MoonIcon size={14} /> : <SunIcon size={14} />}
        <CaretIcon size={10} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && app && createPortal(
        <div className="sh-menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          {CONFIG.themes.map((t) => (
            <button key={t} onClick={() => { useStore.getState().setTheme(t); setOpen(false) }}>
              {t === 'dark' ? <MoonIcon size={14} /> : <SunIcon size={14} />}
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
  const { manifest, nodes, panelOpen, scale, toasts } = useStore()
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

  // keyboard: t tidy · Escape exit · shift+0 100% · shift+1 fit all · shift+2 fit selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const s = useStore.getState()
      if (e.key === 'Escape') s.interact ? setInteract(null) : select(null)
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) runTidy()
      if (e.shiftKey && e.code === 'Digit0') canvasCtl.zoom100()
      if (e.shiftKey && e.code === 'Digit1') canvasCtl.fitAll()
      if (e.shiftKey && e.code === 'Digit2' && s.selection) canvasCtl.fitNode(s.selection)
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

      {/* floating pill panel (no top bar - spec); panel and fab are both always
          mounted so collapse/expand can crossfade-morph between them */}
      <aside className={`sh-panel${panelOpen ? '' : ' closed'}`} aria-hidden={!panelOpen}>
          <div className="sh-panel-top">
            <BoundingBoxDuoIcon size={19} className="mark" />
            <span className="name">Marver</span>
            <button className="sh-ibtn" onClick={togglePanel} title="collapse panel" tabIndex={panelOpen ? 0 : -1}><PanelCloseIcon size={15} /></button>
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
      <button className={`sh-fab${panelOpen ? ' hidden' : ''}`} onClick={togglePanel} title="open panel"
        aria-hidden={panelOpen} tabIndex={panelOpen ? -1 : 0}><PanelOpenIcon size={16} /></button>

      {/* floating pill nav, top right */}
      <nav className="sh-pill">
        <ThemeMenu />
        <i className="sep" />
        <button className="sh-pill-btn pct" onClick={() => canvasCtl.zoom100()} title="zoom to 100% (shift+0)">
          {Math.round(scale * 100)}%
        </button>
        <button className="sh-pill-btn" onClick={runTidy} title="tidy layout (t)"><GridIcon size={14} /></button>
        <i className="sep" />
        <button className="sh-pill-btn off" title="play mode ships in M2"><PlayIcon size={13} /></button>
      </nav>

      {CONFIG.noTheme && <div className="sh-banner">no theme configured - frames render unstyled (design/config.ts → theme)</div>}

      <div className="sh-toasts">
        {toasts.map((t) => <div key={t.id} className="sh-toast"><CheckIcon size={12} /> {t.text}</div>)}
      </div>
    </div>
  )
}
