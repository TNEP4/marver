/**
 * Video - poster-first, glass-controlled, in EVERY kind of frame.
 *
 * At rest there is NO <video> element and no media fetch: the poster <img>
 * plus a play glyph IS the frame (lean-DOM safe - a <video> element would
 * pin the frame live). The real element mounts with the glass control strip
 * (play/pause, seekable progress, mute, fullscreen, auto-hiding) in two ways:
 *   - anywhere a frame is live (interact mode, play/present, focus, a
 *     published prototype): the poster is the play button - one click mounts
 *     the player and starts it, inside that gesture, so sound is allowed;
 *   - in slides mode (useSlidePlay): the player mounts on its own, the deck's
 *     entrance contract.
 * `autoplay` is the third shape - an ambient loop (muted, no strip) for a hero
 * or a product mockup; it mounts the element as soon as the frame is live,
 * which keeps that frame live on the canvas (the serializer marks <video>
 * degraded) - an explicit, per-video choice.
 * Leaving (play flips off / unmount) pauses everything.
 *
 * Sources: a design-asset path or a public https direct-file URL (mp4/webm;
 * HLS where the browser supports it natively). The poster is the frame at
 * rest: authored, or - omitted on a local clip - the generated
 * `<clip>.poster.png` beside it (server/poster.ts renders it; the primitive
 * asks the dev server once when the file is missing). `ratio` is the CSS aspect-ratio of the box
 * (default 16 / 9; "9 / 16" for a vertical clip inside a phone screen).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ROUTE } from '../const.ts'
import { assetUrl } from './md.ts'
import { useSlidePlay } from './slide.tsx'

const isRemote = (s: string) => /^https:\/\//.test(s)
const resolve = (s: string): string | null => (isRemote(s) ? s : assetUrl(s))
/** The generated poster's conventional name (server/poster.ts owns the rule). */
const posterNameFor = (src: string) => `${src}.poster.png`

// One generation request per clip per document: the dev server renders the poster from
// the clip's own first moments (server/poster.ts) and the <img> reloads. A published canvas
// has no such API (build already generated the file); a failed request just keeps the card.
const requested = new Map<string, Promise<boolean>>()
const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
// in-flight probes + generations, for the shot renderer's settle (like __mvLodBusy): a
// screenshot taken while a poster is still being rendered would show the empty box
let busy = 0
if (typeof window !== 'undefined') (window as { __mvPosterBusy?: () => number }).__mvPosterBusy = () => busy
const requestPoster = (src: string): Promise<boolean> => {
  let p = requested.get(src)
  if (!p) {
    p = (async () => {
      // the owner gate wants the double-submit cookie echoed; a frame host opened cold has not
      // made an API GET yet, so prime it with the cheapest one first
      if (!csrf()) await fetch(`${ROUTE}/api/policy`).catch(() => null)
      const r = await fetch(`${ROUTE}/api/poster?src=${encodeURIComponent(src)}`, { headers: { 'x-mv-c': csrf() } }).catch(() => null)
      return !!r?.ok
    })()
    requested.set(src, p)
    // a failure is not forever: the next mount (a fix, Chrome installed) may ask again
    void p.then((ok) => { if (!ok) requested.delete(src) })
  }
  return p
}

/** Is the human in the canvas's interact mode on this frame? The bridge mirrors sh:interactive
 *  on the document. Absent everywhere else (play, focus, published) - only the true->false
 *  transition matters: it disarms a playing clip when the mode is left. */
const subscribeInteractive = (cb: () => void) => {
  if (typeof document === 'undefined') return () => {}
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sh-interactive'] })
  return () => mo.disconnect()
}
const readInteractive = () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-sh-interactive')
const useInteractive = (): boolean => useSyncExternalStore(subscribeInteractive, readInteractive, () => false)

const VIDEO_CSS = `
.mv-video { position: relative; width: 100%; border-radius: 14px; overflow: hidden; background: #000; aspect-ratio: var(--mv-video-ratio, 16 / 9) }
.mv-video.armed { cursor: pointer }
.mv-video.armed:hover .glyph span { background: rgba(16, 16, 20, .75) }
.mv-video > img, .mv-video > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block }
.mv-video .glyph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none }
.mv-video .glyph span { width: 72px; height: 72px; border-radius: 999px; display: flex; align-items: center; justify-content: center;
  background: rgba(16, 16, 20, .55); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, .28) }
.mv-video .glyph svg { margin-left: 2px }
.mv-video .strip { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 999px; background: rgba(16, 16, 20, .55); backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, .22); color: #fff; opacity: 1; transition: opacity .25s }
.mv-video .strip.hidden { opacity: 0; pointer-events: none }
.mv-video .strip button { border: 0; background: none; color: #fff; cursor: pointer; display: flex; padding: 2px }
.mv-video .strip input[type=range] { flex: 1; accent-color: #fff; height: 3px; cursor: pointer }
.mv-video .strip .t { font: 500 12px/1 -apple-system, system-ui, sans-serif; opacity: .85; min-width: 34px }
`
let injected = false
const ensureCss = () => {
  if (injected || typeof document === 'undefined') return
  injected = true
  const el = document.createElement('style')
  el.setAttribute('data-mv-video', '')
  el.textContent = VIDEO_CSS
  document.head.appendChild(el)
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// Phosphor icons (play/pause in the fill weight, speaker and corners regular), path data
// inlined from @phosphor-icons/core - MIT (c) Phosphor Icons - the same way the shell's
// icons.tsx does it: no icon dependency reaches the host.
const P = ({ d, size }: { d: string; size: number }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="#fff" aria-hidden><path d={d} /></svg>
)
const PLAY = 'M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z'
const PAUSE = 'M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z'
const SPEAKER = 'M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z'
const SPEAKER_SLASH = 'M53.92,34.62A8,8,0,1,0,42.08,45.38L73.55,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V175.09l42.08,46.29a8,8,0,1,0,11.84-10.76ZM32,96H72v64H32ZM144,207.64,88,164.09V95.89l56,61.6Zm42-63.77a24,24,0,0,0,0-31.72,8,8,0,1,1,12-10.57,40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.59Zm-80.16-76a8,8,0,0,1,1.4-11.23l39.85-31A8,8,0,0,1,160,32v74.83a8,8,0,0,1-16,0V48.36l-26.94,21A8,8,0,0,1,105.84,67.91ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z'
const CORNERS = 'M216,48V88a8,8,0,0,1-16,0V56H168a8,8,0,0,1,0-16h40A8,8,0,0,1,216,48ZM88,200H56V168a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H88a8,8,0,0,0,0-16Zm120-40a8,8,0,0,0-8,8v32H168a8,8,0,0,0,0,16h40a8,8,0,0,0,8-8V168A8,8,0,0,0,208,160ZM88,40H48a8,8,0,0,0-8,8V88a8,8,0,0,0,16,0V56H88a8,8,0,0,0,0-16Z'
const PlayGlyph = ({ size = 30 }: { size?: number }) => <P d={PLAY} size={size} />
const PauseGlyph = ({ size = 18 }: { size?: number }) => <P d={PAUSE} size={size} />

export function Video({ src, poster, ratio, autoplay = false }: { src: string; poster?: string; ratio?: string; autoplay?: boolean }) {
  ensureCss()
  const play = useSlidePlay()
  const interactive = useInteractive()
  const [armed, setArmed] = useState(false)      // the poster was clicked in a live frame
  // leaving interact mode disarms: the clip pauses (Player unmounts) and the frame returns to
  // its poster, so the canvas can serialize it lean again
  useEffect(() => { if (!interactive) setArmed(false) }, [interactive])
  // poster omitted on a local clip: the generated one, by convention. `gen` walks
  // probing -> ready (the file exists, or was just rendered - reloaded with a cache-buster)
  // or failed (the card). The <img> mounts only once ready: no broken-image glyph while the
  // dev server renders the poster, and a shot taken meanwhile waits on __mvPosterBusy.
  const generated = !poster && !isRemote(src) ? posterNameFor(src) : null
  const [gen, setGen] = useState<'probing' | 'ready' | 'failed'>(generated ? 'probing' : 'ready')
  const [bust, setBust] = useState(0)
  const posterUrl = poster ? resolve(poster) : generated ? resolve(generated) : null
  const posterSrc = posterUrl && bust ? `${posterUrl}?v=${bust}` : posterUrl
  const srcUrl = resolve(src)
  const style = ratio ? ({ '--mv-video-ratio': ratio } as CSSProperties) : undefined
  useEffect(() => {
    if (!generated || !posterUrl) { setGen('ready'); return }
    let alive = true, pending = true
    setGen('probing'); setBust(0)
    busy++
    const done = () => { if (pending) { pending = false; busy-- } }
    const probe = new Image()
    const settle = (state: 'ready' | 'failed', rebust = false) => { done(); if (!alive) return; if (rebust) setBust(Date.now()); setGen(state) }
    probe.onload = () => settle('ready')
    probe.onerror = () => {
      // not there yet: ask the dev server to render it (once per clip per document)
      void requestPoster(src).then((ok) => settle(ok ? 'ready' : 'failed', ok))
    }
    probe.src = posterUrl
    return () => { alive = false; probe.onload = probe.onerror = null; done() }
  }, [generated, posterUrl, src])
  const bad = !srcUrl || (!isRemote(src) && !posterUrl) || gen === 'failed'
  if (bad) {
    return (
      <div className="mv-block mv-imgerr">
        <b>video unavailable</b>
        <span>{src}</span>
        <span className="dim">{!srcUrl ? 'must be a design/assets/ path or an https file URL' : `no poster - add poster="…", or put ${generated} beside the clip (the dev server renders it when Chrome is installed)`}</span>
      </div>
    )
  }
  // Ambient: a muted loop, no chrome - the author accepted that this frame stays live.
  if (autoplay) {
    return (
      <div className="mv-block mv-video" style={style}>
        <video src={srcUrl!} poster={gen === 'ready' ? posterSrc ?? undefined : undefined} autoPlay muted loop playsInline preload="auto" />
      </div>
    )
  }
  // AT REST: the poster and nothing else - no <video>, no fetch, still. In a lean cover the
  // click never fires (no script); in a live frame it arms the player inside the gesture.
  if (!play && !armed) {
    return (
      <div className="mv-block mv-video armed" style={style} role="button" aria-label="Play video" onClick={() => setArmed(true)}>
        {posterSrc && gen === 'ready' ? <img src={posterSrc} alt="" loading="lazy" /> : null}
        <div className="glyph"><span><PlayGlyph /></span></div>
      </div>
    )
  }
  return <Player src={srcUrl!} poster={gen === 'ready' ? posterSrc ?? undefined : undefined} style={style} autoStart={armed} />
}

/** The glass strip - deliberately four controls and a clock, nothing more. */
function Player({ src, poster, style, autoStart = false }: { src: string; poster?: string; style?: CSSProperties; autoStart?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const poke = () => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), 2200)
  }
  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); ref.current?.pause() }, [])
  // armed by a click on the poster: start now - still inside that gesture's activation
  useEffect(() => { if (autoStart) { void ref.current?.play().catch(() => {}); poke() } }, [autoStart])
  const toggle = () => { const v = ref.current; if (!v) return; if (v.paused) { void v.play(); poke() } else v.pause() }
  return (
    <div className="mv-block mv-video" style={style} onPointerMove={poke} onClick={(e) => { if (e.target === ref.current) toggle() }}>
      <video ref={ref} src={src} poster={poster} preload="metadata" muted={muted} playsInline
        onPlay={() => { setPlaying(true); poke() }} onPause={() => { setPlaying(false); setIdle(false) }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)} />
      {!playing && <div className="glyph"><span><PlayGlyph /></span></div>}
      <div className={`strip${playing && idle ? ' hidden' : ''}`}>
        <button aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? <PauseGlyph /> : <PlayGlyph size={18} />}</button>
        <span className="t">{fmt(t)}</span>
        <input type="range" min={0} max={dur || 0} step={0.1} value={t} aria-label="Seek"
          onChange={(e) => { const v = ref.current; if (v) { v.currentTime = Number(e.target.value); setT(v.currentTime) } }} />
        <span className="t">{fmt(dur)}</span>
        <button aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>
          <P d={muted ? SPEAKER_SLASH : SPEAKER} size={18} />
        </button>
        <button aria-label="Fullscreen" onClick={(e) => void (e.currentTarget.closest('.mv-video') as HTMLElement | null)?.requestFullscreen?.()}>
          <P d={CORNERS} size={18} />
        </button>
      </div>
    </div>
  )
}
