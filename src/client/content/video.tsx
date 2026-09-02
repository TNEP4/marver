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
 * Sources: a design-asset path (poster REQUIRED - it is the canvas
 * rendering) or a public https direct-file URL (mp4/webm; HLS where the
 * browser supports it natively). `ratio` is the CSS aspect-ratio of the box
 * (default 16 / 9; "9 / 16" for a vertical clip inside a phone screen).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
const requestPoster = (src: string): Promise<boolean> => {
  let p = requested.get(src)
  if (!p) {
    const csrf = /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
    p = fetch(`${ROUTE}/api/poster?src=${encodeURIComponent(src)}`, { headers: { 'x-mv-c': csrf } }).then((r) => r.ok, () => false)
    requested.set(src, p)
  }
  return p
}

const VIDEO_CSS = `
.mv-video { position: relative; width: 100%; border-radius: 14px; overflow: hidden; background: #000; aspect-ratio: var(--mv-video-ratio, 16 / 9) }
.mv-video.armed { cursor: pointer }
.mv-video.armed:hover .glyph span { background: rgba(16, 16, 20, .75) }
.mv-video > img, .mv-video > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block }
.mv-video .glyph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none }
.mv-video .glyph span { width: 72px; height: 72px; border-radius: 999px; display: flex; align-items: center; justify-content: center;
  background: rgba(16, 16, 20, .55); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, .28) }
.mv-video .glyph svg { margin-left: 4px }
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

const PlayGlyph = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5 19 12 8 18.5 Z" /></svg>
)
const PauseGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
)

export function Video({ src, poster, ratio, autoplay = false }: { src: string; poster?: string; ratio?: string; autoplay?: boolean }) {
  ensureCss()
  const play = useSlidePlay()
  const [armed, setArmed] = useState(false)      // the poster was clicked in a live frame
  // poster omitted on a local clip: the generated one, by convention; `gen` walks
  // missing -> requested -> ready (reload with a cache-buster) or failed (the card)
  const generated = !poster && !isRemote(src) ? posterNameFor(src) : null
  const [gen, setGen] = useState<'idle' | 'ready' | 'failed'>('idle')
  const posterUrl = poster ? resolve(poster) : generated ? resolve(generated) : null
  const posterSrc = posterUrl && generated && gen === 'ready' ? `${posterUrl}?v=${Date.now()}` : posterUrl
  const srcUrl = resolve(src)
  const style = ratio ? ({ '--mv-video-ratio': ratio } as CSSProperties) : undefined
  const onPosterError = () => {
    if (!generated || gen !== 'idle') return
    void requestPoster(src).then((ok) => setGen(ok ? 'ready' : 'failed'))
  }
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
        <video src={srcUrl!} poster={posterSrc ?? undefined} autoPlay muted loop playsInline preload="auto" />
      </div>
    )
  }
  // AT REST: the poster and nothing else - no <video>, no fetch, still. In a lean cover the
  // click never fires (no script); in a live frame it arms the player inside the gesture.
  if (!play && !armed) {
    return (
      <div className="mv-block mv-video armed" style={style} role="button" aria-label="Play video" onClick={() => setArmed(true)}>
        {posterSrc ? <img src={posterSrc} alt="" loading="lazy" onError={onPosterError} /> : null}
        <div className="glyph"><span><PlayGlyph /></span></div>
      </div>
    )
  }
  return <Player src={srcUrl!} poster={posterSrc ?? undefined} style={style} autoStart={armed} />
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
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5 6 9 H3 v6 h3 l5 4 Z" fill="#fff" stroke="none" />
            {muted ? <path d="m16 9 6 6 M22 9 l-6 6" /> : <path d="M15.5 8.5 a5 5 0 0 1 0 7 M18.5 6 a9 9 0 0 1 0 12" />}
          </svg>
        </button>
        <button aria-label="Fullscreen" onClick={(e) => void (e.currentTarget.closest('.mv-video') as HTMLElement | null)?.requestFullscreen?.()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3 H4 a1 1 0 0 0 -1 1 v4 M16 3 h4 a1 1 0 0 1 1 1 v4 M8 21 H4 a1 1 0 0 1 -1 -1 v-4 M16 21 h4 a1 1 0 0 0 1 -1 v-4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
