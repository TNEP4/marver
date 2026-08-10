import { memo, useEffect, useRef } from 'react'
import { frameUrl, useStore, CONFIG, type Node } from '../store.ts'

const HEADER = 28
const SNAP = 12

/**
 * One frame on the canvas. Iframe laws (spec §7): the iframe element is created once per node key
 * and never remounted - theme changes go through sh:set-theme, size changes are CSS only.
 */
export const FrameNode = memo(function FrameNode({ node }: { node: Node }) {
  const frame = useStore((s) => s.frameFor(node))
  const selected = useStore((s) => s.selection === node.key)
  const interact = useStore((s) => s.interact === node.key)
  const scale = useStore((s) => s.scale)
  const { select, setInteract, moveNode, resizeNode, setStatus } = useStore.getState()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const themeRef = useRef(node.theme)

  // theme switch without remount
  useEffect(() => {
    if (themeRef.current !== node.theme) {
      themeRef.current = node.theme
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:set-theme', theme: node.theme }, '*')
    }
  }, [node.theme])

  // ready timeout (spec §7): 10s without sh:ready -> error card with reload
  useEffect(() => {
    if (node.status !== 'loading') return
    const t = setTimeout(() => setStatus(node.key, 'error', 'frame never reported ready (10s)'), 10_000)
    return () => clearTimeout(t)
  }, [node.status, node.key, setStatus])

  const drag = (e: React.PointerEvent, mode: 'move' | 'e' | 's' | 'se') => {
    e.stopPropagation()
    if (e.button !== 0) return
    select(node.key)
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y, nw: node.w, nh: node.h }
    const world = document.getElementById('sh-world')!
    world.classList.add('sh-gesturing')

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / scale
      const dy = (ev.clientY - start.y) / scale
      if (mode === 'move') moveNode(node.key, start.nx + dx, start.ny + dy)
      else {
        let w = mode !== 's' ? start.nw + dx : start.nw
        const h = mode !== 'e' ? start.nh + dy : start.nh
        for (const vp of Object.values(CONFIG.viewports)) if (Math.abs(w - vp.width) < SNAP) w = vp.width
        resizeNode(node.key, w, h)
      }
    }
    const done = () => {
      el.releasePointerCapture?.(e.pointerId)
      world.classList.remove('sh-gesturing')
      el.removeEventListener('pointermove', onMove as any)
      el.removeEventListener('pointerup', done as any)
      el.removeEventListener('pointercancel', done as any)
      el.removeEventListener('lostpointercapture', done as any)
    }
    el.addEventListener('pointermove', onMove as any)
    el.addEventListener('pointerup', done as any)
    el.addEventListener('pointercancel', done as any)
    el.addEventListener('lostpointercapture', done as any)
  }

  const gone = !frame || node.missing
  // Spec §7: a deleted frame's node stays, with a card, until the user removes it. Explicit beats magic.
  if (gone) {
    return (
      <div className={`sh-node${selected ? ' sel' : ''}`}
        style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h + HEADER }}
        data-node={node.key}>
        <div className="sh-node-head" onPointerDown={(e) => drag(e, 'move')}>
          <span className="id">{node.frame}</span><span className="dim">deleted</span>
        </div>
        <div className="sh-node-body" style={{ height: node.h }}>
          <div className="sh-card warn">
            <b>file deleted</b>
            <span className="dim">{node.frame}</span>
            <span className="row"><button onClick={() => useStore.setState((s) => ({ nodes: s.nodes.filter((n) => n.key !== node.key) }))}>remove from board</button></span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`sh-node${selected ? ' sel' : ''}${interact ? ' interact' : ''}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h + HEADER }}
      data-node={node.key}
    >
      <div className="sh-node-head" onPointerDown={(e) => drag(e, 'move')} title={frame.file}>
        <span className="id">{frame.title ?? frame.id}</span>
        <span className="dim">{Math.round(node.w)} · {node.theme}</span>
      </div>

      <div className="sh-node-body" style={{ height: node.h }}>
        {node.status === 'error' ? (
          <div className="sh-card err">
            <b>frame failed</b>
            <span className="msg">{node.error}</span>
            <span className="dim">{frame.file}</span>
            <span className="row">
              <button onClick={() => { setStatus(node.key, 'loading'); iframeRef.current && (iframeRef.current.src = frameUrl(frame, node.theme)) }}>reload</button>
              <button onClick={() => navigator.clipboard.writeText(`${frame.file}: ${node.error}`)}>copy for agent</button>
            </span>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src={frameUrl(frame, node.theme)}
          title={frame.id}
          style={{ width: node.w, height: node.h, display: node.missing || node.status === 'error' ? 'none' : 'block' }}
        />
        {!interact && (
          <div
            className="sh-overlay"
            onPointerDown={(e) => drag(e, 'move')}
            onDoubleClick={(e) => { e.stopPropagation(); setInteract(node.key) }}
          />
        )}
      </div>

      {selected && (
        <>
          <div className="sh-handle e" onPointerDown={(e) => drag(e, 'e')} />
          <div className="sh-handle s" onPointerDown={(e) => drag(e, 's')} />
          <div className="sh-handle se" onPointerDown={(e) => drag(e, 'se')} />
          <div className="sh-ctx" onPointerDown={(e) => e.stopPropagation()}>
            {Object.entries(CONFIG.viewports).map(([name, vp]) => (
              <button key={name} className={node.w === vp.width ? 'on' : ''} onClick={() => resizeNode(node.key, vp.width, vp.height)}>{vp.width}</button>
            ))}
            {CONFIG.themes.map((t) => (
              <button key={t} className={node.theme === t ? 'on' : ''} onClick={() => useStore.setState((s) => ({ nodes: s.nodes.map((n) => n.key === node.key ? { ...n, theme: t } : n) }))}>{t}</button>
            ))}
            <button onClick={() => navigator.clipboard.writeText(frame.file)} title="copy file path">⧉</button>
          </div>
        </>
      )}
    </div>
  )
})
