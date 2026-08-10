import { Component, useEffect, type ReactNode } from 'react'
import { useStore, CONFIG } from './store.ts'
import { Canvas, panTo } from './canvas/Canvas.tsx'

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

export function App() {
  const { manifest, nodes, panelOpen, scale, toasts } = useStore()
  const { boot, applyManifest, togglePanel, select, setInteract, setStatus, setTheme, runTidy, toast, spawn } = useStore.getState()

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
        setTimeout(() => panTo.current(node.key), 50)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // keyboard: t tidy · Escape exits interact/selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const s = useStore.getState()
      if (e.key === 'Escape') s.interact ? setInteract(null) : select(null)
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) runTidy()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const scenes = manifest?.scenes ?? []
  const frames = manifest?.frames ?? []

  return (
    <div className="sh-app">
      <Canvas />

      {/* floating side panel (no top bar - spec) */}
      <aside className={`sh-panel${panelOpen ? '' : ' closed'}`}>
        {panelOpen ? (
          <>
            <div className="sh-logo"><i /> showhome</div>
            <div className="hd">Scenes</div>
            {scenes.map((sc) => (
              <div key={sc.name}>
                <div className="it"><span>{sc.name || '(root)'}</span><small>{sc.frames}</small></div>
                {frames.filter((f) => f.scene === sc.name).map((f) => (
                  <div key={f.id} className="sub" onClick={() => {
                    const n = useStore.getState().nodes.find((x) => x.frame === f.id)
                    if (n) { select(n.key); panTo.current(n.key) }
                  }}>{f.id.split('/').slice(1).join('/') || f.id}</div>
                ))}
              </div>
            ))}
            {frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
            <div className="foot" onClick={togglePanel}>⟨ collapse</div>
          </>
        ) : (
          <div className="sh-rail" onClick={togglePanel}>⟩</div>
        )}
      </aside>

      {/* floating pill nav, top right */}
      <nav className="sh-pill">
        {CONFIG.themes.map((t) => <button key={t} onClick={() => setTheme(t)}>{t === 'dark' ? '◐' : '◑'} {t}</button>)}
        <span className="pct">{Math.round(scale * 100)}%</span>
        <button onClick={runTidy} title="tidy (t)">t tidy</button>
        <button className="off" title="play mode ships in M2">▶</button>
      </nav>

      {CONFIG.noTheme && <div className="sh-banner">no theme configured - frames render unstyled (design/config.ts → theme)</div>}

      <div className="sh-toasts">
        {toasts.map((t) => <div key={t.id} className="sh-toast">✓ {t.text}</div>)}
      </div>
    </div>
  )
}
