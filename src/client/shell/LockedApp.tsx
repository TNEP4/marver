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
import { useStore, landingBoard, landingMode, tabTitle } from './store.ts'
import { enterFocus, enterPlay, enterSlides, PlayOverlay, playCtl } from './Play.tsx'
import { UNPLACED, bootHash, parseHash, retargetBoot, writeHash } from './hash.ts'
import { isLegacyLink, landLegacy } from './legacy-links.ts'
import { useComments } from './comments-store.ts'
import { isLatest, navigated, switchFor } from './goto.ts'

/** App.tsx's headless-run probe (perf-run-probe.ts): a run's page is always a dev canvas, never a locked bundle. */
export function startPerfRunProbe(): void {}

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
/** A thread a link names: opened on the stage once the comments are on its board (a board's load
 *  closes the open thread, so never before - the effect below opens it after). */
let pendingThread: string | null = null
const openPending = () => {
  const c = useComments.getState()
  if (!pendingThread || c.board !== useStore.getState().board || !c.threads.some((t) => t.id === pendingThread)) return
  c.setActive(pendingThread)
  pendingThread = null
}

export function App() {
  const toasts = useStore((s) => s.toasts)
  const board = useStore((s) => s.board)

  /** The landing rule, enforced: the mode the lock pinned, entered on boot and
   *  re-entered if anything ever drops the overlay - there is no other surface. */
  const land = (at?: string) => {
    const s = useStore.getState()
    if (s.play) return
    const mode = landingMode(s.board)
    if (mode === 'focus') enterFocus(at)
    else if (mode === 'slides') enterSlides(at ? { at } : undefined)
    else enterPlay(at ? { at } : undefined)
  }

  useEffect(() => {
    if (booted) return
    booted = true
    const start = async () => {
      // an old All Scenes link: a real board, at the frame it names, with what to say about it
      let notice: string | null = null
      if (isLegacyLink(bootHash)) { const r = await landLegacy(bootHash); retargetBoot(r.hash); notice = r.notice }
      // the Not on a board view is dev's: a published canvas opens its default board instead
      if (bootHash.board === UNPLACED) retargetBoot({})
      if (bootHash.board && bootHash.board !== useStore.getState().board)
        useStore.setState({ board: bootHash.board, boardAuto: false })
      const ok = await boot()
      urlReady.current = true
      if (!ok) return
      if (bootHash.focus) enterFocus(bootHash.focus.at, { ...bootHash.focus, deep: true })
      else if (bootHash.play?.slides) enterSlides(bootHash.play)
      else if (bootHash.play) enterPlay(bootHash.play)
      else land(bootHash.f?.[0])
      if (notice) useStore.getState().toast(notice)
      if (bootHash.c) { pendingThread = bootHash.c; openPending() }
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
      // a lookup newer navigation overtook - a link, a goto, a step on the stage - is dropped
      const nav = navigated(), was = useStore.getState()
      const parsed = parseHash()
      const raw = parsed.board === UNPLACED ? {} : parsed   // dev's view, and what it names: not here
      // an old All Scenes link lands on a real board; it, and the bare #/, with no board: the landing one
      const r = isLegacyLink(raw) ? await landLegacy(raw) : { hash: raw, notice: null }
      const h = r.hash
      const board = h.board ?? (h.focus ? undefined : await landingBoard())
      const s = useStore.getState()
      if (!isLatest(nav) || s.board !== was.board || s.play?.at !== was.play?.at) return
      if (r.notice) s.toast(r.notice)
      if (h.c) pendingThread = h.c
      if (board && board !== s.board) {
        if (!await switchFor(board, nav)) return         // failed, or a newer navigation's board and stage by now
        useStore.getState().setPlay(null)                // the stage restarts on the board the link names, at its frame
        if (h.play?.slides) enterSlides(h.play)
        else if (h.play) enterPlay(h.play)
        else land(h.f?.[0])
        return
      }
      openPending()                                      // same board: its comments are here already
      if (h.f?.length && s.play) return playCtl.setAt(h.f[0])   // the stage on screen steps to the frame named
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
    void c.load(board).then(openPending)
    return c.live(board)
  }, [board])

  const titles = useStore((s) => s.boardTitles)
  useEffect(() => { document.title = tabTitle(board) }, [board, titles])

  return (
    <div tabIndex={-1} className="sh-app dark">
      <PlayOverlay />
      <div className="sh-toasts">{toasts.map((t) => <div className="sh-toast" key={t.id}>{t.text}</div>)}</div>
    </div>
  )
}
