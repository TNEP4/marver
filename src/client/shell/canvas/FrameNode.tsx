import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cap, frameUrl, useStore, CONFIG, type Node } from '../store.ts'
import { admit, release } from './admission.ts'
import { CopyIcon, IntentGlyph, ParallelogramFillIcon, ReloadIcon, SlideFrameIcon, XIcon } from '../icons.tsx'
import { CommentLayer } from '../Comments.tsx'
import { useComments } from '../comments-store.ts'
import { threadHostKey } from '../keys.ts'
import { registerFrame, unregisterFrame } from './frame-registry.ts'
import { primeCameraFor } from './camera-broadcast.ts'
import { sleep, wake } from './sleep.ts'
import { canAutoReload, shouldArmReadyWatch } from './ready-watch.ts'
import { Stickies, type NoteSpec } from './Sticky.tsx'
import { noteId, sceneNoteHost } from '../notes.ts'
import { slideSize, stageFit } from '../../const.ts'

export const HEADER = 28
const SNAP = 12

/** The iframe's box in its node: a frame fills the node; a slide renders at its stage and is
 *  scaled uniformly into the node and centred - resizing a slide node never reflows it. The
 *  identity case carries no transform (no layer, no containing block). */
function iframeBox(stage: { width: number; height: number } | null, node: { w: number; h: number }) {
  if (!stage) return { width: node.w, height: node.h }
  const { k, ox, oy } = stageFit(stage, node)
  const identity = Math.abs(k - 1) < 1e-6 && Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5
  return { width: stage.width, height: stage.height, ...(identity ? {} : { transform: `translate(${ox}px, ${oy}px) scale(${k})`, transformOrigin: '0 0' }) }
}

/** Live Jam working shimmer: a slim 2x6 strip of tiny marver marks on the frame's left
 *  flank, top-aligned - each mark twinkles on its own scattered beat, phased per frame by
 *  --mv-w0 (set on the node) so parallel frames never pulse in sync. */
const SHIM_DELAYS = Array.from({ length: 12 }, (_, i) => {
  const r = Math.floor(i / 2), c = i % 2
  return (((r * 7 + c * 13) % 9) / 9) * 0.95
})
function WorkShimmer({ belowBadge }: { belowBadge: boolean }) {
  // a variant badge owns the top of the left flank - the shimmer yields and sits below it
  return (
    <div className={`sh-work-ind${belowBadge ? ' below-vbadge' : ''}`} aria-hidden>
      {SHIM_DELAYS.map((d, i) => (
        <ParallelogramFillIcon key={i} size={5} style={{ animationDelay: `calc(var(--mv-w0, 0s) + ${d.toFixed(2)}s)` }} />
      ))}
    </div>
  )
}

/**
 * One frame on the canvas. Iframe laws: the iframe element is created once per node key
 * and never remounted - theme changes go through sh:set-theme, size changes are CSS only.
 *
 * At rest the frame SLEEPS in place (sleep.ts, spec 16): the same live document, its animations
 * paused and its backdrop-filters replaced by certified textures. Interact mode wakes it; laser,
 * comment pins and selection act on the sleeping document as it is. A frame the human has
 * interacted with is a state the compiler cannot reproduce from its URL: it stays awake until
 * it is reloaded. Any change of theme, size or source wakes first and sleeps again once settled.
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
  const working = useStore((s) => s.working.includes(node.frame))   // Live Jam: Marver is editing this frame
  // sticky notes (spec 18): the scene's note when this node is the scene's first on the board
  // (reading order), then the frame's own. Text is compared by value - a note edit re-renders
  // only its column; a pan never re-renders any node (no position subscription here).
  const sceneNote = useStore((s) => {
    const scene = frame?.scene
    const text = scene ? s.manifest?.scenes.find((sc) => sc.name === scene)?.note : undefined
    if (!text) return undefined
    return sceneNoteHost(s.nodes, (id) => s.manifest?.frames.find((f) => f.id === id)?.scene, scene!) === node.key ? text : undefined
  })
  const notes: NoteSpec[] = []
  if (frame && sceneNote) notes.push({ kind: 'scene', id: noteId('scene', frame.scene), text: sceneNote })
  if (frame?.note) notes.push({ kind: 'frame', id: noteId('frame', frame.id), text: frame.note })
  const workingSince = useStore((s) => s.workingSince[node.frame])
  // B0.1: no reactive scale subscription - it re-rendered every FrameNode on every
  // pan/zoom tick. gestureScale below measures the world rect (the canonical source,
  // Law G-5); the stored scale is only a never-hit fallback, read lazily at drag time.
  const { select, setInteract, moveNode, moveSelectedBy, resizeNode, setStatus, reloadFrame, setGesture, toast } = useStore.getState()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const themeRef = useRef(node.theme)
  // The JSX src is set ONCE, at ADMISSION, with the theme and revision of that moment, and never
  // changes again (React would write it back after any later navigation and load the frame twice):
  // theme changes ride sh:set-theme (never navigation), so frame state (forms, scroll, dialogs)
  // survives a theme flip; file changes and reloads navigate imperatively below, only once
  // admitted - a queued frame takes the fresh revision when its turn comes.
  const [src, setSrc] = useState<string>()
  const admitted = src !== undefined
  const admittedRef = useRef(false)
  const fileRef = useRef(frame ? `${frame.kind}:${frame.file}` : null)

  // admission (admission.ts): the iframe gets its src when a boot slot is free, nearest the centre
  // of the view first; the slot goes back when the frame is ready, errored, gone, or its watchdog acts
  const navigate = (url: string) => { if (admittedRef.current && iframeRef.current) iframeRef.current.src = url }
  useEffect(() => {
    if (!frame || node.missing) { admittedRef.current = false; setSrc(undefined); return }   // gone: the card replaces the iframe; a return is a new document, admitted anew
    if (admittedRef.current) return   // the document exists (the frame's id changed under it): no slot
    const rank = () => {   // visible first, then by distance to the centre of the canvas (the panel offsets the window's)
      const r = iframeRef.current?.getBoundingClientRect(), c = document.querySelector('.sh-canvas')?.getBoundingClientRect()
      if (!r || !c) return Infinity
      const visible = r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom
      return (visible ? 0 : 1e7) + Math.hypot(r.x + r.width / 2 - c.x - c.width / 2, r.y + r.height / 2 - c.y - c.height / 2)
    }
    const start = () => {
      const s = useStore.getState(), n = s.nodes.find((x) => x.key === node.key), f = n && s.frameFor(n)
      if (!n || !f) { release(node.key); return }
      if (n.status !== 'loading') setStatus(node.key, 'loading')   // a returning frame boots under the watchdog like any other
      admittedRef.current = true
      setSrc(frameUrl(f, n.theme))
    }
    admit({ key: node.key, rank, start })
    return () => release(node.key)
  }, [frame?.id, node.key, node.missing])
  useEffect(() => { if (node.status !== 'loading') release(node.key) }, [node.status, node.key])

  // theme switch without remount: the live iframe flips via message (no navigation); the frame
  // reports sh:theme-applied and only then sleeps again under the new theme (node.themeOn)
  useEffect(() => {
    if (themeRef.current !== node.theme) {
      themeRef.current = node.theme
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:set-theme', theme: node.theme }, '*')
    }
  }, [node.theme, node.key])

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

  // laser mode rides the same rail; re-sent when a frame becomes ready
  // so late loaders join an already-lasered board
  const laser = useStore((s) => s.laser)
  const commentMode = useComments((s) => s.commentMode)
  // a node hosting the OPEN thread card (or a draft composer) rises above its
  // neighbors - each node is a stacking context, so an overflowing card would
  // otherwise paint under the next frame
  const hostsCard = useComments((s) =>
    (!!s.active && s.threads.some((t) =>
      t.id === s.active && !t.resolved && threadHostKey(t, useStore.getState().nodes) === node.key)) || s.draft?.nodeKey === node.key)
  useEffect(() => {
    if (node.status === 'ready' || !laser)
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:laser', on: laser }, location.origin)
  }, [laser, node.status])
  // comment mode = pick mode in the frame (late loaders join like laser does); quiet when
  // laser comment (⇧L) is off - clicks still anchor, no lighting in the artwork
  const showAnchor = useComments((s) => s.showAnchor)
  useEffect(() => {
    if (node.status === 'ready' || !commentMode)
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:pick', on: commentMode, quiet: !showAnchor }, location.origin)
  }, [commentMode, showAnchor, node.status])
  // B0.2: the interact target owns its own wheel (app scrolls); passive frames forward
  // wheel to the canvas. Replayed on ready like laser/pick so a reload restores truth.
  useEffect(() => {
    if (node.status === 'ready' || !interact)
      iframeRef.current?.contentWindow?.postMessage({ type: 'sh:interactive', on: interact }, location.origin)
  }, [interact, node.status])
  // SLEEP lifecycle. Interact = awake and DIRTY (the app's state is now its own); a resize drag =
  // awake for the whole drag; any other change of the key (theme once applied, size, source revision,
  // navigation) wakes first - the old override describes another state - and sleeps again once the
  // new one has settled. Laser and comment mode need nothing: the sleeping document IS the live one.
  const dirty = useRef(false)
  const lastDoc = useRef<Document | null>(null)   // a new document (reload, self-reload) is pristine again
  const resizing = useRef(false)
  const [resizeTick, setResizeTick] = useState(0)
  useEffect(() => { dirty.current = false }, [node.nav])   // a fresh document is pristine again
  // a slide's document is its stage, whatever the node's size (the node only scales it): the
  // sleep key - the size the compiler renders to certify textures - is the document's size
  const stage = frame ? slideSize(frame, CONFIG.viewports) : null
  const w = Math.round(stage?.width ?? node.w), h = Math.round(stage?.height ?? node.h)
  // a layout effect: the wake lands BEFORE the first paint of the new state (a stretched texture
  // must never be painted at a new size)
  useLayoutEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !frame || node.missing) { wake(node.key, null); return }   // nothing to keep (a deleted frame's card must not retain its old document)
    const doc = iframe.contentDocument
    if (doc && doc !== lastDoc.current) { lastDoc.current = doc; dirty.current = false }
    if (interact) dirty.current = true
    wake(node.key, iframe)
    if (interact || dirty.current || resizing.current || node.status !== 'ready') return
    if (node.themeOn !== undefined && node.themeOn !== node.theme) return   // the frame has not painted the new theme yet
    const t = setTimeout(() => { void sleep(node.key, iframe, { frame: frame.id, theme: node.theme, w, h }) }, 250)
    return () => clearTimeout(t)
  }, [interact, node.status, node.theme, node.themeOn, node.rev, node.nav, w, h, node.missing, frame?.id, node.key, resizeTick])
  useEffect(() => () => wake(node.key, iframeRef.current), [node.key])

  // image-LOD: once the frame is ready its content listener is live, so send the settled zoom - a static
  // board that never gets a gesture then still sharpens its images from the cheap low-res first paint.
  useEffect(() => {
    if (node.status === 'ready') primeCameraFor(iframeRef.current?.contentWindow)
  }, [node.status])

  // a frame whose FILE actually changed (e.g. tsx -> html swap, same id) must renavigate
  useEffect(() => {
    if (!frame) return
    const sig = `${frame.kind}:${frame.file}`
    if (fileRef.current !== null && fileRef.current !== sig && iframeRef.current) {
      setStatus(node.key, 'loading')
      navigate(frameUrl(frame, node.theme))
    }
    fileRef.current = sig
  }, [frame?.kind, frame?.file])

  // shell-requested renavigation (store bumps node.nav): reload on a FRESH rev-stamped
  // URL - the errored document's own URL may be poisoned by cache (friction log #20)
  const navRef = useRef(node.nav ?? 0)
  useEffect(() => {
    if ((node.nav ?? 0) === navRef.current) return
    navRef.current = node.nav ?? 0
    if (frame) navigate(frameUrl(frame, node.theme))
  }, [node.nav])

  // Reload the frame, assigning the fresh URL SYNCHRONOUSLY so the live iframe's src is current the
  // instant a stale sh:ready (queued by the document we just superseded) could be processed - the
  // App generation guard then drops it against the new src. reloadFrame bumps nav+manifestRev; we
  // pre-apply the src here and advance navRef so the passive nav effect does not navigate a 2nd time.
  const reload = (automatic: boolean) => {
    const before = useStore.getState().nodes.find((x) => x.key === node.key)
    if (!before || (automatic && !canAutoReload(before))) return
    reloadFrame(node.key, automatic)
    const after = useStore.getState().nodes.find((x) => x.key === node.key)
    const f = useStore.getState().frameFor(node)
    if (after && f) {
      navigate(frameUrl(f, node.theme))
      navRef.current = after.nav ?? 0
    }
  }
  // latest-callback ref so the watchdog effect can call the current reload() without taking it as a
  // dep (an unstable function there would reset the timer every render and starve the retry)
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  // ready watchdog: a slow dev server (Vite re-optimizing deps, or the box saturated by parallel
  // Live Jam agents) can leave boot()'s module fetches unresolved past the deadline - that is a slow
  // frame, NOT a failed one (a real failure posts sh:error immediately). So the first silent deadline
  // auto-renavigates ONCE on a fresh rev; a second silence stays 'loading' (never a red error card).
  // node.nav is a dep so a fresh navigation restarts the full budget; readyRetried flips true on the
  // retry and bounds it to exactly one.
  // The budget counts from ADMISSION (a queued frame is not silent). The retried document keeps its
  // boot slot - its boot is still running - and gives it back after a second silence.
  useEffect(() => {
    if (!admitted || node.status !== 'loading' || !frame || node.missing) return
    const t = setTimeout(() => { if (shouldArmReadyWatch(node, true)) reloadRef.current(true); else release(node.key) }, 10_000)
    return () => clearTimeout(t)
    // depend on the frame's stable SIGNATURE, not the manifest object - that object is replaced on
    // every manifest reconcile, so depending on it would reset the budget on unrelated frames during
    // heavy Live Jam churn and starve the retry. kind/file still re-arm on a real file swap.
  }, [admitted, node.status, node.readyRetried, node.nav, node.key, node.missing, frame?.kind, frame?.file])

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
    // Defer sh-gesturing (and its `will-change: transform` on .sh-content) until an ACTUAL drag
    // begins - a bare click otherwise promotes then demotes the compositor layer, re-rasterising
    // the frame's text at a fractional zoom = the "jiggle". A pure click now never toggles it.
    let gesturing = false
    const begin = () => {
      if (gesturing) return
      gesturing = true
      world.classList.add('sh-gesturing')   // drops iframe pointer-events
      setGesture(true)
      if (mode !== 'move') { resizing.current = true; wake(node.key, iframeRef.current); setResizeTick((t) => t + 1) }   // awake before the first resized paint, for the whole resize
    }
    const MOVE_THRESHOLD = 3   // px in screen space before a press counts as a drag

    const onMove = (ev: PointerEvent) => {
      if (!gesturing && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < MOVE_THRESHOLD) return
      begin()
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
      if (resizing.current) { resizing.current = false; setResizeTick((t) => t + 1) }   // settle, then sleep again
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

  // variant badge: letter + name floating LEFT of the frame, outside the
  // artwork, world-anchored (scales with zoom) with a screen-space minimum via --sh-inv
  const variantName = frame.title
    ?? cap((frame.id.split('/').pop() ?? '').replace(/^[a-z]-/, '').replace(/-/g, ' '))

  return (
    <div
      className={`sh-node${selected ? ' sel' : ''}${interact ? ' interact' : ''}${working ? ' working' : ''}`}
      data-theme={node.theme}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h + HEADER, zIndex: hostsCard ? 30 : undefined,
        // the sticky column's width (spec 18): the docked comment card clears it on the left
        ...(notes.length ? { ['--sh-note-w' as string]: `${Math.max(...notes.map((n) => (n.kind === 'scene' ? 380 : 260)))}px` } : {}),
        // phase every working animation by when THIS frame's job started - parallel
        // frames pulsing in sync would read as one fake choreography
        ...(working ? { ['--mv-w0' as string]: `${-(Date.now() - (workingSince ?? Date.now()))}ms` } : {}) }}
      data-node={node.key}
    >
      {working && <WorkShimmer belowBadge={!!frame.variantGroup} />}
      <Stickies nodeKey={node.key} frameId={frame.id} notes={notes} underBadge={!!frame.variantGroup} />
      {frame.variantGroup && (
        <div className="sh-vbadge sh-no-pan" title={`${frame.variantGroup} · variant ${frame.variant?.toUpperCase()} - click to select`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { select(node.key, e.shiftKey) }}>
          <b>{frame.variant?.toUpperCase()}</b>
          <span>{variantName}</span>
        </div>
      )}
      <div className="sh-node-head sh-no-pan" onPointerDown={(e) => drag(e, 'move')} title={frame.file}>
        {/* the chrome badge: slide first, else the content intent glyph */}
        {frame.slide
          ? <SlideFrameIcon size={12} className="iicon sh-no-pan" role="img" aria-hidden={false} aria-label="slide" />
          : frame.intent && <IntentGlyph intent={frame.intent} size={12} className="iicon sh-no-pan" aria-label={frame.intent} />}
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
              <button className="sh-no-pan" onClick={() => reload(false)}>
                <ReloadIcon size={12} /> reload
              </button>
              <button className="sh-no-pan" onClick={() => { navigator.clipboard.writeText(`${frame.file}: ${node.error}`); toast('error copied for agent') }}>
                <CopyIcon size={12} /> copy for agent
              </button>
            </span>
          </div>
        ) : null}
        {/* a frame still silent after its one auto-retry: a slow dev server, never a failure. A quiet
            non-covering pill (not the red card) keeps it honest and offers a manual reload. */}
        {node.status === 'loading' && node.readyRetried ? (
          <div className="sh-loading sh-no-pan">
            <span>still loading</span>
            <button className="sh-no-pan" onClick={() => reload(false)}>
              <ReloadIcon size={11} /> reload
            </button>
          </div>
        ) : null}
        <iframe
          ref={bindIframe}
          className="sh-live"
          src={src}
          title={frame.id}
          onLoad={registerWin}
          style={{ ...iframeBox(stage, node), display: node.missing || node.status === 'error' ? 'none' : 'block' }}
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
        {working && <div className="sh-work-wave" />}
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
