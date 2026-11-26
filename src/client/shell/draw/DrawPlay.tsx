/**
 * A drawing in play (spec 38, frames `2-top-bar-play` and `2-top-bar-play-collapsed`): the drawing fills the tab on its
 * own paper; one left panel (its name and the drawing menu, collapse ⌘\, then the properties), the tool bar top right
 * (collapse ⌘/), the view controls bottom right; Hide all UI (H brings it back); Esc goes back to the canvas.
 * Positions are the canvas's own: right under the Mac app's strip, 10 px in. Published: view only (name, view).
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useStore, PUBLISHED } from '../store.ts'
import { useComments } from '../comments-store.ts'
import { DraftComposer, DrawWorkLayer, MarkerFace, Pins, ThreadCard, isDrawAnchorish, placePins } from '../Comments.tsx'
import { commentGate, commentsEscape, toggleCommentMode, toggleLaserComment, togglePins } from '../comment-keys.ts'
import { toggleHideUI, useHideUI } from '../Toolbar.tsx'
import { jamKey } from '../jam-keys.ts'
import { frameGone, frameLoaded, frameReady } from '../jam-capture.ts'
import { CommentIcon } from '../icons.tsx'
import { useDrawPlay } from './play-state.ts'
import { useMenuKeys } from './DrawMenu.tsx'
export { useDrawPlay } from './play-state.ts'
import { withWs } from '../api.ts'
import { ROUTE } from '../../const.ts'
import { framePath } from '../ContextMenu.tsx'
import { ImagesSquareIcon, MoonIcon, PanelFilledIcon, PanelHollowIcon, SignpostIcon, SunIcon } from '../icons.tsx'
import { DrawBar } from './DrawBar.tsx'
import { DrawPanel } from './DrawPanel.tsx'
import { DrawView } from './DrawView.tsx'
import { HoverTip, MAIN_TOOLS, MI, Ph } from './kit.tsx'
import { drawMessage, exportDrawing, sendQuiet, useDraw, type DrawLink } from './link.ts'
import { cmd } from '../commands.ts'

/** Play follows the canvas's theme: the switch turns it (⋯, the name menu, ⌥⇧D - D alone stays the diamond in a drawing). */
function switchTheme(via: 'click' | 'key'): void {
  cmd('theme', { via, in: 'stage' })
  const st = useStore.getState()
  st.setTheme(st.viewTheme === 'dark' ? 'light' : 'dark')
}


/** P on a selected drawing (or the board's play while one is selected or in drawing mode) plays the drawing. */
export function playDrawingIfSelected(): boolean {
  const s = useStore.getState()
  const key = s.interact ?? (s.selection.length === 1 ? s.selection[0] : null)
  let n = key ? s.nodes.find((x) => x.key === key) : undefined
  // a board of drawings only: play its first one (the prototype play has nothing to show there)
  if (!n && !s.nodes.some((x) => !x.missing && s.frameFor(x)?.kind === 'tsx')) n = s.nodes.find((x) => !x.missing && s.frameFor(x)?.kind === 'draw')
  const f = n ? s.frameFor(n) : undefined
  if (!n || !f || f.kind !== 'draw' || n.missing) return false
  if (s.interact) s.setInteract(null)
  useDrawPlay.getState().open(f.id, n.key)
  return true
}

const EDGE: CSSProperties = { top: 'max(10px, var(--mv-top, 0px))' }

export function DrawPlay() {
  const at = useDrawPlay((s) => s.at)
  const close = useDrawPlay((s) => s.close)
  const frame = useStore((s) => (at ? s.manifest?.frames.find((f) => f.id === at) : undefined))
  const theme = useStore((s) => s.viewTheme)
  const toast = useStore((s) => s.toast)
  const key = at ? `play:${at}` : ''
  const state = useDraw((s) => (key ? s.states[key] : undefined))
  const iframe = useRef<HTMLIFrameElement>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [barOpen, setBarOpen] = useState(true)
  // Hide all UI is the shell's one state (spec 39 B5): H, the ⋯ row, the bar and the Mac app's menu check share it
  const hidden = useHideUI()
  const setHidden = (on: boolean) => { if (on !== hidden) toggleHideUI() }
  const hiddenRef = useRef(false)
  hiddenRef.current = hidden
  const [menu, setMenu] = useState(false)
  const [readyTick, setReadyTick] = useState(0)
  const nameMenu = useRef<HTMLDivElement>(null)
  useMenuKeys(nameMenu, menu, () => setMenu(false), key || undefined)
  const src = useRef('')
  const flushed = useRef<(() => void) | null>(null)
  const [closing, setClosing] = useState(false)
  if (at && !src.current) src.current = withWs(`${ROUTE}/draw/?id=${encodeURIComponent(at)}&theme=${theme}&r=play`)
  if (!at) src.current = ''

  const link: DrawLink | null = at && frame ? { key, title: frame.title ?? at.split('/').pop() ?? 'drawing', frame: at, win: () => iframe.current?.contentWindow } : null

  // this host's messages: its state, its exports, Escape (back to the canvas), the keys it hands back
  useEffect(() => {
    if (!at) return
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.current?.contentWindow || (e.origin && e.origin !== location.origin)) return
      const d = e.data
      // play owns the drawing's wheel and keys - published too (view only there: the host keeps it in view mode)
      if (d?.type === 'sh:ready') {
        try { iframe.current?.contentWindow?.postMessage({ type: 'sh:interactive', on: true }, location.origin) } catch { /* gone */ }
        // the UI's state again, now that the drawing listens (the first one can land before it does): H is Hide all UI
        if (link) sendQuiet(link, { op: 'ui', hidden: hiddenRef.current })
        // comment mode too (spec 39 B5), and the keys the shell owns mirrored into it (⌘K, the laser's, Jam's)
        pickNow()
        frameReady('draw-play')
        // the comments re-drive what they told it (subscriptions, the highlight, a pending reveal) - review r1 #7
        setReadyTick((n) => n + 1)
        return
      }
      if (d?.type === 'sh:draw-flushed') { flushed.current?.(); return }
      // Escape: comments close first (spec 39 B4), then play ends
      if (d?.type === 'sh:exit-interact') { if (commentsEscape(cmd('escape', { via: 'key', in: 'stage', keys: 'Escape' }))) return; leave(); return }
      // comment mode: the drawing reports the element (or paper point) picked - the draft goes on the played node
      if (d?.type === 'sh:picked') {
        const c = useComments.getState()
        if (!c.commentMode || String(d.id ?? '') !== at) return
        if (c.active) c.setActive(null)
        cmd('comment-pick', { via: 'click', in: 'stage', frame: at })
        c.setDraft({ nodeKey: useDrawPlay.getState().node ?? `play:${at}`, frame: at, anchor: d.anchor })
        return
      }
      // a press in the drawing closes an open card (the shell's own listeners never see it)
      if (d?.type === 'sh:frame-down') { const c = useComments.getState(); if (c.active) { cmd('thread-close', { via: 'click', in: 'stage' }); c.setActive(null) } return }
      if (d?.type === 'sh:key') { if (typeof d.key === 'string') jamKey({ key: d.key, shift: !!d.shift, alt: !!d.alt, meta: !!d.meta, ctrl: !!d.ctrl }, 'stage'); return }
      if (d?.type === 'sh:draw-key') {
        if (d.key === 'reveal') setHidden(false)
        else if (d.key === 'hide') { cmd('hide-ui', { via: 'key', in: 'stage' }); setHidden(true) }
        else if (d.key === 'comments') toggleCommentMode({ via: 'key', in: 'stage', keys: 'c' })
        else if (d.key === 'pins') togglePins({ via: 'key', in: 'stage', keys: '⇧c' })
        else if (d.key === 'laser-comment') toggleLaserComment({ via: 'key', in: 'stage', keys: '⇧l' })
        else if (d.key === 'theme') switchTheme('key')
        else if (d.key === 'panel') setPanelOpen((o) => !o)
        else if (d.key === 'toolbar') setBarOpen((o) => !o)
        return
      }
      drawMessage(key, d)
    }
    addEventListener('message', onMsg)
    return () => removeEventListener('message', onMsg)
  }, [at, hidden])
  // comment mode follows the shared store - the toolbar, C anywhere and the Mac app's Comments item all drive it (B5)
  const commentMode = useComments((s) => s.commentMode)
  const showAnchor = useComments((s) => s.showAnchor)
  const pickNow = () => { try { iframe.current?.contentWindow?.postMessage({ type: 'sh:pick', on: useComments.getState().commentMode, quiet: !useComments.getState().showAnchor }, location.origin) } catch { /* not yet */ } }
  useEffect(() => { if (at) pickNow() }, [at, commentMode, showAnchor])
  useEffect(() => () => frameGone('draw-play'), [at])
  // theme follows the canvas's
  useEffect(() => { try { iframe.current?.contentWindow?.postMessage({ type: 'sh:set-theme', theme }, location.origin) } catch { /* not yet */ } }, [theme])
  // play tells the host the UI's state: H toggles Hide all UI here (Excalidraw's hand keeps H on the canvas)
  useEffect(() => { hiddenRef.current = hidden; if (link) sendQuiet(link, { op: 'ui', hidden }) }, [hidden, at])

  // a thread on another drawing opened from a notice or the sidebar leaves play through this - its last save first
  const leaveRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!at) return
    useDrawPlay.setState({ leave: () => leaveRef.current() })
    return () => useDrawPlay.setState({ leave: null })
  }, [at])

  if (!at || !link) return null
  // leaving waits for the drawing's last save (3 s at most - a dead server never traps the person in play)
  // leaving hides play at once; the drawing's document stays (out of sight) until its last save has landed, so a slow
  // save never loses a stroke
  const leave = () => {
    const done = () => { flushed.current = null; setClosing(false); useDraw.getState().drop(key); close() }
    cmd('play-exit', { via: 'click', in: 'stage' })
    if (!link || PUBLISHED) { done(); return }
    flushed.current = done
    setClosing(true)
    sendQuiet(link, { op: 'flush' })
  }
  leaveRef.current = leave
  const dark = theme === 'dark'
  const copyPath = () => { if (!frame) return; navigator.clipboard.writeText(framePath(useStore.getState().board, frame)).then(() => toast('path copied'), () => toast('copy blocked - click the drawing first')) }
  const copyImage = () => exportDrawing(link, 'clipboard', toast, dark)
  // keeps the keyboard in the drawing - but text in a comment card can still be selected (spec 39 B4)
  const keepFocus = (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest('input, textarea, .cm-card, .cm-pin, .cm-stack, .cm-composer')) e.preventDefault() }
  const commentBtn = <DrawCommentButton />

  const head = (
    <div className="dk-phead">
      <HoverTip label="Drawing menu" side="right">
        <button className="dk-b name" aria-label="Drawing menu" onClick={() => setMenu((m) => !m)}><Ph n="PenNib" size={14} /><span>{link.title}</span><Ph n="CaretDown" size={10} className="cv" /></button>
      </HoverTip>
      <HoverTip label="Collapse panel" keys="⌘\" side="bottom">
        <button className="dk-b ic" aria-label="Collapse panel" onClick={() => { cmd('panel', { via: 'click', in: 'stage' }); setPanelOpen(false) }}><PanelFilledIcon size={17} /></button>
      </HoverTip>
    </div>
  )
  return (
    <div className={`sh-play dk-playhost${hidden ? ' hidden-ui' : ''}`} onMouseDown={keepFocus} aria-hidden={closing || undefined}
      // the drawing's own paper fills the tab, the strip behind the app's tabs included (the play frames' note)
      style={{ position: 'fixed', inset: 0, zIndex: 60, paddingTop: 'var(--mv-top, 0px)', boxSizing: 'border-box', background: state?.paper ?? (dark ? '#121212' : '#ffffff'), ...(closing ? { visibility: 'hidden', pointerEvents: 'none' } : {}) }}>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 'var(--mv-top, 0px)' }}>
        <iframe ref={iframe} src={src.current} title={link.title} onLoad={() => frameLoaded('draw-play', iframe.current)} />
        <DrawPlayComments iframe={iframe} frameId={at} ready={readyTick} />
        <DrawWorkLayer frameId={at} iframe={iframe} ready={readyTick > 0} />
      </div>
      {panelOpen
        ? <DrawPanel link={link} state={state} top={head} popSide="right" style={{ ...EDGE, left: 10 }} />
        : <div className="dk-anchor" style={{ ...EDGE, left: 10 }}><HoverTip label="Expand panel" keys="⌘\" side="right"><button className="dk-glass dk-fab" aria-label="Expand panel" onClick={() => { cmd('panel', { via: 'click', in: 'stage' }); setPanelOpen(true) }}><PanelHollowIcon size={18} /></button></HoverTip></div>}
      {menu && panelOpen && (
        <div ref={nameMenu} className="sh-menu dk-menu" style={{ position: 'absolute', top: 'calc(max(10px, var(--mv-top, 0px)) + 52px)', left: 20, zIndex: 50 }} onMouseLeave={() => setMenu(false)}>
          <MI icon={<Ph n="FilePng" size={15} />} label="Export as PNG" onClick={() => { setMenu(false); exportDrawing(link, 'png', toast, dark) }} />
          <MI icon={<Ph n="FilePdf" size={15} />} label="Export as PDF" onClick={() => { setMenu(false); exportDrawing(link, 'pdf', toast, dark) }} />
          <div className="div" />
          <MI icon={<ImagesSquareIcon size={15} />} label="Copy as image" k="⇧I" onClick={() => { setMenu(false); copyImage() }} />
          <MI icon={<SignpostIcon size={15} />} label="Copy path" k="⇧P" onClick={() => { cmd('copy-path', { via: 'click', in: 'stage' }); setMenu(false); copyPath() }} />
          <div className="div" />
          <MI icon={dark ? <SunIcon size={15} /> : <MoonIcon size={15} />} label={dark ? 'Light mode' : 'Dark mode'} k="⌥⇧D" onClick={() => { setMenu(false); switchTheme('click') }} />
          <MI icon={<Ph n="EyeSlash" size={15} />} label="Hide all UI" k="H" onClick={() => { cmd('hide-ui', { via: 'click', in: 'stage' }); setMenu(false); setHidden(true) }} />
        </div>
      )}
      {state?.editable !== false && (barOpen
        ? <DrawBar link={link} state={state} tools={MAIN_TOOLS} mode="play" style={{ ...EDGE, right: 10 }}
            onExport={(k) => exportDrawing(link, k, toast, dark)} onCopyImage={copyImage}
            onCollapse={() => { cmd('toolbar', { via: 'click', in: 'stage' }); setBarOpen(false) }} onHideUI={() => { cmd('hide-ui', { via: 'click', in: 'stage' }); setHidden(true) }} onBack={leave}
            onTheme={() => switchTheme('click')} dark={dark} comment={commentBtn} />
        : <div className="dk-anchor" style={{ ...EDGE, right: 10 }}><HoverTip label="Expand toolbar" keys="⌘/" side="bottom"><button className="dk-glass dk-fab" aria-label="Expand toolbar" onClick={() => { cmd('toolbar', { via: 'click', in: 'stage' }); setBarOpen(true) }}><PanelHollowIcon size={18} style={{ transform: 'rotate(90deg)' }} /></button></HoverTip></div>)}
      <DrawView link={link} state={state} size="lg" map menuSide="top" style={{ right: 10, bottom: 10 }} />
      {state?.editable === false && (
        <div className="dk-anchor dk-pair" style={{ ...EDGE, right: 10 }}>
          {/* a view-only (published) drawing has no bar: the comment button sits beside the Back X (spec 39 A2) */}
          <DrawCommentButton fab />
          <HoverTip label="Back to the canvas" keys="esc" side="bottom"><button className="dk-glass dk-fab" aria-label="Back to the canvas" onClick={leave}><Ph n="X" size={16} /></button></HoverTip>
        </div>
      )}
    </div>
  )
}

/** Drawing play's comment button (spec 39 B5): the comment button's own rules - unplaced, stopped, a view-only role
 *  ("Ask to comment"), signed out (sign in) - in the drawing's skin. */
function DrawCommentButton({ fab = false }: { fab?: boolean }) {
  const commentMode = useComments((s) => s.commentMode)
  const show = useComments((s) => s.show)
  const asked = useRef(0)
  useComments((s) => s.myBoards)
  const locked = commentGate() === 'locked'
  if (locked) {
    return (
      <HoverTip label="Commenting is not available for you yet - click to ask the owner" side="bottom">
        <button className={fab ? 'dk-glass dk-fab' : 'dk-b'} aria-label="Ask to comment" style={{ opacity: .55 }} onClick={() => {
          const h = cmd('ask-to-comment', { via: 'click', in: 'stage' })
          if (Date.now() - asked.current < 8000) { h.noop('too-soon'); return }
          asked.current = Date.now()
          void useComments.getState().askToComment().then((ok) => { if (ok) h.done(); else h.fail('api'); useStore.getState().toast(ok ? 'asked the owner for comment access - they decide' : 'could not send the request - try again') })
        }}><CommentIcon size={16} /></button>
      </HoverTip>
    )
  }
  return (
    <HoverTip label={show ? 'Comment' : 'Comment (pins hidden: ⇧C)'} keys="C" side="bottom">
      <button className={`${fab ? 'dk-glass dk-fab' : 'dk-b'}${commentMode ? ' on' : ''}`} aria-label="Comment" onClick={() => { toggleCommentMode({ via: 'click', in: 'stage' }) }}><CommentIcon size={16} /></button>
    </HoverTip>
  )
}

/** The comment overlay over the played drawing (spec 39 B5): the canvas's pins, card and composer, placed from what the
 *  drawing pushes - moving with it by translation while it moves, landing once it stops, out-of-view pins parked. */
// memoised: a pan changes the drawing's state every frame, and that must never re-render the comments (review r1 #5)
const DrawPlayComments = memo(function DrawPlayComments({ iframe, frameId, ready }: { iframe: React.RefObject<HTMLIFrameElement | null>; frameId: string; ready: number }) {
  const show = useComments((s) => s.show)
  const showAnchor = useComments((s) => s.showAnchor)
  const active = useComments((s) => s.active)
  const draft = useComments((s) => s.draft)
  const allThreads = useComments((s) => s.threads)
  const node = useDrawPlay((s) => s.node)
  const threads = allThreads.filter((t) => t.frame === frameId && !t.resolved && isDrawAnchorish(t.anchor))
  const [points, setPoints] = useState<Record<string, { x: number; y: number } | null>>({})
  const [offs, setOffs] = useState<Set<string>>(() => new Set())
  const placedAt = useRef<Record<string, { x: number; y: number }>>({})
  const layer = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => {
    const measure = () => { const r = layer.current?.getBoundingClientRect(); if (r) setBox({ w: r.width, h: r.height }) }
    measure()
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [])
  const draftHere = draft?.frame === frameId && isDrawAnchorish(draft.anchor) ? draft.anchor : null

  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win) return
    const list = threads.map((t) => ({ key: t.id, anchor: t.anchor }))
    if (draftHere) list.push({ key: 'draft', anchor: draftHere })
    const ask = () => { try { win.postMessage({ type: 'sh:resolve-anchors', anchors: list }, location.origin) } catch { /* gone */ } }
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win || e.origin !== location.origin || e.data?.type !== 'sh:anchor-rects' || e.data.id !== frameId || e.data.channel) return
      const rects: any[] = e.data.rects ?? []
      if (e.data.moving) {
        layer.current?.classList.add('cm-moving')
        for (const r of rects) {
          if (r.orphan || !r.point) continue
          const was = placedAt.current[r.key]
          const pin = (r.key === 'draft' ? layer.current?.querySelector('.cm-draft') : layer.current?.querySelector(`[data-thread="${CSS.escape(r.key)}"]`)) as HTMLElement | null
          if (pin && was) pin.style.translate = `${r.point.x - was.x}px ${r.point.y - was.y}px`
        }
        return
      }
      if (layer.current) { layer.current.classList.remove('cm-moving'); for (const pin of layer.current.querySelectorAll<HTMLElement>('.cm-pin, .cm-draft')) pin.style.translate = '' }
      const next: typeof points = {}
      const off = new Set<string>()
      for (const r of rects) {
        if (r.orphan) { next[r.key] = null; continue }
        if (r.off && r.key !== 'draft') { off.add(r.key); next[r.key] = null; continue }
        next[r.key] = r.point
        placedAt.current[r.key] = r.point
      }
      setPoints((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
      setOffs((cur) => (cur.size === off.size && [...off].every((k) => cur.has(k)) ? cur : off))
    }
    addEventListener('message', onMsg)
    ask()
    const iv = setInterval(ask, 8000)
    return () => { clearInterval(iv); removeEventListener('message', onMsg); if (!list.length) ask() }
  }, [frameId, threads.map((t) => `${t.id}:${JSON.stringify(t.anchor)}`).join(','), JSON.stringify(draftHere), iframe, ready])

  // the open thread's or the draft's element lit (⇧L), and a thread opened on purpose brought into view once
  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win) return
    const a = !show || !showAnchor ? null : draftHere ?? (active ? threads.find((t) => t.id === active)?.anchor ?? null : null)
    win.postMessage({ type: 'sh:highlight-anchor', frame: frameId, anchor: a ?? null }, location.origin)
  }, [active, JSON.stringify(draftHere), show, showAnchor, frameId, ready])
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!ready) return
    const t = active ? threads.find((x) => x.id === active) : undefined
    if (t && revealed.current !== `${t.id}@${ready}`) { revealed.current = `${t.id}@${ready}`; iframe.current?.contentWindow?.postMessage({ type: 'sh:draw-cmd', op: 'reveal', anchor: t.anchor }, location.origin) }
    if (!t) revealed.current = null
  }, [active, ready])
  // a comment sent or closed gives the keyboard back to the drawing (the next letter is its tool - review r1 #6)
  const hadDraft = useRef(false)
  useEffect(() => {
    const has = !!draftHere
    if (hadDraft.current && !has) {
      const ae = document.activeElement as HTMLElement | null
      if (!ae || ae === document.body || !ae.closest('input, textarea, [contenteditable]')) iframe.current?.contentWindow?.postMessage({ type: 'sh:draw-cmd', op: 'focus' }, location.origin)
    }
    hadDraft.current = has
  }, [JSON.stringify(draftHere)])

  if (!show) return <div ref={layer} className="sh-play-comments" />
  const stagePoints = new Map<string, { x: number; y: number } | null>()
  const orphans = new Set<string>()
  for (const t of threads) {
    const p = points[t.id]
    if (p === null && !offs.has(t.id)) orphans.add(t.id)
    stagePoints.set(t.id, p ?? null)
  }
  const placed = placePins(threads, stagePoints, box.w, 1)
  // a crowd pushed past the window's foot is never lost: those pins gather in one stack (review r1 #12)
  const below = threads.filter((t) => (placed.get(t.id)?.y ?? 0) > box.h - 28 && t.id !== active)
  const shownThreads = below.length ? threads.filter((t) => !below.includes(t)) : threads
  const activeThread = threads.find((t) => t.id === active)
  const draftAt = draftHere ? (points.draft ?? (draftHere as any)?.point ?? null) : null
  return (
    <div ref={layer} className="sh-play-comments">
      <Pins threads={shownThreads} placed={placed} orphans={orphans} inv={1} active={active} offs={offs} published={PUBLISHED} />
      {below.length > 0 && (
        <button className="cm-stack sh-no-pan dk-crowd" style={{ top: 'auto', bottom: 70, right: 14 }} title={`${below.length} more ${below.length === 1 ? 'comment' : 'comments'} below`}
          onClick={(e) => { e.stopPropagation(); cmd('thread-open', { via: 'click', in: 'stage', frame: frameId }); useComments.getState().setActive(below[0].id) }}>
          <MarkerFace threads={below} />
        </button>
      )}
      {activeThread && <ThreadCard key={active!} thread={activeThread} at={placed.get(activeThread.id)!} bounds={box} nodeKey={node ?? undefined} stage />}
      {draftAt && <DraftComposer at={draftAt} bounds={box} hue={(draftHere as any)?.el?.hue} />}
    </div>
  )
})
