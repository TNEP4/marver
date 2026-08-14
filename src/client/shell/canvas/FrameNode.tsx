import { memo, useCallback, useEffect, useRef } from 'react'
import { cap, frameUrl, useStore, CONFIG, type Node } from '../store.ts'
import { CopyIcon, IntentGlyph, ReloadIcon, XIcon } from '../icons.tsx'
import { CommentLayer } from '../Comments.tsx'
import { useComments } from '../comments-store.ts'
import { registerFrame, unregisterFrame } from './frame-registry.ts'

export const HEADER = 28
const SNAP = 12

/**
 * One frame on the canvas. Iframe laws (spec §7): the iframe element is created once per node key
 * and never remounted - theme changes go through sh:set-theme, size changes are CSS only.
 *
 * Every interactive element carries `sh-no-pan` (rzpp's panning.excluded checks the event
 * TARGET's classList, nothing else), and drags additionally raise the store gesture flag,
 * which hard-disables canvas panning for the duration. Both are needed: the class stops the
 * pan before it starts, the flag covers targets we missed.
 */
export const FrameNode = memo(function FrameNode({ node }: { node: Node }) {
  const frame = useStore((s) => s.frameFor(node))
  const selected = useStore((s) => s.selection.includes(node.key))
  const interact = useStore((s) => s.interact === node.key)
  // B0.1: no reactive scale subscription - it re-rendered every FrameNode on every
  // pan/zoom tick. gestureScale below measures the world rect (the canonical source,
  // Law G-5); the stored scale is only a never-hit fallback, read lazily at drag time.
  const { select, setInteract, moveNode, moveSelectedBy, resizeNode, setStatus, setGesture, toast } = useStore.getState()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const themeRef = useRef(node.theme)
  // src is frozen at mount: theme changes ride sh:set-theme (never navigation), so
  // frame state (forms, scroll, dialogs) survives a theme flip. Real file changes below.
  const initialSrc = useRef<string | null>(null)
  if (frame && initialSrc.current === null) initialSrc.current = frameUrl(frame, node.theme)
  const fileRef = useRef(frame ? `${frame.kind}:${frame.file}` : null)

  // theme switch without remount
  useEffect(() => {
    if (themeRef.current !== node.theme) {
      themeRef.current = node.theme
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:set-theme', theme: node.theme }, '*')
    }
  }, [node.theme])

  // B0.3: register this frame's WindowProxy so the shell routes its messages in O(1)
  // (source window -> node), instead of rescanning every iframe + walking the DOM per
  // message. Registration runs SYNCHRONOUSLY through the ref callback (P1): a fast static
  // HTML frame or an immediate boot failure can post sh:ready/sh:error before a passive
  // effect would run, and the registry is the security gate that would otherwise drop it
  // as an unknown source (misleading 10s timeout). The WindowProxy is stable across
  // navigations; onLoad re-asserts it (idempotent) after each navigation.
  const regWin = useRef<WindowProxy | null>(null)
  const registerWin = () => {
    const iframe = iframeRef.current
    const win = iframe?.contentWindow
    if (!iframe || !win || regWin.current === win) return
    regWin.current = win
    registerFrame(win, { key: node.key, iframe })
  }
  const bindIframe = useCallback((el: HTMLIFrameElement | null) => {
    if (regWin.current && (!el || el.contentWindow !== regWin.current)) { unregisterFrame(regWin.current); regWin.current = null }
    iframeRef.current = el
    registerWin()
  }, [node.key])

  // laser mode (SPEC-M3 §7) rides the same rail; re-sent when a frame becomes ready
  // so late loaders join an already-lasered board
  const laser = useStore((s) => s.laser)
  const commentMode = useComments((s) => s.commentMode)
  // a node hosting the OPEN thread card (or a draft composer) rises above its
  // neighbors - each node is a stacking context, so an overflowing card would
  // otherwise paint under the next frame
  const hostsCard = useComments((s) =>
    (!!s.active && s.threads.some((t) => t.id === s.active && t.nodeKey === node.key)) || s.draft?.nodeKey === node.key)
  useEffect(() => {
    if (node.status === 'ready' || !laser)
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:laser', on: laser }, location.origin)
  }, [laser, node.status])
  // comment mode = pick mode in the frame (late loaders join like laser does)
  useEffect(() => {
    if (node.status === 'ready' || !commentMode)
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:pick', on: commentMode }, location.origin)
  }, [commentMode, node.status])
  // B0.2: the interact target owns its own wheel (app scrolls); passive frames forward
  // wheel to the canvas. Replayed on ready like laser/pick so a reload restores truth.
  useEffect(() => {
    if (node.status === 'ready' || !interact)
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:interactive', on: interact }, location.origin)
  }, [interact, node.status])

  // a frame whose FILE actually changed (e.g. tsx -> html swap, same id) must renavigate
  useEffect(() => {
    if (!frame) return
    const sig = `${frame.kind}:${frame.file}`
    if (fileRef.current !== null && fileRef.current !== sig && iframeRef.current) {
      setStatus(node.key, 'loading')
      iframeRef.current.src = frameUrl(frame, node.theme)
    }
    fileRef.current = sig
  }, [frame?.kind, frame?.file])

  // shell-requested renavigation (store bumps node.nav): reload on a FRESH rev-stamped
  // URL - the errored document's own URL may be poisoned by cache (friction log #20)
  const navRef = useRef(node.nav ?? 0)
  useEffect(() => {
    if ((node.nav ?? 0) === navRef.current) return
    navRef.current = node.nav ?? 0
    if (frame && iframeRef.current) iframeRef.current.src = frameUrl(frame, node.theme)
  }, [node.nav])

  // ready timeout (spec §7): 10s without sh:ready -> error card with reload
  useEffect(() => {
    if (node.status !== 'loading') return
    const t = setTimeout(() => setStatus(node.key, 'error', 'frame never reported ready (10s)'), 10_000)
    return () => clearTimeout(t)
  }, [node.status, node.key, setStatus])

  const drag = (e: React.PointerEvent, mode: 'move' | 'e' | 's' | 'se') => {
    e.stopPropagation()
    if (e.button !== 0) return
    // shift-click toggles multi-selection instead of dragging (Figma convention)
    if (e.shiftKey && mode === 'move') { select(node.key, true); return }
    if (!(selected && useStore.getState().selection.length > 1)) select(node.key)
    const el = e.currentTarget as HTMLElement
    const world = document.getElementById('sh-world')!
    // Law G-5: measured scale, never stored zoom state. #sh-world is 1px wide by design,
    // so its rendered rect width IS the scale (survives browser page-zoom too).
    const gestureScale = world.getBoundingClientRect().width || useStore.getState().scale || 1
    const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y, nw: node.w, nh: node.h }
    // group drag: moving any member moves the whole selection by the same delta
    const st = useStore.getState()
    const groupStarts: Record<string, { x: number; y: number }> = {}
    if (mode === 'move' && st.selection.includes(node.key)) {
      for (const k of st.selection) {
        const n = st.nodes.find((x) => x.key === k)
        if (n) groupStarts[k] = { x: n.x, y: n.y }
      }
    }
    world.classList.add('sh-gesturing')
    setGesture(true)

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / gestureScale
      const dy = (ev.clientY - start.y) / gestureScale
      if (mode === 'move') {
        if (Object.keys(groupStarts).length > 1) moveSelectedBy(dx, dy, groupStarts)
        else moveNode(node.key, start.nx + dx, start.ny + dy)
      }
      else {
        let w = mode !== 's' ? start.nw + dx : start.nw
        const h = mode !== 'e' ? start.nh + dy : start.nh
        for (const vp of Object.values(CONFIG.viewports)) if (Math.abs(w - vp.width) < SNAP) w = vp.width
        resizeNode(node.key, w, h)
      }
    }
    // One idempotent teardown for every exit path - stuck gestures are the acceptance test.
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      try { el.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      world.classList.remove('sh-gesturing')
      setGesture(false)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', done)
      el.removeEventListener('pointercancel', done)
      el.removeEventListener('lostpointercapture', done)
      window.removeEventListener('blur', done)
    }
    try { el.setPointerCapture(e.pointerId) } catch { setGesture(false); world.classList.remove('sh-gesturing'); return }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', done)
    el.addEventListener('pointercancel', done)
    el.addEventListener('lostpointercapture', done)
    window.addEventListener('blur', done)
  }

  const gone = !frame || node.missing
  // Spec §7: a deleted frame's node stays, with a card, until the user removes it. Explicit beats magic.
  if (gone) {
    return (
      <div className={`sh-node${selected ? ' sel' : ''}`}
        style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h + HEADER }}
        data-node={node.key}>
        <div className="sh-node-head sh-no-pan" onPointerDown={(e) => drag(e, 'move')}>
          <span className="id sh-no-pan">{node.frame}</span><span className="dim sh-no-pan">deleted</span>
        </div>
        <div className="sh-node-body" style={{ height: node.h }}>
          <div className="sh-card warn sh-no-pan">
            <b>file deleted</b>
            <span className="dim">{node.frame}</span>
            <span className="row">
              <button className="sh-no-pan" onClick={() => useStore.getState().removeNode(node.key)}>
                <XIcon size={12} /> remove from board
              </button>
            </span>
          </div>
        </div>
      </div>
    )
  }

  // variant badge (SPEC-023 §4): letter + name floating LEFT of the frame, outside the
  // artwork, world-anchored (scales with zoom) with a screen-space minimum via --sh-inv
  const variantName = frame.title
    ?? cap((frame.id.split('/').pop() ?? '').replace(/^[a-z]-/, '').replace(/-/g, ' '))

  return (
    <div
      className={`sh-node${selected ? ' sel' : ''}${interact ? ' interact' : ''}`}
      data-theme={node.theme}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h + HEADER, zIndex: hostsCard ? 30 : undefined }}
      data-node={node.key}
    >
      {frame.variantGroup && (
        <div className="sh-vbadge sh-no-pan" title={`${frame.variantGroup} · variant ${frame.variant?.toUpperCase()} - click to select`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { select(node.key, e.shiftKey) }}>
          <b>{frame.variant?.toUpperCase()}</b>
          <span>{variantName}</span>
        </div>
      )}
      <div className="sh-node-head sh-no-pan" onPointerDown={(e) => drag(e, 'move')} title={frame.file}>
        {/* content frames carry their intent glyph in the chrome (SPEC-026) */}
        {frame.intent && <IntentGlyph intent={frame.intent} size={12} className="iicon sh-no-pan" aria-label={frame.intent} />}
        <span className="id sh-no-pan">{frame.title ?? frame.id}</span>
        <span className="dim sh-no-pan">{Math.round(node.w)} · {node.theme}</span>
      </div>

      <div className="sh-node-body" style={{ height: node.h }}>
        {node.status === 'error' ? (
          <div className="sh-card err sh-no-pan">
            <b>frame failed</b>
            <span className="msg">{node.error}</span>
            <span className="dim">{frame.file}</span>
            <span className="row">
              <button className="sh-no-pan" onClick={() => { setStatus(node.key, 'loading'); iframeRef.current && (iframeRef.current.src = frameUrl(frame, node.theme)) }}>
                <ReloadIcon size={12} /> reload
              </button>
              <button className="sh-no-pan" onClick={() => { navigator.clipboard.writeText(`${frame.file}: ${node.error}`); toast('error copied for agent') }}>
                <CopyIcon size={12} /> copy for agent
              </button>
            </span>
          </div>
        ) : null}
        <iframe
          ref={bindIframe}
          src={initialSrc.current ?? frameUrl(frame, node.theme)}
          title={frame.id}
          onLoad={registerWin}
          style={{ width: node.w, height: node.h, display: node.missing || node.status === 'error' ? 'none' : 'block' }}
        />
        {/* the overlay eats mouse events for drag-by-body; laser and comment mode both
            need the mouse INSIDE the frame for hover highlights, so it steps aside
            (drag still works via the header) */}
        {!interact && !commentMode && !laser && (
          <div
            className="sh-overlay sh-no-pan"
            onPointerDown={(e) => drag(e, 'move')}
            onDoubleClick={(e) => { e.stopPropagation(); setInteract(node.key) }}
          />
        )}
      </div>

      {/* comments live OUTSIDE the clipped body: a card or pin near the frame edge
          hangs over it (the vbadge precedent) instead of being cut off */}
      <div className="cm-layer" style={{ top: HEADER, height: node.h }}>
        <CommentLayer node={node} frameId={frame.id} iframe={iframeRef} />
      </div>

      {selected && (
        <>
          <div className="sh-handle e sh-no-pan" onPointerDown={(e) => drag(e, 'e')} />
          <div className="sh-handle s sh-no-pan" onPointerDown={(e) => drag(e, 's')} />
          <div className="sh-handle se sh-no-pan" onPointerDown={(e) => drag(e, 'se')} />
        </>
      )}
    </div>
  )
})
