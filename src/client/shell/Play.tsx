/**
 * Play mode (SPEC-M2 §1): full-window near-black backdrop, ONE device shell centered at
 * the chosen viewport's exact CSS pixels, scaled to fit - or `fill`, where the frame IS
 * the window. The device hosts a single stage iframe that swaps frames in place.
 *
 * The shell owns everything except data-goto: chrome (top-right bar: board switcher,
 * devices + fill, theme, hide, exit), the bottom-left navigator (restart · prev · i/N ·
 * next), walk order, sizing, and the URL. Chrome auto-hides when idle and can be hidden
 * outright (H); hovering the top-right or bottom-left corner always reveals it - in fill
 * mode the stage reports those hovers, since the iframe covers the window.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore, CONFIG, boardLabel, cap, fetchBoardNames, type Node } from './store.ts'
import { ROUTE } from '../const.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { ArrowLeftIcon, ArrowRightIcon, CaretIcon, CheckIcon, FrameCornersIcon, MoonIcon, ReloadIcon, SunIcon, XIcon, deviceIcon } from './icons.tsx'

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
    ?? node?.theme ?? frame?.theme ?? CONFIG.themes[0] ?? 'light'
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
export const playCtl = { setAt: (_at: string) => {} }

export function PlayOverlay() {
  const play = useStore((s) => s.play)
  const board = useStore((s) => s.board)
  if (!play) return null
  return <PlayInner key={board} />
}

/** Board switcher dropdown in the play bar. */
function BoardMenu({ current }: { current: string }) {
  const [open, setOpen] = useState(false)
  const [names, setNames] = useState<string[]>([current])
  const boxRef = useRef<HTMLDivElement>(null)
  // refreshed on every open - agents create boards while you present
  useEffect(() => { if (open) fetchBoardNames().then(setNames).catch(() => {}) }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as globalThis.Node)) setOpen(false) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  return (
    <div className="bd-wrap" ref={boxRef}>
      <button className="bd" title="Switch board" onClick={() => setOpen(!open)}>
        {boardLabel(current)}
        <CaretIcon size={10} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="sh-play-menu">
          {names.map((n) => (
            <button key={n} onClick={() => { setOpen(false); switchPlayBoard(n) }}>
              <span>{boardLabel(n)}</span>
              {n === current && <CheckIcon size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PlayInner() {
  const play = useStore((s) => s.play)
  const board = useStore((s) => s.board)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // the src is frozen at mount - navigation happens INSIDE the stage; device and theme
  // changes must never reload it (a phone does not remount when you flip dark mode)
  const src = useRef(play ? `${ROUTE}/stage/?at=${encodeURIComponent(play.at)}&theme=${encodeURIComponent(play.theme)}` : '')
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [idle, setIdle] = useState(false)
  const [hidden, setHidden] = useState(false)      // H - sticky until toggled back
  const [corner, setCorner] = useState(false)      // hovering a reveal corner always shows chrome

  const postStage = (msg: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage(msg, '*')

  const exit = () => {
    const { at } = useStore.getState().play ?? {}
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

  // history restores + walk: swap the stage silently (no sh:stage-at back) and track here
  useEffect(() => {
    playCtl.setAt = (at: string) => {
      postStage({ type: 'sh:stage-set', at })
      const p = useStore.getState().play
      if (p && p.at !== at) useStore.getState().setPlay({ ...p, at })
    }
    return () => { playCtl.setAt = () => {} }
  }, [])

  // messages from the stage; source-validated against our one iframe
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data
      if (!data || typeof data.type !== 'string') return
      const s = useStore.getState()
      if (data.type === 'sh:stage-ready') {
        // an iframe reload (registry HMR invalidation) boots at the frozen initial src -
        // resync it to the shell's current truth so navigation and theme survive reloads
        const p = s.play
        if (p) {
          if (typeof data.at === 'string' && data.at !== p.at) postStage({ type: 'sh:stage-set', at: p.at })
          postStage({ type: 'sh:set-theme', theme: p.theme })
        }
      } else if (data.type === 'sh:stage-at') {
        const p = s.play
        if (p && typeof data.at === 'string') s.setPlay({ ...p, at: data.at })
      } else if (data.type === 'sh:stage-exit') {
        exit()
      } else if (data.type === 'sh:stage-error') {
        s.toast(`play: ${String(data.message ?? 'frame error')}`)
      } else if (data.type === 'sh:stage-key') {
        handleKey(String(data.key), String(data.code))
      } else if (data.type === 'sh:stage-edge') {
        // corner hovers inside the iframe matter only in fill, where it covers the window
        if (s.play?.device === 'fill') setCorner(!!data.hot)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // shared handler: keys arrive directly (focus in shell) or forwarded by the stage
  const handleKey = (key: string, code: string) => {
    if (key === 'Escape') { exit(); return }
    if (key === 'ArrowRight') { step(1); return }
    if (key === 'ArrowLeft') { step(-1); return }
    if (key === 'r') { restart(); return }
    if (key === 'h') { setHidden((h) => !h); return }
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
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

  // chrome auto-hides after 2.5 s of stillness; movement or a tap brings it back, and
  // hovering the top-right / bottom-left corner reveals it even when hidden with H.
  // Coarse pointers (touch) never idle - there is no hover to wake a hidden bar with,
  // and an unreachable close button would trap the viewer in play mode.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const hot = (e.clientX > window.innerWidth - 220 && e.clientY < 90)
        || (e.clientX < 220 && e.clientY > window.innerHeight - 90)
      setCorner(hot)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])
  useEffect(() => {
    if (window.matchMedia('(pointer: coarse)').matches) return
    let t = window.setTimeout(() => setIdle(true), 2500)
    const wake = () => { setIdle(false); window.clearTimeout(t); t = window.setTimeout(() => setIdle(true), 2500) }
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    return () => { window.clearTimeout(t); window.removeEventListener('pointermove', wake); window.removeEventListener('pointerdown', wake) }
  }, [])

  if (!play) return null                       // parent gates on play; belt to its braces

  const fill = play.device === 'fill'
  const vp = fill ? { width: win.w, height: win.h } : CONFIG.viewports[play.device] ?? Object.values(CONFIG.viewports)[0]
  const scale = fill ? 1 : Math.min(1, (win.w - 96) / vp.width, (win.h - 128) / vp.height)
  const chromeOff = (idle || hidden) && !corner
  const names = Object.keys(CONFIG.viewports)
  const list = playList()
  const pos = list.indexOf(play.at)

  return (
    <div className={`sh-play${fill ? ' fill' : ''}`}>
      <div className="dev" style={{ width: vp.width * scale, height: vp.height * scale }}>
        <iframe
          ref={iframeRef}
          src={src.current}
          title="play"
          style={{ width: vp.width, height: vp.height, transform: `scale(${scale})` }}
        />
      </div>

      <div className={`sh-play-bar${chromeOff ? ' idle' : ''}`}>
        <BoardMenu current={board} />
        <i className="sep" />
        {Object.entries(CONFIG.viewports).map(([name, v], i) => (
          <button key={name} className={play.device === name ? 'on' : undefined}
            title={`${cap(name)} · ${v.width} × ${v.height} · ${i + 1}`} onClick={() => setDevice(name)}>
            {deviceIcon(name, 15)}
          </button>
        ))}
        <button className={fill ? 'on' : undefined} title={`Fill window · ${names.length + 1}`} onClick={() => setDevice('fill')}>
          <FrameCornersIcon size={15} />
        </button>
        <i className="sep" />
        {CONFIG.themes.map((t) => (
          <button key={t} className={play.theme === t ? 'on' : undefined} title={`${cap(t)} theme · D`} onClick={() => setTheme(t)}>
            {t === 'dark' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
          </button>
        ))}
        <i className="sep" />
        <button title={hidden ? 'Show controls · H' : 'Hide controls · H'} onClick={() => setHidden(!hidden)}>
          <CaretIcon size={13} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button title="Exit play · Esc" onClick={exit}><XIcon size={14} /></button>
      </div>

      <div className={`sh-play-nav${chromeOff ? ' idle' : ''}`}>
        <button title="Restart · R" onClick={restart}><ReloadIcon size={14} /></button>
        <i className="sep" />
        <button title="Previous frame · ←" onClick={() => step(-1)}><ArrowLeftIcon size={14} /></button>
        <span className="pos">{pos === -1 ? '·' : pos + 1}<em>/</em>{list.length}</span>
        <button title="Next frame · →" onClick={() => step(1)}><ArrowRightIcon size={14} /></button>
      </div>
    </div>
  )
}
