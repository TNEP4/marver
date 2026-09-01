/**
 * The locked-shell entry (01-sharing §5.1's all-boards rule) - what a bundle
 * whose every published board is locked to a stage mode boots into INSTEAD of
 * the canvas shell. The build swaps this module in for App.tsx, so the canvas
 * surface (sidebar, board grid, toolbar) is not hidden - its code never enters
 * the bundle. Publish-to-web, as an artifact rather than a flag.
 *
 * What remains is exactly the locked surface: boot, the landing rule, the play
 * or focus overlay (whose lock already refuses every exit), and deep links
 * within what the lock allows.
 */
import { Component, useEffect, useRef, type ReactNode } from 'react'
import { useStore, boardLabel, landingMode } from './store.ts'
import { enterFocus, enterPlay, enterSlides, PlayOverlay, playCtl } from './Play.tsx'
import { bootHash, parseHash, writeHash } from './hash.ts'
import { useComments } from './comments-store.ts'

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

let booted = false

export function App() {
  const toasts = useStore((s) => s.toasts)
  const board = useStore((s) => s.board)

  /** The landing rule, enforced: the mode the lock pinned, entered on boot and
   *  re-entered if anything ever drops the overlay - there is no other surface. */
  const land = () => {
    const s = useStore.getState()
    if (s.play) return
    const mode = landingMode(s.board)
    if (mode === 'focus') enterFocus()
    else if (mode === 'slides') enterSlides()
    else enterPlay()
  }

  useEffect(() => {
    if (booted) return
    booted = true
    const start = async () => {
      if (bootHash.board && bootHash.board !== useStore.getState().board)
        useStore.setState({ board: bootHash.board, boardAuto: false })
      const ok = await boot()
      urlReady.current = true
      if (!ok) return
      if (bootHash.focus) enterFocus(bootHash.focus.at, { ...bootHash.focus, deep: true })
      else if (bootHash.play?.slides) enterSlides(bootHash.play)
      else if (bootHash.play) enterPlay(bootHash.play)
      else land()
    }
    const boot = useStore.getState().boot
    void start()
  }, [])

  // the overlay IS the surface: if it ever closes, land again
  const play = useStore((s) => s.play)
  useEffect(() => { if (!play) setTimeout(land, 30) }, [play])

  // the URL projection, minimal: stage state only (there is no selection here)
  const urlReady = useRef(false)
  useEffect(() => {
    if (!urlReady.current || !play) return
    if (play.focus && play.deep) writeHash({ focus: { at: play.at, device: play.device, theme: play.theme } })
    else if (!play.focus) writeHash({ board: useStore.getState().board, play })
  })

  // back/forward + pasted links, within what the lock allows
  useEffect(() => {
    const onPop = async () => {
      const h = parseHash()
      const s = useStore.getState()
      if (h.board && h.board !== s.board) {
        await s.switchBoard(h.board)
        land()
        return
      }
      if (h.focus) enterFocus(h.focus.at, { ...h.focus, deep: true })
      // sync only holds WITHIN a mode: same-mode restores drive the MOUNTED
      // stage (sh:stage-set); crossing present↔slides re-enters and remounts
      else if (h.play && s.play && !!h.play.slides === !!s.play.slides) playCtl.sync(h.play)
      else if (h.play?.slides) enterSlides(h.play)
      else if (h.play) enterPlay(h.play)
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop) }
  }, [])

  // comment liveness for the stage overlay - same wiring the canvas shell does
  useEffect(() => {
    if (!board) return
    const c = useComments.getState()
    void c.load(board)
    return c.live(board)
  }, [board])

  useEffect(() => { document.title = board ? `${boardLabel(board)} - Marver` : 'Marver' }, [board])

  return (
    <div tabIndex={-1} className="sh-app dark">
      <PlayOverlay />
      <div className="sh-toasts">{toasts.map((t) => <div className="sh-toast" key={t.id}>{t.text}</div>)}</div>
    </div>
  )
}
