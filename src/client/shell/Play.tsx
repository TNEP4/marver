/**
 * Play mode (SPEC-M2 §1): full-window near-black backdrop, ONE device shell centered at
 * the chosen viewport's exact CSS pixels, scaled to fit. The device hosts a single stage
 * iframe that swaps frames in place - the shell here owns chrome (device chips, theme,
 * close), sizing, and exit; the stage owns navigation and posts sh:stage-* messages.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore, CONFIG, type Node } from './store.ts'
import { ROUTE } from '../const.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { MoonIcon, SunIcon, XIcon, deviceIcon } from './icons.tsx'

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

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

/** Enter play on the current board: first selected node starts, else the first node. */
export function enterPlay() {
  const s = useStore.getState()
  const list = playList()
  if (!list.length) { s.toast('nothing to play on this board'); return }
  const selNode = s.selection.map((k) => s.nodes.find((n) => n.key === k)).find((n): n is Node => !!n && list.includes(n.frame))
  const node = selNode ?? s.nodes.find((n) => list.includes(n.frame))!
  const frame = s.frameFor(node)
  // device: the node's width names it; else the frame's declared viewport; else the first
  const names = Object.keys(CONFIG.viewports)
  const device = names.find((v) => CONFIG.viewports[v].width === node.w)
    ?? (frame?.viewport && CONFIG.viewports[frame.viewport] ? frame.viewport : names[0])
  s.setPlay({ at: node.frame, device, theme: node.theme })
}

export function PlayOverlay() {
  const play = useStore((s) => s.play)
  if (!play) return null
  return <PlayInner key="play" />
}

function PlayInner() {
  const play = useStore((s) => s.play)!
  const board = useStore((s) => s.board)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // the src is frozen at mount - navigation happens INSIDE the stage; device and theme
  // changes must never reload it (a phone does not remount when you flip dark mode)
  const src = useRef(`${ROUTE}/stage/?at=${encodeURIComponent(play.at)}&theme=${encodeURIComponent(play.theme)}`)
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [idle, setIdle] = useState(false)

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
    if (p && CONFIG.viewports[name]) useStore.getState().setPlay({ ...p, device: name })
  }
  const setTheme = (t: string) => {
    const p = useStore.getState().play
    if (!p) return
    useStore.getState().setPlay({ ...p, theme: t })
    postStage({ type: 'sh:set-theme', theme: t })
  }

  // messages from the stage; source-validated against our one iframe
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data
      if (!data || typeof data.type !== 'string') return
      const s = useStore.getState()
      if (data.type === 'sh:stage-ready') {
        postStage({ type: 'sh:stage-list', frames: playList() })
      } else if (data.type === 'sh:stage-at') {
        const p = s.play
        if (p && typeof data.at === 'string') s.setPlay({ ...p, at: data.at })
      } else if (data.type === 'sh:stage-exit') {
        exit()
      } else if (data.type === 'sh:stage-error') {
        s.toast(`play: ${String(data.message ?? 'frame error')}`)
      } else if (data.type === 'sh:stage-key') {
        handleKey(String(data.key), String(data.code))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // shared handler: keys arrive directly (focus in shell) or forwarded by the stage
  const handleKey = (key: string, code: string) => {
    if (key === 'Escape') { exit(); return }
    if (/^Digit[1-9]$/.test(code)) {
      const name = Object.keys(CONFIG.viewports)[Number(code.slice(5)) - 1]
      if (name) setDevice(name)
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

  // chrome auto-hides after 2.5 s of stillness; any movement brings it back
  useEffect(() => {
    let t = window.setTimeout(() => setIdle(true), 2500)
    const wake = () => { setIdle(false); window.clearTimeout(t); t = window.setTimeout(() => setIdle(true), 2500) }
    window.addEventListener('mousemove', wake)
    return () => { window.clearTimeout(t); window.removeEventListener('mousemove', wake) }
  }, [])

  const vp = CONFIG.viewports[play.device] ?? Object.values(CONFIG.viewports)[0]
  const scale = Math.min(1, (win.w - 96) / vp.width, (win.h - 128) / vp.height)

  return (
    <div className="sh-play">
      <div className="dev" style={{ width: vp.width * scale, height: vp.height * scale }}>
        <iframe
          ref={iframeRef}
          src={src.current}
          title="play"
          style={{ width: vp.width, height: vp.height, transform: `scale(${scale})` }}
        />
      </div>
      <div className={`sh-play-bar${idle ? ' idle' : ''}`}>
        <span className="bd">{board === 'all-scenes' ? 'All scenes' : cap(board)}</span>
        <i className="sep" />
        {Object.entries(CONFIG.viewports).map(([name, v], i) => (
          <button key={name} className={play.device === name ? 'on' : undefined}
            title={`${cap(name)} · ${v.width} × ${v.height} · ${i + 1}`} onClick={() => setDevice(name)}>
            {deviceIcon(name, 15)}
          </button>
        ))}
        <i className="sep" />
        {CONFIG.themes.map((t) => (
          <button key={t} className={play.theme === t ? 'on' : undefined} title={`${cap(t)} theme · D`} onClick={() => setTheme(t)}>
            {t === 'dark' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
          </button>
        ))}
        <i className="sep" />
        <button title="Exit play · Esc" onClick={exit}><XIcon size={14} /></button>
      </div>
    </div>
  )
}
