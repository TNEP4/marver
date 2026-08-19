/**
 * Play mode (SPEC-M2 §1): full-window near-black backdrop, ONE device shell centered at
 * the chosen viewport's exact CSS pixels, scaled to fit - or `fill`, where the frame IS
 * the window. The device hosts a single stage iframe that swaps frames in place.
 *
 * The prototype is a first-class review surface (prototype-review): the top-right pill is
 * the SAME glass toolbar as the canvas (board · comment · laser · device · theme · hide ·
 * collapse · exit), the stage runs the SAME laser/comment/anchor controller as canvas
 * frames, and comments anchor to the walked frame. Chrome is shown unless Hide-UI (H) is
 * on - no auto-fade, no hover magic. The bottom-left navigator (restart · prev · i/N ·
 * next) stays prototype-only.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore, CONFIG, boardLabel, cap, fetchBoardNames, type Node } from './store.ts'
import { useComments } from './comments-store.ts'
import { ROUTE } from '../const.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { Tip } from './Tip.tsx'
import { CommentButton, DevicePicker, HideUIButton, isHideUI, LaserButton, Popover, ThemePicker, toggleHideUI, usePopover } from './Toolbar.tsx'
import { DraftComposer, hueVars, MarkerFace, ThreadCard } from './Comments.tsx'
import { ArrowLeftIcon, ArrowRightIcon, CaretIcon, CheckIcon, PanelFilledIcon, PanelHollowIcon, ReloadIcon, XIcon } from './icons.tsx'

const commentsStore = () => useComments.getState()

/** Board-order frame ids playable on the stage (tsx only - html frames are their own
 *  documents and cannot mount into the persistent chain), deduped. */
function playList(): string[] {
  const s = useStore.getState()
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of s.nodes) {
    if (n.missing || seen.has(n.frame)) continue
    const f = s.frameFor(n)
    if (!f || f.kind !== 'tsx') continue
    seen.add(n.frame)
    out.push(n.frame)
  }
  return out
}

/** Enter play on the current board: first selected node starts, else the first node.
 *  `over` (deep links) can pin the start frame, device, and theme - the start may be any
 *  playable manifest frame, not just a board node: the stage itself allows data-goto to
 *  off-board frames, so a link captured mid-flow must restore to the same screen. */
export function enterPlay(over?: { at?: string; device?: string; theme?: string }) {
  const s = useStore.getState()
  const list = playList()
  if (!list.length) { s.toast('nothing to play on this board'); return }
  const overAt = over?.at && s.manifest?.frames.some((f) => f.id === over.at && f.kind === 'tsx') ? over.at : undefined
  const selNode = s.selection.map((k) => s.nodes.find((n) => n.key === k)).find((n): n is Node => !!n && list.includes(n.frame))
  // node is undefined only for an off-board overAt - frame meta then carries the defaults
  const node = (overAt ? s.nodes.find((n) => n.frame === overAt) : undefined)
    ?? (overAt ? undefined : selNode ?? s.nodes.find((n) => list.includes(n.frame)))
  const at = overAt ?? node!.frame
  const frame = s.manifest?.frames.find((f) => f.id === at)
  // device: the link's; else the node's width names it; else the frame's declared viewport
  const names = Object.keys(CONFIG.viewports)
  const device = (over?.device && (CONFIG.viewports[over.device] || over.device === 'fill') ? over.device : undefined)
    ?? (node ? names.find((v) => CONFIG.viewports[v].width === node.w) : undefined)
    ?? (frame?.viewport && CONFIG.viewports[frame.viewport] ? frame.viewport : names[0])
  const theme = (over?.theme && CONFIG.themes.includes(over.theme) ? over.theme : undefined)
    ?? node?.theme ?? frame?.theme ?? s.viewTheme
  s.setPlay({ at, device, theme })
}

/** Switch boards WITHOUT leaving play: the overlay stays up over the canvas churn, then
 *  a fresh stage mounts at the new board's start (PlayInner is keyed by board). */
async function switchPlayBoard(name: string) {
  const s = useStore.getState()
  if (name === s.board) return
  const device = s.play?.device               // the device is the viewer's choice - it survives the switch
  await s.switchBoard(name)
  if (useStore.getState().board === name) enterPlay(device ? { device } : undefined)
}

/** Control channel for history restores: the popstate handler steers the mounted stage
 *  without a remount. Assigned by PlayInner; a no-op while play is closed. */
export const playCtl = {
  setAt: (_at: string) => {},
  /** Apply a parsed play hash to the OPEN session - at, device, and theme alike. */
  sync: (_p: { at?: string; device?: string; theme?: string }) => {},
}

export function PlayOverlay() {
  const play = useStore((s) => s.play)
  const board = useStore((s) => s.board)
  if (!play) return null
  return <PlayInner key={board} />
}

/** Board switcher dropdown in the play pill - the shared glass popover. */
function BoardMenu({ current }: { current: string }) {
  const pop = usePopover()
  const [names, setNames] = useState<string[]>([current])
  // refreshed on every open - agents create boards while you present
  useEffect(() => { if (pop.open) fetchBoardNames().then(setNames).catch(() => {}) }, [pop.open])
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <Tip side="bottom" label={<b>Switch board</b>}>
        <button className="sh-pill-btn bd" onClick={pop.toggle}>
          {boardLabel(current)}
          <CaretIcon size={11} style={{ transform: pop.open ? 'rotate(180deg)' : undefined }} />
        </button>
      </Tip>
      <Popover pop={pop} dark>
        {names.map((n) => (
          <button key={n} onClick={() => { pop.setOpen(false); switchPlayBoard(n) }}>
            <span>{boardLabel(n)}</span>
            {n === current && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
      </Popover>
    </div>
  )
}

/** The comment overlay over the single stage frame (prototype-review Phase 2). Per-frame:
 *  it shows only threads on the walked frame (play.at) and follows the walk. It sits inset:0
 *  inside the device wrapper (no JS coordinates - it tracks the centered stage for free);
 *  pins/cards are placed in the scaled stage space, #4/#5 highlight is driven into the frame. */
function PlayComments({ iframe, frameId, vp, dw, dh, ready }: {
  iframe: React.RefObject<HTMLIFrameElement | null>
  frameId: string
  vp: { width: number; height: number }
  dw: number; dh: number; ready: number
}) {
  const show = useComments((s) => s.show)
  const showAnchor = useComments((s) => s.showAnchor)
  const active = useComments((s) => s.active)
  const draft = useComments((s) => s.draft)
  const allThreads = useComments((s) => s.threads)
  const { setActive } = useComments.getState()
  const threads = allThreads.filter((t) => t.frame === frameId && !t.resolved)
  const anchored = threads.filter((t) => (t.anchor as any)?.el)
  const [rects, setRects] = useState<Record<string, { x: number; y: number; w: number; h: number } | null>>({})
  const sx = vp.width ? dw / vp.width : 1
  const sy = vp.height ? dh / vp.height : 1

  // resolve anchors against the stage's current frame; re-ask on a slow interval (the
  // stage swaps in place, so the DOM under an anchor can change without a remount)
  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win || !anchored.length) { setRects({}); return }
    const ask = () => win.postMessage({ type: 'sh:resolve-anchors', anchors: anchored.map((t) => ({ key: t.id, anchor: t.anchor })) }, location.origin)
    const onMsg = (e: MessageEvent) => {
      // reject a reply from a frame we already walked off (data.id is the frame that resolved)
      if (e.source !== win || e.origin !== location.origin || e.data?.type !== 'sh:anchor-rects' || e.data.id !== frameId) return
      const next: typeof rects = {}
      for (const r of e.data.rects ?? []) next[r.key] = r.orphan ? null : r.rect
      setRects(next)
    }
    window.addEventListener('message', onMsg)
    ask()
    // a silent walk swaps the stage a frame or two AFTER frameId changes; ask again quickly
    // so pins/highlight land within ~1s instead of waiting on the 3s poll (the frame drops
    // stale replies by id, so an early ask against the old DOM is harmless)
    const t1 = setTimeout(ask, 250)
    const t2 = setTimeout(ask, 700)
    const iv = setInterval(ask, 3000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearInterval(iv); window.removeEventListener('message', onMsg) }
  }, [frameId, anchored.map((t) => t.id).join(','), iframe, ready])

  // #4/#5: drive the persistent element highlight into the frame - the composing draft, or
  // the open thread's anchor. null clears it. The frame guards against a stage-swap race;
  // `ready` re-drives it after a stage reload wiped the frame's lock.
  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win) return
    // only while the thread is active (or composing) AND pins are shown AND element focus is
    // on (⇧L) - closing, ⇧C, or dimming focus clears it
    const at = !show || !showAnchor ? null : (draft?.frame === frameId ? draft.anchor
      : (active ? (threads.find((t) => t.id === active && (t.anchor as any)?.el)?.anchor ?? null) : null))
    win.postMessage({ type: 'sh:highlight-anchor', frame: frameId, anchor: at ?? null }, location.origin)
  }, [active, draft, show, showAnchor, frameId, iframe, rects, ready])

  if (!show) return null

  const pinAt = (t: typeof threads[number]) => {
    const a = t.anchor as any
    const r = rects[t.id]
    if (a?.el && r) return { x: (r.x + (a.pos?.fx ?? .5) * r.w) * sx, y: (r.y + (a.pos?.fy ?? .5) * r.h) * sy, orphan: false }
    if (a?.el && r === null) return { x: dw - 16, y: 16, orphan: true }              // orphan parks top-right
    const p = a?.pos                                                                 // frame-level fraction
    return { x: (p?.fx ?? .94) * dw, y: (p?.fy ?? .06) * dh, orphan: false }
  }
  const activeThread = threads.find((t) => t.id === active)
  const draftAt = draft?.frame === frameId ? (() => {
    const a = draft.anchor as any
    return { x: ((a?.rect?.x ?? 0) + (a?.pos?.fx ?? .5) * (a?.rect?.w ?? 0)) * sx, y: ((a?.rect?.y ?? 0) + (a?.pos?.fy ?? .5) * (a?.rect?.h ?? 0)) * sy }
  })() : null

  return (
    <div className="sh-play-comments">
      {threads.map((t) => {
        const { x, y, orphan } = pinAt(t)
        return (
          <div key={t.id} className={`cm-pin sh-no-pan${t.id === active ? ' on' : ''}${orphan ? ' orphan' : ''}`}
            style={{ left: x, top: y, ...hueVars((t.anchor as any)?.el?.hue) }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setActive(t.id === active ? null : t.id) }}
            title={orphan ? 'the anchored element is gone - comment parked' : undefined}>
            <MarkerFace threads={[t]} />
          </div>
        )
      })}
      {activeThread && <ThreadCard key={active!} thread={activeThread} at={pinAt(activeThread)} bounds={{ w: dw, h: dh }} stage />}
      {draftAt && <DraftComposer at={draftAt} bounds={{ w: dw, h: dh }} hue={(draft?.anchor as any)?.el?.hue} />}
    </div>
  )
}

function PlayInner() {
  const play = useStore((s) => s.play)
  const board = useStore((s) => s.board)
  // A6/A7: a controlled frame edit while play is open never auto-reloads the live stage
  // (that would destroy the user's session mid-prototype). It records playUpdateRevision;
  // we surface an "Update ready" affordance, and applyPlayUpdate bumps playNav to reload
  // the stage at its current position on an explicit click.
  const playUpdateRevision = useStore((s) => s.playUpdateRevision)
  const playNav = useStore((s) => s.playNav)
  const laser = useStore((s) => s.laser)
  const commentMode = useComments((s) => s.commentMode)
  const playShowAnchor = useComments((s) => s.showAnchor)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // the src is frozen at mount - navigation happens INSIDE the stage; device and theme
  // changes must never reload it (a phone does not remount when you flip dark mode)
  const src = useRef(play ? `${ROUTE}/stage/?at=${encodeURIComponent(play.at)}&theme=${encodeURIComponent(play.theme)}` : '')
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [pillOpen, setPillOpen] = useState(true)          // collapse (pill -> re-open fab), like the canvas
  const [stageReady, setStageReady] = useState(0)         // bumps on each sh:stage-ready (reload) - re-drives the highlight
  const fill = play?.device === 'fill'

  // the stage is same-origin (/__mv/stage/); a fixed target origin keeps anchor bundles
  // from leaking if a link ever navigates the iframe cross-origin
  const postStage = (msg: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage(msg, location.origin)

  // apply a deferred update: reload the stage iframe at its CURRENT frame + theme on a fresh
  // rev-stamped URL. sh:stage-ready replays position; device size is shell-owned.
  useEffect(() => {
    if (!playNav || !iframeRef.current) return
    const p = useStore.getState().play
    if (!p) return
    iframeRef.current.src = `${ROUTE}/stage/?at=${encodeURIComponent(p.at)}&theme=${encodeURIComponent(p.theme)}&r=${playNav}`
  }, [playNav])
  const applyUpdate = () => useStore.getState().applyPlayUpdate()

  // laser / comment ride the same rail as canvas frames, broadcast to the stage iframe.
  // Re-sent on stage-ready (below) so a stage reload restores the mode.
  useEffect(() => { postStage({ type: 'sh:laser', on: laser }) }, [laser])
  useEffect(() => { postStage({ type: 'sh:pick', on: commentMode, quiet: !useComments.getState().showAnchor }) }, [commentMode, playShowAnchor])

  const exit = () => {
    const { at } = useStore.getState().play ?? {}
    if (isHideUI()) toggleHideUI()             // never strand the canvas with its chrome hidden
    useStore.getState().setPlay(null)
    // land back on the canvas at the frame you ended on
    const n = useStore.getState().nodes.find((x) => x.frame === at && !x.missing)
    if (n) { useStore.getState().select(n.key); setTimeout(() => canvasCtl.fitNode(n.key), 30) }
  }

  const setDevice = (name: string) => {
    const p = useStore.getState().play
    if (p && (CONFIG.viewports[name] || name === 'fill')) useStore.getState().setPlay({ ...p, device: name })
  }
  const setTheme = (t: string) => {
    const p = useStore.getState().play
    if (!p) return
    useStore.getState().setPlay({ ...p, theme: t })
    postStage({ type: 'sh:set-theme', theme: t })
  }
  /** Walk to a frame: the stage swaps silently; state + URL follow via the projection. */
  const goTo = (at: string) => playCtl.setAt(at)
  const step = (dir: 1 | -1) => {
    const p = useStore.getState().play
    if (!p) return
    const list = playList()
    if (!list.length) return
    const i = list.indexOf(p.at)
    // an off-board frame has no position: → restarts, ← goes to the last board frame
    goTo(i === -1 ? (dir === 1 ? list[0] : list[list.length - 1]) : list[(i + dir + list.length) % list.length])
  }
  const restart = () => { const list = playList(); if (list.length) goTo(list[0]) }

  /** Variant siblings of the CURRENT frame present on this board (SPEC-023 §6): the
   *  review question is "which direction is better on THIS screen" - switch in place,
   *  device and theme preserved, each variant's own data-goto links drive after. */
  const variantList = () => {
    const s = useStore.getState()
    const cur = s.manifest?.frames.find((f) => f.id === s.play?.at)
    if (!cur?.variantGroup) return []
    const onBoard = new Set(s.nodes.filter((n) => !n.missing).map((n) => n.frame))
    if (!onBoard.has(cur.id)) return []              // off-board frame: no coherent control
    return (s.manifest?.frames ?? [])
      .filter((f) => f.variantGroup === cur.variantGroup && f.kind === 'tsx' && onBoard.has(f.id))
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
  }
  const switchVariant = (dir: 1 | -1) => {
    const p = useStore.getState().play
    if (!p) return
    const vs = variantList()
    if (vs.length < 2) return
    const i = vs.findIndex((f) => f.id === p.at)
    goTo(vs[(i + dir + vs.length) % vs.length].id)
  }

  // history restores + walk: swap the stage silently (no sh:stage-at back) and track here
  useEffect(() => {
    playCtl.setAt = (at: string) => {
      postStage({ type: 'sh:stage-set', at })
      const p = useStore.getState().play
      if (p && p.at !== at) useStore.getState().setPlay({ ...p, at })
    }
    playCtl.sync = (p) => {
      const cur = useStore.getState().play
      if (!cur) return
      if (p.device && p.device !== cur.device) setDevice(p.device)
      if (p.theme && p.theme !== cur.theme) setTheme(p.theme)
      if (p.at && p.at !== cur.at) playCtl.setAt(p.at)
    }
    return () => { playCtl.setAt = () => {}; playCtl.sync = () => {} }
  }, [])

  // messages from the stage; source-validated against our one iframe
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow || (e.origin && e.origin !== location.origin)) return
      const data = e.data
      if (!data || typeof data.type !== 'string') return
      const s = useStore.getState()
      if (data.type === 'sh:stage-ready') {
        // an iframe reload (registry HMR invalidation) boots at the frozen initial src -
        // resync it to the shell's current truth: navigation, theme, AND review modes
        const p = s.play
        if (p) {
          if (typeof data.at === 'string' && data.at !== p.at) postStage({ type: 'sh:stage-set', at: p.at })
          postStage({ type: 'sh:set-theme', theme: p.theme })
        }
        postStage({ type: 'sh:laser', on: s.laser })
        postStage({ type: 'sh:pick', on: commentsStore().commentMode, quiet: !commentsStore().showAnchor })
        setStageReady((n) => n + 1)            // a reload wiped the frame's lock; let PlayComments re-drive it
      } else if (data.type === 'sh:stage-at') {
        const p = s.play
        if (p && typeof data.at === 'string') s.setPlay({ ...p, at: data.at })
      } else if (data.type === 'sh:stage-exit') {
        exit()
      } else if (data.type === 'sh:stage-error') {
        s.toast(`play: ${String(data.message ?? 'frame error')}`)
      } else if (data.type === 'sh:stage-key') {
        if (data.meta && data.key === '/') toggleCollapse()
        else handleKey(String(data.key), String(data.code))
      } else if (data.type === 'sh:picked') {
        // comment pick from the stage: stage the draft on the walked frame (its canvas
        // node when one is on this board, so the thread also lands on the canvas). Stamp
        // it with the frame the pick actually came FROM (data.id) and drop it if that no
        // longer matches the shell frame - a click that landed mid-swap on stale DOM.
        const c = commentsStore()
        if (c.active) c.setActive(null)
        if (!c.commentMode) return
        const at = String(data.id ?? '')
        if (!at || at !== s.play?.at) return
        const n = s.nodes.find((x) => x.frame === at && !x.missing)
        c.setDraft({ nodeKey: n?.key ?? '', frame: at, anchor: data.anchor })
      } else if (data.type === 'sh:frame-down') {
        const c = commentsStore()
        if (c.active) c.setActive(null)
      } else if (data.type === 'sh:laser-copy') {
        // laser click in the prototype: copy the element's address (frame file + css path)
        // and confirm in the frame's own hover label, exactly like the canvas does
        const at = s.play?.at
        const f = at ? s.manifest?.frames.find((x) => x.id === at) : undefined
        if (f) {
          const addr = `${f.file} · ${String(data.path ?? '')}${data.source ? ` (${String(data.source)})` : ''}`
          navigator.clipboard.writeText(addr).then(
            () => postStage({ type: 'sh:copy-ok', seq: data.seq }),
            () => s.toast('copy blocked - click the canvas first'))
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // shared handler: keys arrive directly (focus in shell) or forwarded by the stage
  const handleKey = (key: string, code: string) => {
    if (key === 'Escape') {
      // a live review mode swallows Escape first (cancel), so it never ejects you from
      // the prototype mid-comment; a second Escape (nothing live) exits
      const c = commentsStore()
      const s = useStore.getState()
      if (c.commentMode || s.laser || c.active || c.draft) { c.setMode(false); c.setActive(null); c.setDraft(null); s.setLaser(false) }
      else exit()
      return
    }
    if (key === 'ArrowRight') { step(1); return }
    if (key === 'ArrowLeft') { step(-1); return }
    if (key === '[') { switchVariant(-1); return }
    if (key === ']') { switchVariant(1); return }
    if (key === 'r') { restart(); return }
    if (key === 'h') { toggleHideUI(); return }
    if (key === 'l') { const s = useStore.getState(); if (!s.laser) commentsStore().setMode(false); s.setLaser(!s.laser); return }
    if (key === 'c') { const c = commentsStore(); if (!c.commentMode) useStore.getState().setLaser(false); c.setMode(!c.commentMode); return }
    if (key === 'C') { const c = commentsStore(); c.setShow(!c.show); return }   // ⇧C hides/shows pins
    if (key === 'L') { const c = commentsStore(); c.setShowAnchor(!c.showAnchor); return }   // ⇧L element focus

    if (/^Digit[1-9]$/.test(code)) {
      const names = Object.keys(CONFIG.viewports)
      const idx = Number(code.slice(5))
      if (idx <= names.length) setDevice(names[idx - 1])
      else if (idx === names.length + 1) setDevice('fill')
    }
    if (key === 'd' && CONFIG.themes.length > 1) {
      const p = useStore.getState().play!
      setTheme(CONFIG.themes[(CONFIG.themes.indexOf(p.theme) + 1) % CONFIG.themes.length])
    }
  }
  /** ⌘/ collapses the toolbar to a re-open fab - same shortcut + ladder as design mode. */
  const toggleCollapse = () => setPillOpen((o) => !o)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); toggleCollapse(); return }
      if (e.metaKey || e.ctrlKey) return
      handleKey(e.key, e.code)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!play) return null                       // parent gates on play; belt to its braces

  const vp = fill ? { width: win.w, height: win.h } : CONFIG.viewports[play.device] ?? Object.values(CONFIG.viewports)[0]
  const scale = fill ? 1 : Math.min(1, (win.w - 96) / vp.width, (win.h - 128) / vp.height)
  const names = Object.keys(CONFIG.viewports)
  const list = playList()
  const pos = list.indexOf(play.at)
  const variants = variantList()

  // whole-pixel wrapper + per-axis scale so the iframe lands exactly on its edges -
  // fractional sizes left subpixel seams glowing at the corners on dark frames
  const dw = Math.round(vp.width * scale)
  const dh = Math.round(vp.height * scale)
  const deviceHint = fill ? 'Fill window' : `${vp.width} × ${vp.height} · keys 1-${names.length + 1}`

  return (
    <div className={`sh-play${fill ? ' fill' : ''}`}>
      {/* device + comment overlay share ONE flex-centered box; the overlay is inset:0 over
          it (a sibling of the clipping .dev, so a thread card is never eaten by overflow) */}
      <div className="sh-play-stage" style={{ width: dw, height: dh }}>
        <div className="dev" data-theme={play.theme} style={{ width: dw, height: dh }}>
          <iframe
            ref={iframeRef}
            src={src.current}
            title="play"
            style={{ width: vp.width, height: vp.height, transform: `scale(${dw / vp.width}, ${dh / vp.height})` }}
          />
        </div>
        <PlayComments iframe={iframeRef} frameId={play.at} vp={vp} dw={dw} dh={dh} ready={stageReady} />
      </div>

      <nav className={`sh-pill sh-play-pill${pillOpen ? '' : ' closed'}`} aria-hidden={!pillOpen}>
        <BoardMenu current={board} />
        <i className="sep" />
        <CommentButton />
        <LaserButton />
        <i className="sep" />
        <DevicePicker value={fill ? 'fill' : play.device} onSelect={(n) => n && setDevice(n)} includeFill hint={deviceHint} dark />
        <ThemePicker value={play.theme} onSelect={setTheme} hint="D" dark />
        {playUpdateRevision && <>
          <i className="sep" />
          <Tip side="bottom" label={<><b>Update ready</b><span>an edit landed - reload this prototype</span></>}>
            <button className="sh-pill-btn sh-play-update" onClick={applyUpdate}><ReloadIcon size={13} /><span>Update</span></button>
          </Tip>
        </>}
        <i className="sep" />
        <HideUIButton />
        <Tip side="bottom" label={<><b>Collapse toolbar</b><span>H hides everything · ⌘/</span></>}>
          <button className="sh-pill-btn" onClick={() => setPillOpen(false)} tabIndex={pillOpen ? 0 : -1}>
            <PanelFilledIcon size={17} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </Tip>
        <Tip side="bottom" label={<><b>Exit Prototype view</b><span>Esc</span></>}>
          <button className="sh-pill-btn" onClick={exit}><XIcon size={14} /></button>
        </Tip>
      </nav>
      <Tip side="bottom" label={<><b>Open toolbar</b><span>⌘/</span></>}>
        <button className={`sh-pill-fab${pillOpen ? ' hidden' : ''}`} onClick={() => setPillOpen(true)}
          aria-hidden={pillOpen} tabIndex={pillOpen ? -1 : 0}><PanelHollowIcon size={18} style={{ transform: 'rotate(90deg)' }} /></button>
      </Tip>

      <div className="sh-play-nav">
        <Tip inv label={<><b>Restart</b><span className="k">R</span></>}>
          <button onClick={restart}><ReloadIcon size={14} /></button>
        </Tip>
        <i className="sep" />
        <Tip inv label={<><b>Previous frame</b><span className="k">←</span></>}>
          <button onClick={() => step(-1)}><ArrowLeftIcon size={14} /></button>
        </Tip>
        <span className="pos">{pos === -1 ? '·' : pos + 1}<em>/</em>{list.length}</span>
        <Tip inv label={<><b>Next frame</b><span className="k">→</span></>}>
          <button onClick={() => step(1)}><ArrowRightIcon size={14} /></button>
        </Tip>
        {variants.length > 1 && <>
          <i className="sep" />
          {variants.map((v) => (
            <Tip inv key={v.id} label={<><b>{v.title ?? v.id}</b><span className="k">[ ]</span></>}>
              <button className={`vchip${v.id === play.at ? ' on' : ''}`} onClick={() => goTo(v.id)}>
                {(v.variant ?? '?').toUpperCase()}
              </button>
            </Tip>
          ))}
          {(() => {
            // chips lead as the stable anchor; the name trails at natural width, so
            // a length change grows the pill rightward instead of shifting the chips
            const c = variants.find((v) => v.id === play.at)
            const full = c ? (c.title ?? (c.id.split('/').pop() ?? '').replace(/^[a-z]-/, '').replace(/-/g, ' ')) : ''
            return <Tip inv label={<b>{full}</b>}><span className="vname">{full}</span></Tip>
          })()}
        </>}
      </div>
    </div>
  )
}
