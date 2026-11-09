import { frameReady, onFrameMessage, recordCopy } from './jam-capture.ts'
import { jamKey } from './jam-keys.ts'
import { letGoOfTile } from './jam-state.ts'
import { JamSurface, useLaneLift } from './JamSurface.tsx'
import { JamButton } from './jam-session.tsx'
import { useJamCapture } from './jam-capture.ts'
import { useJamQueue } from './jam-queue.ts'
import { Component, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useStore, BOARD_GONE, CONFIG, CANVAS_NAME, DISK_WON, LOCKED_SHELL, PUBLISHED, SOURCE_REVEALED, stoppedFor, logReload, takeReloadCause, addToBoard, boardLabel, cap, humanize, fetchBoardNames, landingBoard, tabTitle, hydrateBoardPolicy, landingMode, playsAsSlides, sceneLabel, switchCount, type FrameEntry } from './store.ts'
import { AddToBoard, BoardList } from './BoardList.tsx'
import { ContextMenu, copyToClipboard, framePath, useContextMenu, type MenuItem } from './ContextMenu.tsx'
import { TOP } from './inset.ts'
// a headless run's probe (main.tsx): canvas code, so it comes through this module, never into a locked bundle
export { startPerfRunProbe } from './perf-run-probe.ts'
import { Tip } from './Tip.tsx'
import { PKG, ROUTE } from '../const.ts'
import { api, resumed, scoped, useLink } from './api.ts'
import { animateLayout, Canvas, canvasCtl } from './canvas/Canvas.tsx'
import { bootCancelled } from './canvas/ctl.ts'
import { frameByWindow, fromLiveDocument } from './canvas/frame-registry.ts'
import { recorder } from './recorder.ts'
import { perfSeams } from './recorder-seams.ts'
import { takeNavToken } from './recorder-reloads.ts'
import { cmd, endAfterFrames, endOnCamera, endOnLoad, endOnStage, foldsIntoSave, keysOf, shellReload, type CmdHandle, type CmdOpts } from './commands.ts'
import { enterFocus, enterPlay, enterSlides, playCtl, PlayOverlay } from './Play.tsx'
import { PdfNotice } from './pdf-export.tsx'
import { bootHash, linkTargets, parseHash, retargetBoot, UNPLACED, writeHash } from './hash.ts'
import { isLegacyLink, landLegacy } from './legacy-links.ts'
import { CaretIcon, CheckIcon, CheckSquareOffsetIcon, ColumnsIcon, FrameRectIcon, ImagesSquareIcon, IntentGlyph, MoonIcon, PanelFilledIcon, PanelHollowIcon, ParallelogramDuoIcon, ParallelogramFillIcon, PencilSimpleIcon, PlayIcon, PlusIcon, SignpostIcon, SlideFrameIcon, SunIcon, VariantsIcon, XIcon } from './icons.tsx'
import { deviceIcon, deviceLabel } from './devices.tsx'
import { ALL_SCENES, humanize as slugLabel, readTitle } from '../../shared/board-tree.ts'
import { cardSelectAll, CommentsController, parkThread, revealThread } from './Comments.tsx'
import { poweredByUrl } from '../../shared/utm.ts'
import { avatarFallback, NO_COMMENTS_HERE, useComments } from './comments-store.ts'
import { goTo, isLatest, navigated, navigatedByHand, navNow, revealFrame, switchFor } from './goto.ts'
import { bootSettled, dismissShow, goNow, showTarget, useShowNotice } from './show.ts'
import { newerVersion } from '../../shared/deep-link.ts'
import { useNotes } from './notes.ts'
import { contentOnly } from '../../shared/frames.ts'
import { nextToLook } from '../../shared/marks.ts'
import { asksNow, Bubble, MarkedRow, markSeenFrom, resolveAllFrom, useRollup, useSeenOnScreen } from './marks-ui.tsx'
import { CommentButton, DevicePicker, HideUIButton, LaserButton, Popover, ThemePicker, toggleHideUI, usePopover } from './Toolbar.tsx'

const commentsStore = () => useComments.getState()

let booted = false                             // survives Fast Refresh; see the boot effect

/** One collapsible scene group in the sidebar. `held` marks a scene that contains a
 *  selected frame - a quiet secondary wash so ancestry survives collapsing the group.
 *  `renaming` swaps the label for an input: the scene's TITLE (its brief's front matter) -
 *  the directory never moves from here. */
function SceneGroup({ name, label, count, held, renaming, onRename, onPick, onContextMenu, ids, children }: { name: string; label: string; count: number; held: boolean; renaming?: boolean; onRename?: (title: string | null, h: CmdHandle) => void; onPick?: () => void; onContextMenu?: (e: ReactMouseEvent) => void; ids: string[]; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  const fold = useRollup(open ? [] : ids)   // only a folded scene rolls up (spec 25)
  const done = useRef(false)   // Enter then blur: one commit
  if (renaming) { done.current = false }
  // the rename's command starts where it is decided: Enter or leaving the field saves, Esc backs out (spec 30)
  const finish = (v: string | null, how: CmdOpts) => { if (done.current) return; done.current = true; onRename?.(v, cmd('scene-rename', how)) }
  return (
    <div>
      {renaming ? (
        <div className="it editing">
          <CaretIcon size={11} className="tw" style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
          <input autoFocus defaultValue={label} spellCheck={false} onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value, { via: 'key', in: 'shell', keys: keysOf(e) }) } else if (e.key === 'Escape') { e.preventDefault(); finish(null, { via: 'key', in: 'shell', keys: keysOf(e) }) } }}
            onBlur={(e) => finish(e.currentTarget.value, { via: 'click', in: 'shell' })} />
        </div>
      ) : (
        <button className={`it${held ? ' held' : ''}`} onClick={() => { cmd('scene-toggle', { via: 'click', in: 'shell' }); setOpen(!open) }} onContextMenu={onContextMenu}>
          <CaretIcon size={11} className="tw" style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
          {/* the NAME selects every frame in the scene; the caret/row still collapses */}
          <span onClick={(e) => { if (!onPick) return; e.stopPropagation(); onPick() }}>{label || '(root)'}</span>
          {/* folded, its one slot rolls the frames up (spec 25): a question first, else a blue count */}
          {fold.asks ? <Bubble n={fold.asks} /> : <small className={fold.fresh ? 'mk-fresh' : undefined}>{count}</small>}
        </button>
      )}
      {open && children}
    </div>
  )
}

/** A shell bug shows a banner, never a white screen. */
export class ShellBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  // the recorder's (spec 28 A1.7): the error, and the component it came from
  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    recorder.error({ source: 'shell', message: err.message, stack: err.stack, component: /\bat (\w+)/.exec(info.componentStack ?? '')?.[1] })
  }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div style={{ fontFamily: 'ui-monospace, monospace', padding: 32 }}>
        <b style={{ color: '#a81f16' }}>shell crashed</b>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.err.message}</pre>
        <button onClick={() => { shellReload(cmd('shell-reload', { via: 'click', in: 'shell' })); location.reload() }}>reload</button>
      </div>
    )
  }
}

/** Selection toolbar: screen-space overlay above the selected frame - constant size at any
 *  zoom. Position derives from --sh-s/tx/ty (written per transform frame in Canvas), so
 *  pan/zoom tracking is pure CSS with zero React re-renders. */
function SelectionBar() {
  const selection = useStore((s) => s.selection)
  const node = useStore((s) => s.nodes.find((n) => n.key === s.selection[s.selection.length - 1]))
  const frame = useStore((s) => (node ? s.frameFor(node) : undefined))
  const nodes = useStore((s) => s.nodes)
  // measured width feeds the viewport clamp below; a callback ref because the bar
  // mounts/unmounts with the selection (an effect with [] would miss remounts)
  const [barW, setBarW] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const barRef = (el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (el) {
      roRef.current = new ResizeObserver(() => setBarW(el.offsetWidth))
      roRef.current.observe(el)
    }
  }
  // the copy-path icon flashes into a check on a successful copy - from the icon OR the
  // Shift+P shortcut. pathPulse (store) bumps on each copy; these hooks sit ABOVE the
  // early return so their order never changes with the selection.
  const pathPulse = useStore((s) => s.pathPulse)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!pathPulse) return
    setCopied(true)
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [pathPulse])
  // copy-as-image: same flash contract (imagePulse bumps only on a real clipboard write),
  // plus a busy state for the 1-4s headless render - the icon dims and the button locks
  const imagePulse = useStore((s) => s.imagePulse)
  const imageBusy = useStore((s) => s.imageBusy)
  const [copiedImage, setCopiedImage] = useState(false)
  useEffect(() => {
    if (!imagePulse) return
    setCopiedImage(true)
    const t = setTimeout(() => setCopiedImage(false), 1400)
    return () => clearTimeout(t)
  }, [imagePulse])
  if (!node || !frame || node.missing) return null
  // anchor: centered over the bounding box of ALL selected frames, above the topmost
  const selNodes = nodes.filter((n) => selection.includes(n.key))
  const bx0 = Math.min(...selNodes.map((n) => n.x))
  const bx1 = Math.max(...selNodes.map((n) => n.x + n.w))
  const by0 = Math.min(...selNodes.map((n) => n.y))
  const { resizeSelected, toast } = useStore.getState()
  const multi = selection.length > 1
  const applyDevice = (name: string) => {
    foldsIntoSave(cmd('device', { via: 'click', in: 'shell', arg: name, frames: selection.length }))
    animateLayout()
    resizeSelected(name)
    setTimeout(() => canvasCtl.fitNodes(useStore.getState().selection), 30)
  }
  const setNodeTheme = (t: string) => { foldsIntoSave(cmd('theme', { via: 'click', in: 'shell', frames: selection.length })); useStore.getState().setSelectedTheme(t) }
  const selectedFrames = () => {
    const st = useStore.getState()
    return st.selection
      .map((k) => { const n = st.nodes.find((x) => x.key === k); return n ? st.frameFor(n) : undefined })
      .filter((f): f is NonNullable<typeof f> => !!f)
  }
  // centered over the selection's bounding box, then CLAMPED into the viewport: the
  // controls for a selected frame must stay reachable when its top edge is panned
  // off-screen, and must never drift off the sides (friction log #23)
  const centerX = `calc(var(--sh-tx, 0px) + var(--sh-s, 1) * ${(bx0 + bx1) / 2}px)`
  // a grouped frame carries a caption above it - clear it EXACTLY, in screen terms:
  // frame top - the caption offset (8px screen, world-capped) - the caption's height
  // (screen-clamped 12..18px font) - the bar. Gate on the TOP edge of the selection,
  // not the last-selected frame: a mixed selection whose topmost frames are variants
  // still has a caption to clear.
  const capAtTop = selNodes.some((n) => n.y === by0 && useStore.getState().frameFor(n)?.variantGroup)
  const rawTop = capAtTop
    ? `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${by0}px - clamp(4px * var(--sh-s, 1), 8px, 40px * var(--sh-s, 1)) - (clamp(12px, 17px * var(--sh-s, 1), 18px) * 1.4) - 44px)`
    : `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${by0}px - 52px)`
  return (
    <div
      className="sh-ctx"
      ref={barRef}
      style={{
        left: barW
          ? `clamp(8px, calc(${centerX} - ${Math.round(barW / 2)}px), calc(100vw - ${barW + 8}px))`
          : centerX,
        // below the Mac app's strip and its scroll edge when the shell took the inset (TOP 44: 52 px; else 8)
        top: `clamp(${TOP + 8}px, ${rawTop}, calc(100vh - 52px))`,
        transform: barW ? undefined : 'translateX(-50%)',
      }}
    >
      {multi && <>
        <Tip label={`${selection.length} frames selected`}><span className="cnt">{selection.length}</span></Tip>
        <i className="sep" />
      </>}
      {Object.entries(CONFIG.viewports).map(([name, vp], vi) => {
        const active = node.w === vp.width
        return (
          <Tip key={name} label={<><b>{deviceLabel(name)}</b><span>{vp.width} × {vp.height}</span><span className="k">{vi + 1}</span></>}>
            <button className={active ? 'on' : 'icon'} onClick={() => applyDevice(name)} aria-label={deviceLabel(name)}>
              {deviceIcon(name, 15)}{active && <span>{deviceLabel(name)}</span>}
            </button>
          </Tip>
        )
      })}
      <i className="sep" />
      {CONFIG.themes.map((t) => (
        <Tip key={t} label={`${cap(t)} theme`}>
          <button className={`icon${node.theme === t ? ' on' : ''}`} onClick={() => setNodeTheme(t)}>
            {t === 'dark' ? <MoonIcon size={15} /> : t === 'light' ? <SunIcon size={15} /> : t}
          </button>
        </Tip>
      ))}
      <i className="sep" />
      <Tip label={<><b>{multi ? `Copy ${selection.length} paths` : 'Copy path'}</b><span className="k">⇧P</span></>}>
        <button className="icon"
          onClick={() => {
            const h = cmd('copy-path', { via: 'click', in: 'shell', frames: selection.length })
            const brd = useStore.getState().board
            const text = selectedFrames().map((f) => framePath(brd, f)).join('\n')
            for (const f of selectedFrames()) recordCopy('path', f.id)
            navigator.clipboard.writeText(text).then(
              () => { h.done(); toast(multi ? `${selection.length} paths copied` : 'path copied'); useStore.getState().pulsePath() },
              () => { h.fail('clipboard-blocked'); toast('copy blocked - click the canvas first') })
          }}>{copied ? <CheckIcon size={15} /> : <SignpostIcon size={15} />}</button>
      </Tip>
      {/* copy as image: dev only (the renderer is the dev server's headless Chrome) and one
          frame at a time (a clipboard holds one image). I = 2x, Shift+I = 4x. */}
      {!PUBLISHED && (
        <Tip label={multi ? 'Select one frame to copy as image' : <><b>Copy as image</b><span className="k">⇧i</span></>}>
          <button className={`icon${imageBusy ? ' busy' : ''}`} disabled={multi || imageBusy} aria-label="Copy as image"
            data-state={copiedImage ? 'copied' : imageBusy ? 'busy' : 'idle'}
            onClick={(e) => useStore.getState().copyFrameImage(e.shiftKey ? 4 : 2, { via: 'click', in: 'shell' })}>
            {copiedImage ? <CheckIcon size={15} /> : <ImagesSquareIcon size={15} />}
          </button>
        </Tip>
      )}
    </div>
  )
}

/** Devices view: one click sizes frames to a device width, tidies, and fits. Scoped
 *  like the digit keys: the selection when one exists, the whole board otherwise. The
 *  dropdown chrome is the shared DevicePicker; this adapter owns the canvas wiring. */
function DeviceMenu() {
  const deviceView = useStore((s) => s.deviceView)
  const selection = useStore((s) => s.selection)
  const nodes = useStore((s) => s.nodes)
  const scoped = selection.length > 0
  const pick = (name: string | null) => {
    const st = useStore.getState()
    foldsIntoSave(cmd('device', { via: 'click', in: 'pill', arg: name ?? 'default', frames: st.selection.length }))
    animateLayout()
    if (scoped) {
      st.resizeSelected(name)
      setTimeout(() => canvasCtl.fitNodes(useStore.getState().selection), 30)
    } else {
      st.setDeviceView(name)
      setTimeout(() => canvasCtl.fitAll(), 30)
    }
  }
  const entries = Object.entries(CONFIG.viewports)
  // active check: board-wide it is the device view; scoped, the device every selected frame wears
  const selNodes = scoped ? nodes.filter((n) => selection.includes(n.key)) : []
  const active = scoped
    ? entries.find(([, vp]) => selNodes.length > 0 && selNodes.every((n) => n.w === vp.width))?.[0] ?? null
    : deviceView
  const hint = scoped ? `${selection.length} selected` : deviceView ? deviceLabel(deviceView) : `keys 1-${entries.length}`
  return <DevicePicker value={active} onSelect={pick} includeDefault hint={hint} />
}

/** Update pill (dev only): the daily registry check surfaces here - same glass, same
 *  pill, bottom-center. Click the command to copy it; × dismisses THIS version for
 *  good (localStorage), so the pill returns only when the next release lands. */
function UpdatePill() {
  const [latest, setLatest] = useState<string | null>(null)
  const play = useStore((s) => s.play)
  useEffect(() => {
    if (PUBLISHED) return                     // a shared canvas never nags its viewers
    api('update')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        // spec 31 E4: the endpoint answers whatever the registry said - the pill only for a strictly newer release
        if (u?.latest && newerVersion(u.latest, u.current) && localStorage.getItem(scoped('mv-update-seen')) !== u.latest) setLatest(u.latest)
      })
      .catch(() => { /* dev server gone or endpoint absent - stay quiet */ })
  }, [])
  if (!latest || play) return null
  // init rides along so managed files (AGENTS.md, instructions/) refresh with the code
  const command = `npm i -D ${PKG}@latest && npx marver init`
  const dismiss = () => {
    cmd('update-dismiss', { via: 'click', in: 'shell' })
    try { localStorage.setItem(scoped('mv-update-seen'), latest) } catch { /* storage unavailable */ }
    setLatest(null)
  }
  return (
    <div className="sh-update">
      <span><b>{latest}</b> is out</span>
      <Tip side="top" label="Copy, then paste to your terminal or your agent">
        <button className="cmd" onClick={() => {
          const t = useStore.getState().toast
          const h = cmd('update-copy', { via: 'click', in: 'shell' })
          navigator.clipboard?.writeText(command).then(() => { h.done(); t('update command copied') }, () => { h.fail('clipboard-blocked'); t('copy blocked - select it manually') })
            ?? (h.fail('clipboard-blocked'), t('copy unavailable - select it manually'))
        }}><code>{command}</code></button>
      </Tip>
      <Tip side="top" label="Dismiss this version">
        <button className="x" onClick={dismiss}><XIcon size={13} /></button>
      </Tip>
    </div>
  )
}

/** `marver show` over unsent words (spec 31 D3): the tab did not move - Go moves it, × leaves it be. */
function ShowNotice() {
  const notice = useShowNotice((s) => s.notice)
  // in Play too: a draft typed there keeps the canvas where it is, and the notice says why (it sits over Play)
  if (!notice) return null
  return (
    <div className="sh-update sh-show-notice" role="status">
      <span>Your agent wants to show you <b>{notice.title}</b></span>
      <button className="cmd" onClick={() => { const h = cmd('show-go', { via: 'click', in: 'shell' }); void goNow().then((r) => { if (r !== 'shown') h.cancel() }) }}><code>Go</code></button>
      <Tip side="top" label="Stay here">
        <button className="x" onClick={() => { cmd('show-dismiss', { via: 'click', in: 'shell' }); dismissShow() }}><XIcon size={13} /></button>
      </Tip>
    </div>
  )
}

const ZOOMS = [2, 1.5, 1, 0.5, 0.25, 0.1]

/** Zoom preset dropdown on the percentage readout. */
function ZoomMenu() {
  const scale = useStore((s) => s.scale)
  const pop = usePopover()
  const go = (fn: () => void) => { fn(); pop.setOpen(false) }
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <Tip side="bottom" label="Zoom presets">
        <button className="sh-pill-btn pct" onClick={pop.toggle}>{Math.round(scale * 100)}%</button>
      </Tip>
      <Popover pop={pop}>
        {ZOOMS.map((z) => (
          <button key={z} onClick={() => go(() => { cmd('zoom-to', { via: 'click', in: 'pill' }); navigatedByHand(); canvasCtl.zoomTo(z) })}>
            <span>{z * 100}%</span>
            {z === 1 && <kbd>⇧0</kbd>}
            {Math.abs(scale - z) < 0.03 && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
        <i className="div" />
        <button onClick={() => go(() => { cmd('fit-all', { via: 'click', in: 'pill' }); navigatedByHand(); canvasCtl.fitAll() })}><span>Fit all</span><kbd>⇧1</kbd></button>
        <button onClick={() => go(() => { const h = cmd('fit-selection', { via: 'click', in: 'pill' }); const k = useStore.getState().selection; navigatedByHand(); if (k.length) canvasCtl.fitNodes(k); else h.noop('no-selection') })}>
          <span>Fit selection</span><kbd>⇧2</kbd>
        </button>
      </Popover>
    </div>
  )
}

/** Theme dropdown, scoped like the device digits: the selection when one exists, every
 *  frame otherwise. The trigger reflects the scope's MAJORITY (per-frame overrides never
 *  flip a board-level trigger - it reports the level it acts on, same rule as the shell).
 *  The dropdown chrome is the shared ThemePicker; this adapter owns the canvas wiring. */
function ThemeMenu() {
  const nodes = useStore((s) => s.nodes)
  const selection = useStore((s) => s.selection)
  const viewTheme = useStore((s) => s.viewTheme)
  const scoped = selection.length > 0
  const scope = scoped ? nodes.filter((n) => selection.includes(n.key)) : []
  const majority = scoped
    ? (scope.length ? [...scope.reduce((m, n) => m.set(n.theme, (m.get(n.theme) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0][0] : viewTheme)
    : viewTheme
  // the tick shows only a UNIFORM scope (mixed selection = no theme is "the" one), while
  // the trigger reports the majority - the level the control acts on
  const uniform = scoped ? (scope.length && scope.every((n) => n.theme === scope[0].theme) ? scope[0].theme : null) : viewTheme
  const pick = (t: string) => {
    const st = useStore.getState()
    foldsIntoSave(cmd('theme', { via: 'click', in: 'pill', frames: st.selection.length || undefined }))
    scoped ? st.setSelectedTheme(t) : st.setTheme(t)
  }
  const hint = scoped ? `${selection.length} selected · D` : 'all frames · D'
  return <ThemePicker value={majority} checked={uniform} onSelect={pick} hint={hint} />
}

/** P and the pill's Prototype (spec 30): `play` or `slides` as the board plays; nothing to play is a noop. */
function enterPlayFrom(how: CmdOpts) {
  const slides = playsAsSlides(useStore.getState().board)
  const h = cmd(slides ? 'slides' : 'play', how)
  if (slides) enterSlides(); else enterPlay()
  if (!useStore.getState().play) h.noop('nothing-to-play')
}
/** T and the pill's Tidy (spec 30): `tidy` ends with the layout animation; a board already tidy moved nothing. */
function tidyFrom(how: CmdOpts) {
  const h = cmd('tidy', how)
  foldsIntoSave(h)
  const before = useStore.getState().nodes
  animateLayout()
  useStore.getState().runTidy()
  const after = useStore.getState().nodes
  const at = new Map(before.map((n) => [n.key, n]))
  if (after.every((n) => { const b = at.get(n.key); return b && b.x === n.x && b.y === n.y && b.w === n.w && b.h === n.h })) h.noop('nothing-moved')
}

export function App() {
  // B0.1: per-field selectors, NOT `useStore()` (which subscribes to the whole store and
  // re-rendered the entire shell on every setScale tick during a pan/zoom).
  useSeenOnScreen()
  const manifest = useStore((s) => s.manifest)
  const stopped = useLink((s) => s.shown)   // the canvas stopped (spec 28 A1.11): nothing leaves this page
  const nodes = useStore((s) => s.nodes)
  const panelOpen = useStore((s) => s.panelOpen)
  const laneLift = useLaneLift()
  // the collapsed toolbar keeps the dot - while a capture records, and for a whole Jam session
  const capturing = useJamCapture((st) => !!st.current)
  const inSession = useJamQueue((st) => !!st.session)
  const recording = capturing || inSession
  const toasts = useStore((s) => s.toasts)
  const selection = useStore((s) => s.selection)
  const laser = useStore((s) => s.laser)
  const commentMode = useComments((s) => s.commentMode)
  // Laser/comment paint live outlines + do element-picking INSIDE the live frame; a scriptless
  // lean cover would hide them, so a body class suppresses the cover while either mode is active.
  useEffect(() => { document.body.classList.toggle('sh-laser', laser) }, [laser])
  useEffect(() => { document.body.classList.toggle('sh-commenting', commentMode) }, [commentMode])
  const { boot, applyManifest, togglePanel, select, setInteract, toast, spawn } = useStore.getState()
  const [pillOpen, setPillOpen] = useState(true)
  const cm = useContextMenu()   // shared sidebar right-click menu (boards + scenes)
  const [sceneNaming, setSceneNaming] = useState<string | null>(null)   // the scene whose title is being edited inline

  // boot honors the deep link: board before load, play mode after it.
  // Selection + camera intent are restored by the Canvas boot effect. The module-level
  // guard makes boot single-shot: Fast Refresh re-runs mount effects on every App edit,
  // and a re-boot would revert live state to the long-consumed deep link.
  useEffect(() => {
    if (booted) return
    booted = true
    const start = async () => {
      if (!PUBLISHED) {
        // dev: hydrate board policy (slides/type/open) from the repo so P and
        // deep links preview exactly what viewers get
        try {
          const r = await api('policy')
          if (r.ok) hydrateBoardPolicy(((await r.json()) as { boards?: Record<string, never> }).boards ?? {})
        } catch { /* dev server without the route - fine */ }
      }
      // a link from before 0.25 names the All Scenes board: it lands on a real one (legacy-links.ts)
      let notice: string | null = null
      if (isLegacyLink(bootHash)) {
        const r = await landLegacy(bootHash)
        retargetBoot(r.hash)
        writeHash(r.hash)
        notice = r.notice
      }
      if (bootHash.board && !(PUBLISHED && bootHash.board === UNPLACED)) {   // the Not on a board view is dev's
        if (bootHash.board !== useStore.getState().board)   // a deep link wins
          useStore.setState({ board: bootHash.board, boardAuto: false })
      } else if (!PUBLISHED) {
        // fresh open, no deep link: LAND on the first board - with none yet, the Not on a board view
        const first = await landingBoard()
        if (first !== useStore.getState().board) useStore.setState({ board: first, boardAuto: false })
      }
      const ok = await boot()
      if (notice) toast(notice)
      // the page before this one reloaded itself when its canvas came back (A1.11): what its save came to - saved, or
      // the board's file won on disk, or the board was gone
      if (ok && resumed?.outcome === 'saved') toast('Back - your edits were saved')
      else if (resumed?.outcome === 'disk') toast(DISK_WON)
      else if (resumed?.outcome === 'gone') toast(BOARD_GONE)
      urlReady.current = true
      // a link naming frames on a board with NO nodes: the canvas's boot fit never runs (it waits
      // for the first frame) - follow the frame to where it lives from here, under the boot's own navigation
      if (ok && bootHash.f?.length && !bootHash.focus && !useStore.getState().nodes.length) void revealFrame(bootHash.f[0], navNow(), () => !bootCancelled())
      if (ok && bootHash.focus) {
        // a frame deep link forces focus for that visit, over every other rule
        // (01-sharing §6.1 step 3) - the stage mounts any manifest frame, so no
        // board lookup is needed
        enterFocus(bootHash.focus.at, { ...bootHash.focus, deep: true })
      } else if (ok && bootHash.play?.slides) enterSlides(bootHash.play)
      else if (ok && bootHash.play) enterPlay(bootHash.play)     // #/p/<board> alone = board start
      else if (ok && PUBLISHED) {
        // published landing: explicit `open` beats the type default; canvas and
        // board land on the canvas surface (board-scoped already); a lock will
        // then hold the mode by hiding every door (04-solution §2.35)
        const mode = landingMode(useStore.getState().board)
        if (mode === 'present') enterPlay()
        else if (mode === 'focus') enterFocus()
        else if (mode === 'slides') enterSlides()
      }
      // a show that came during the boot applies once it settled - loaded or failed, its mode (focus, play, slides)
      // entered first, so nothing of the boot lands after it (spec 31 D3)
      bootSettled(ok)
    }
    void start()
  }, [])

  // the URL is a projection of state: design views replace in place; entering play and
  // every in-play navigation push, so browser back walks the flow
  const playState = useStore((s) => s.play)
  const prevPlay = useRef(playState)
  const urlReady = useRef(false)               // never clobber a deep link before boot restores it
  useEffect(() => {
    if (!urlReady.current) return
    const s = useStore.getState()
    if (playState?.focus && playState.deep) {
      // a deep-link focus visit keeps its frame URL - the shareable form
      writeHash({ focus: { at: playState.at, device: playState.device, theme: playState.theme } })
    } else if (playState && !playState.focus) {
      const push = !prevPlay.current || prevPlay.current.at !== playState.at
      writeHash({ board: s.board, play: playState }, push)
    } else {
      // type-default focus keeps the board URL the visitor arrived on
      writeHash({ board: s.board, n: playState ? [] : s.selection })
    }
    prevPlay.current = playState
  })

  // browser back/forward: re-apply the URL as a whole - board first, then play or
  // selection against the newly loaded state. writeHash skips identical hashes, so
  // restores never echo back into history.
  useEffect(() => {
    // the switch a navigation started, while it may still run: back/forward, a pasted link and `location.hash =` each
    // fire popstate AND hashchange, and a second switch to the same board would supersede the first - a second board
    // fetch, and a load that never committed in perf --loads
    let routing: { hash: string; switches: number } | null = null
    // the recorder's (spec 30): back/forward fires both events, a same-board one with no switch to tell them apart
    let recorded: { hash: string; at: number; h: CmdHandle | null; run: number } = { hash: '', at: -1_000, h: null, run: 0 }
    const onPop = async () => {
      // the same hash, and no switch or cancel since this router started its own (a board picked, a goto, a newer
      // navigation): the second event of the navigation the first is carrying through - board, frame and view
      if (routing && routing.hash === location.hash && routing.switches === switchCount()) return
      const raw = location.hash
      // the second event carries the first's command on; the first, overtaken by its own twin, does not end it
      const again = raw === recorded.hash && performance.now() - recorded.at < 250
      const run = recorded.run + 1
      const nav_ = again ? recorded.h : cmd('history-nav', { via: 'click', in: 'shell' })
      recorded = { hash: raw, at: performance.now(), h: nav_, run }
      const giveUp = () => { if (recorded.run === run) nav_?.cancel('superseded') }
      const nav = navigated()                  // a reveal still looking up its board must not land after this
      // a lookup below still running when newer navigation lands - a link, a board picked, a step in play - is dropped
      const at = useStore.getState().board, step = useStore.getState().play?.at
      const overtaken = () => !isLatest(nav) || useStore.getState().board !== at || useStore.getState().play?.at !== step
      let h = parseHash()
      if (PUBLISHED && h.board === UNPLACED) h = {}   // the Not on a board view is dev's: published, the default board
      const legacy = isLegacyLink(h)
      if (legacy) {
        // an old All Scenes link pasted, or walked back to: where it lands now, written over it -
        // once, though back/forward fires two events
        const r = await landLegacy(h)
        const board = r.hash.board ?? await landingBoard()
        if (overtaken()) return giveUp()
        h = { ...r.hash, board }
        writeHash(h)
        if (r.notice) toast(r.notice)
      } else if (!h.board && !h.focus && !h.invite) {
        // the bare #/ opens the landing board
        const board = await landingBoard()
        if (overtaken()) return giveUp()
        h = { ...h, board }
      }
      let s = useStore.getState()
      if (h.board && h.board !== s.board) {
        if (s.play) s.setPlay(null)            // a stale overlay must never survive into another board
        if (nav_) endOnLoad(nav_, h.board)     // another board: its load's way ends it (#49)
        const switched = switchFor(h.board, nav)
        const mine = routing = { hash: raw, switches: switchCount() }
        const landed = await switched
        if (routing === mine) routing = null
        // the switch failed (the projection effect re-syncs the URL), or a newer navigation came while this one's board
        // was read - a link, a goto, a board picked - and may have landed on this same board first: the board is the
        // newer one's then, and so are the selection, the mode and the camera
        if (!landed) return giveUp()
        s = useStore.getState()
      }
      // the same board: where it leads ends it; another board's load already does
      const here = nav_ && h.board === at ? nav_ : null
      // the thread an old link names (Comments.tsx opens every other link's): now, or once the new board's comments load
      if (legacy && h.c) { if (s.board !== at) parkThread(h.c); else revealThread(h.c) }
      if (here) { if (h.focus || h.play) endOnStage(here, h.play?.at ?? h.focus?.at); else endOnCamera(here) }
      if (h.focus) {
        enterFocus(h.focus.at, { ...h.focus, deep: true })
      } else if (h.play) {
        // sync only holds WITHIN a mode: a slides hash over a present stage (or
        // the reverse) re-enters, which remounts the stage with the right src
        if (s.play && !!h.play.slides === !!s.play.slides) playCtl.sync(h.play)
        else if (h.play.slides) enterSlides(h.play)
        else enterPlay(h.play)
      } else {
        if (s.play) s.setPlay(null)
        const keys = linkTargets(h, s.nodes)
        useStore.setState({ selection: keys })
        s.look(keys)   // a link opened is a look
        if (!keys.length && h.f?.length) void revealFrame(h.f[0])   // not on this board - where it lives
        else setTimeout(() => { if (isLatest(nav)) (keys.length ? canvasCtl.fitNodes(keys) : canvasCtl.fitAll()) }, 60)   // unless a newer navigation has the camera
      }
    }
    // hashchange too: pasting a link into the same tab or editing the URL bar changes
    // the hash WITHOUT a popstate - ignoring it let the projection rewrite the URL back.
    // Our own writeHash never fires either event (history API), so there is no echo;
    // back/forward fires both: the second finds the first's switch on its way and leaves it
    // be (above) - without a switch, the handler is idempotent under the double call.
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop) }
  }, [])

  // page title follows the open board (and its title, when one is set)
  const board = useStore((s) => s.board)
  const titles = useStore((s) => s.boardTitles)
  // an empty Not on a board view (a canvas with no board and no frame yet) is no place to name in the tab
  const emptyView = useStore((s) => s.board === UNPLACED && !s.nodes.length)
  useEffect(() => { document.title = tabTitle(emptyView ? null : board) }, [board, titles, emptyView])

  // favicon follows the mode: blue pack in design mode, purple pack in interact.
  // The links are rebuilt (not toggled) so the set stays deterministic; the .ico is
  // design-blue only, so interact mode omits it and the browser takes the purple PNGs.
  const interactingIcon = useStore((s) => s.interact !== null)
  useEffect(() => {
    const sfx = interactingIcon ? '-interactive' : ''
    document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((l) => l.remove())
    const add = (rel: string, href: string, attrs: Record<string, string> = {}) => {
      const l = document.createElement('link')
      l.rel = rel
      l.href = href
      for (const [k, v] of Object.entries(attrs)) l.setAttribute(k, v)
      document.head.appendChild(l)
    }
    if (!interactingIcon) add('icon', `${ROUTE}/favicon/favicon.ico`, { sizes: '48x48' })
    add('icon', `${ROUTE}/favicon/favicon-32x32${sfx}.png`, { type: 'image/png', sizes: '32x32' })
    add('icon', `${ROUTE}/favicon/favicon-16x16${sfx}.png`, { type: 'image/png', sizes: '16x16' })
    add('apple-touch-icon', `${ROUTE}/favicon/apple-touch-icon${sfx}.png`)
  }, [interactingIcon])

  // focus rings appear ONLY during real Tab navigation: the browser flips into keyboard
  // modality on ANY keystroke, so a shortcut press painted the stock double ring on
  // whatever was last clicked. Tab arms body.sh-kbd; any pointer use disarms it.
  useEffect(() => {
    const arm = (e: KeyboardEvent) => { if (e.key === 'Tab') document.body.classList.add('sh-kbd') }
    const disarm = () => document.body.classList.remove('sh-kbd')
    window.addEventListener('keydown', arm, true)
    window.addEventListener('pointerdown', disarm, true)
    return () => { window.removeEventListener('keydown', arm, true); window.removeEventListener('pointerdown', disarm, true) }
  }, [])

  // browser pinch-zoom is disabled inside the app: a pinch over the chrome (or anywhere
  // off-canvas) was scaling the PAGE and wrecking the layout. Canvas zoom is unaffected
  // (rzpp handles its own events), and keyboard cmd +/- is never intercepted.
  useEffect(() => {
    const block = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }
    const blockGesture = (e: Event) => e.preventDefault()
    window.addEventListener('wheel', block, { passive: false })
    document.addEventListener('gesturestart', blockGesture)
    return () => {
      window.removeEventListener('wheel', block)
      document.removeEventListener('gesturestart', blockGesture)
    }
  }, [])

  // live updates from the dev server (source-served shell has import.meta.hot)
  useEffect(() => {
    if (!import.meta.hot) return
    import.meta.hot.on('sh:manifest', (m: any) => applyManifest(m))
    // `marver show` (spec 31 D3): the place an agent shows the human - moved to, or a notice over unsent words
    import.meta.hot.on('sh:show', (m: any) => { void showTarget(m, 'server') })
    // a brief's title or description changed with the frames intact: relabel, never re-key
    import.meta.hot.on('sh:scenes', (m: any) => useStore.getState().setScenes(m?.scenes))
    // Live Jam presence: the daemon broadcasts the set of frames Marver is editing.
    // Camera-safe by construction - this only toggles a glow class, never moves the view.
    import.meta.hot.on('sh:jam-activity', (m: any) => { useStore.getState().setWorkingFrom(m); void useStore.getState().syncMarks() })
    // then ask for what is lit now - a broadcast sent before this listener existed is gone - and again
    // after the dev server reconnects
    void useStore.getState().syncWorking()
    import.meta.hot.on('vite:ws:connect', () => void useStore.getState().syncWorking())
    // sidebar marks (spec 25): a frame changed on disk, or an agent's work started or ended
    void useStore.getState().syncMarks()
    logReload({ kind: 'shell-boot' })   // the reload log: every time the canvas page itself loads
    import.meta.hot.on('vite:ws:connect', () => void useStore.getState().syncMarks())
    import.meta.hot.on('sh:marks', () => void useStore.getState().syncMarks())
    import.meta.hot.on('sh:boards', () => void useStore.getState().syncMarks())   // a board's frames changed: its roll-up too
    // Live Jam reply delivery: the daemon just wrote to a board's log - fetch it NOW instead of
    // waiting out the 30s comment poll, so the reply + notification land within a second.
    import.meta.hot.on('sh:jam-comment', (m: any) => { if (typeof m?.board === 'string') useComments.getState().poke(m.board) })
    // the jam queue (spec 27): the status icon by each tag's time, and a failure's one notice
    import.meta.hot.on('sh:jam-queue', (m: any) => { void import('./jam-queue.ts').then(({ useJamQueue }) => useJamQueue.getState().apply(m)) })
    void import('./jam-queue.ts').then(({ useJamQueue }) => useJamQueue.getState().load())
    // captures sealed in an earlier page that never reached the server
    void import('./jam-capture.ts').then(({ resendSealed }) => resendSealed())
    // A7 controlled HMR: a frame file changed. Reload exactly the affected frames through the
    // lease-aware path (idle frames now, leased ones deferred to a safe point) - never a shell
    // reload, never a React Fast Refresh yanking a frame the user is in.
    import.meta.hot.on('sh:frame-invalidated', (m: any) => {
      const frameIds = Array.isArray(m?.frameIds) ? m.frameIds.filter((x: unknown) => typeof x === 'string') : []
      if (frameIds.length && typeof m?.revision === 'string') useStore.getState().invalidateFrames(frameIds, m.revision, { epoch: m?.epoch, docs: m?.docs })
    })
    // multi-viewer sync: another viewer (or an agent) saved this board. A clean canvas
    // re-boots silently, keeping whatever selection survives; a dirty one keeps its
    // edits and converges through the 409 path on its next save (disk wins).
    import.meta.hot.on('sh:board', (m: any) => {
      const s = useStore.getState()
      if (m?.name !== s.board || m?.sha256 === s.boardHash || s.dirty) return
      const sel = s.selection
      // who may have written it (spec 30 #18): what the dev server's write match found, never proven
      s.boot(undefined, 'disk', m?.writer ? { writer: m.writer, candidates: m.candidates } : undefined).then((ok) => {
        if (!ok) return
        const nodes = useStore.getState().nodes
        useStore.setState({ selection: sel.filter((k) => nodes.some((n) => n.key === k)) })
      })
    })
  }, [])

  // frame -> shell messages; source validated against known iframes
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data
      if (!data || typeof data.type !== 'string' || !data.type.startsWith('sh:')) return
      if (e.origin && e.origin !== location.origin) return   // a cross-origin-navigated frame keeps its WindowProxy; reject it
      // B0.3: O(1) registry lookup - also the security gate (unknown source = not a
      // registered frame = dropped), replacing a per-message iframe scan + DOM walk.
      const reg = frameByWindow(e.source)
      if (!reg) return
      const { key: nodeKey, iframe: el } = reg
      const s = useStore.getState()
      // the recorder's (spec 30): every frame message, before the shell acts on it - never consumed here
      perfSeams.frameMessage.emit(nodeKey, data)
      // Jam (spec 27): a capture's trail, handshake, probes and flushes; a key the shell owns
      if (onFrameMessage(nodeKey, data)) return
      if (data.type === 'sh:key') { if (typeof data.key === 'string') jamKey({ key: data.key, shift: !!data.shift, alt: !!data.alt, meta: !!data.meta, ctrl: !!data.ctrl }, 'frame'); return }

      if (data.type === 'sh:ready') {
        // a WindowProxy survives navigation, so a ready queued by a SUPERSEDED document (one the
        // ready-watchdog auto-renavigated past, or a same-URL reload's predecessor) can arrive here;
        // dropped by generation and document before it touches anything, so a stale ready never marks
        // a reloading frame ready, frees its admission slot or counts as seen
        if (!fromLiveDocument(el, data)) return
        // spec 30 #14: what started this document, taken before setStatus pumps the next job and setShown moves its wait
        const nav = takeNavToken(nodeKey, data)
        // a document that loaded again on its own (a full reload) is a new source revision: the
        // sleeping override of the previous document must not be trusted for this one
        if (s.nodes.find((n) => n.key === nodeKey)?.status === 'ready') s.bumpRev(nodeKey)
        s.setStatus(nodeKey, 'ready')
        recorder.ready(nodeKey, data)
        frameReady(nodeKey)
        // the revision this document was served with (spec 26): a look counts up to it, and one older
        // than the frame's last edit reloads
        const before = s.nodes.find((n) => n.key === nodeKey)?.shown
        if (typeof data.doc === 'string') s.setShown(nodeKey, data.doc)
        logReload({ kind: 'ready', cause: takeReloadCause(nodeKey) ?? (before === undefined ? 'first' : 'self'), node: nodeKey, frame: String(data.id ?? ''), shown: typeof data.doc === 'string' ? data.doc : undefined, ms: Number(data.phases?.commit), ...nav })
      } else if (data.type === 'sh:error') {
        // the same guard as sh:ready: an error from a document since replaced fails nothing and is not recorded
        if (!fromLiveDocument(el, data)) return
        s.setStatus(nodeKey, 'error', String(data.message ?? 'unknown error'))
        recorder.frameError(nodeKey, data)
      } else if (data.type === 'sh:boot') {
        recorder.booted(nodeKey, data)   // a new document: its node's outcome starts over (spec 28 A1.7)
      } else if (data.type === 'sh:exit-interact') {
        if (s.interact === nodeKey) { cmd('interact-off', { via: 'key', in: 'frame', keys: 'Escape' }); setInteract(null) }
      } else if (data.type === 'sh:theme-applied') {
        if (typeof data.theme === 'string') s.setThemeOn(nodeKey, data.theme)
      } else if (data.type === 'sh:hmr') {
        s.bumpRev(nodeKey)
      } else if (data.type === 'sh:measure') {
        // Generation and document guard: the sender echoes ITS document's URL rev and id; a
        // WindowProxy survives navigation, so a stale pre-navigation message would
        // otherwise route as if it came from the current document. Compared against
        // the iframe's CURRENT src and document - a stale one moves and keeps nothing.
        if (!fromLiveDocument(el, data)) return
        // measureNode does the rest of the admission (content frames only,
        // frame-id match, finite positive, clamped)
        const took = s.measureNode(nodeKey, String(data.frame ?? ''), Number(data.ownWidth), Number(data.measuredWidth), Number(data.height),
          typeof data.settled === 'boolean' ? data.settled : undefined)
        recorder.measured(nodeKey, data, took)
      } else if (data.type === 'sh:laser-copy') {
        // laser click = copy the element's full address for the agent: WHERE it lives on
        // the canvas ([board ▸ scene]) + frame source file + css path (+ jsx source loc)
        const n = s.nodes.find((x) => x.key === nodeKey)
        const f = n && s.frameFor(n)
        // drop a stale post that outran a frame swap (the sender echoes its frame id)
        if (f && String(data.id ?? '') === f.id) {
          const addr = `[${s.board} ▸ ${f.scene || '(root)'}]  ${f.file} · ${String(data.path ?? '')}${data.source ? ` (${String(data.source)})` : ''}`
          const h = cmd('laser-copy', { via: 'click', in: 'frame', frame: f.id })
          // success confirms IN the frame's hover label (right where the eyes are);
          // only failure needs the toast
          navigator.clipboard.writeText(addr).then(
            () => { h.done(); el.contentWindow?.postMessage({ type: 'sh:copy-ok', seq: data.seq }, location.origin) },
            () => { h.fail('clipboard-blocked'); toast('copy blocked - click the canvas first') })
        }
      } else if (data.type === 'sh:frame-down') {
        // clicks INSIDE a frame never reach the shell document - the frame reports
        // them so an open thread card dismisses modal-style from anywhere
        const c = commentsStore()
        if (c.active) { cmd('thread-close', { via: 'click', in: 'frame' }); c.setActive(null) }
        letGoOfTile({ via: 'click', in: 'frame' })   // and a lane tile selected with nothing open for it, as a canvas click does
      } else if (data.type === 'sh:picked') {
        // comment mode: the frame reports the picked element - stage the draft on
        // that node (picking while a thread is open replaces it, modal-style);
        // the CommentLayer opens the composer at the pin
        const c = commentsStore()
        if (c.active) c.setActive(null)
        if (c.commentMode) { cmd('comment-pick', { via: 'click', in: 'frame', frame: String(data.id ?? '') }); c.setDraft({ nodeKey, frame: String(data.id ?? ''), anchor: data.anchor }) }
      } else if (data.type === 'sh:go') {
        // a goto from inside an interacting frame CARRIES interact mode to the target - walking
        // a flow must not eject you to design mode at every hop (and must survive a board switch)
        goTo(String(data.target ?? ''), s.interact === nodeKey, cmd('goto', { via: 'click', in: 'frame' }))
      } else if (data.type === 'sh:wheel') {
        // B0.2: a passive frame forwarded a wheel event; the canvas owns it. Never for the
        // interact target or play (the app scrolls itself - the parent stays authoritative).
        if (s.play || s.interact === nodeKey) return
        const nums = [data.deltaX, data.deltaY, data.clientX, data.clientY].map(Number)
        if (!nums.every(Number.isFinite)) return
        const [deltaX, deltaY, localX, localY] = nums
        const rect = el.getBoundingClientRect()
        // iframe-local (untransformed CSS px) -> shell-screen px: rect is the frame's
        // transformed size, so rect.width/clientWidth is its effective on-screen scale.
        // Plain rect.left+localX would put the zoom origin in the wrong place when zoomed.
        const sx = el.clientWidth ? rect.width / el.clientWidth : 1
        const sy = el.clientHeight ? rect.height / el.clientHeight : 1
        canvasCtl.wheel({
          deltaX, deltaY, deltaMode: Number(data.deltaMode) || 0,
          ctrlKey: !!data.ctrlKey, metaKey: !!data.metaKey,
          clientX: rect.left + localX * sx, clientY: rect.top + localY * sy,
        })
      } else if (data.type === 'sh:interaction') {
        // A6: the frame reports transient laser/comment engagement (pointer inside + mode on).
        // While engaged the frame is leased, so a hot update to it defers until disengage.
        s.setExternalLease(nodeKey, 'laser', !!data.laser)
        s.setExternalLease(nodeKey, 'comment', !!data.comment)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // keyboard: t tidy · d theme · ⌘\ panel · Escape exit · shift+0/1/2 zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // anything that edits text owns its keys: inputs, textareas, selects, contenteditable (the
      // comment composer), and an IME mid-composition
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return
      if (e.isComposing) return
      const s = useStore.getState()
      if (s.play) return                       // play mode owns the keyboard (Play.tsx)
      // Jam's keys first (spec 27): the first state that takes the key; the rest falls through
      // with Option a Mac types a symbol (⌥L is "¬"): an Alt shortcut is named by the key pressed
      const key = e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key
      if (!e.repeat && jamKey({ key, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey })) { e.preventDefault(); return }
      // how this input arrived, for each command below (#50); a relayed menu item (#51) is told apart by cmd() itself
      const how = (k = e.key): CmdOpts => ({ via: 'key', in: 'shell', keys: keysOf(e, k) })
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); cmd('panel', how()); togglePanel(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); cmd('toolbar', how()); setPillOpen((o) => !o); return }
      // ⌘A in a comment card selects its words, not every frame (spec 31 C.1)
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && cardSelectAll()) { e.preventDefault(); cmd('thread-select-all', how()); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); cmd('select-all', how()); navigatedByHand(); s.selectAll(); return }
      if (e.metaKey || e.ctrlKey) return
      if (e.key === 'Escape') {
        const c = commentsStore()
        const h = cmd('escape', how())
        if (c.commentMode || c.active || c.draft) { h.step('comments-off'); c.setMode(false); c.setActive(null); c.setDraft(null) }
        else if (s.laser) { h.step('laser-off'); s.setLaser(false) }          // Escape also exits laser mode (parity with comment)
        else if (s.interact) { h.step('interact-off'); setInteract(null) }
        else { h.step('deselect'); navigatedByHand(); select(null) }
        endAfterFrames(h)
      }
      // a slides board PLAYS as slides even when its landing is the canvas -
      // the deck is what the board IS; landing only says where viewers arrive
      if (e.key === 'p') enterPlayFrom(how())
      // H hides all chrome (shared binary Hide-UI); press again to reveal. Not persisted,
      // so a refresh always restores it (the safety net for a forgotten toggle).
      if (e.key === 'h') { cmd('hide-ui', how()); toggleHideUI(); return }
      if (e.key === 't') tidyFrom(how())
      // laser and comment mode are one-at-a-time: comment mode already highlights
      // what you'd click, so stacking the full rainbow on top only adds noise
      // L: the pointer laser (the element under the cursor); ⌥L: inspect (every element outlined)
      if (key === 'l' && !e.shiftKey) {
        const h = cmd(e.altKey ? 'inspect' : 'laser', how(key))
        if (!SOURCE_REVEALED) h.noop('stripped')
        else {
          e.preventDefault()
          commentsStore().setMode(false)
          s.toggleLaser(e.altKey)
        }
      }
      // C = comment mode (the Figma/Miro convention) · Shift+C = hide/show
      // pins · Shift+P = copy file path(s) (P alone is play; D6, changelog 0.4.0)
      if (e.key === 'c' && !e.shiftKey) {
        const c = commentsStore()
        const h = cmd('comments', how())
        if (!c.commentMode && s.board === UNPLACED) { h.noop('unplaced'); return void toast(NO_COMMENTS_HERE) }
        if (!c.commentMode && stoppedFor('Comments need the canvas running')) { h.noop('stopped'); return }
        if (!c.commentMode) s.setLaser(false)
        c.setMode(!c.commentMode)
        toast(c.commentMode ? 'comment mode off' : 'comment mode - click an element in a frame')
      }
      if (e.key === 'C' && e.shiftKey) { const c = commentsStore(); cmd('pins', how()); c.setShow(!c.show) }
      // sticky notes (spec 18): any note visible -> hide all; none -> show all
      // U: the next frame that needs you, else the next new one (spec 25)
      if (e.key === 'u' && !e.shiftKey && !PUBLISHED) {
        const h = cmd('next-new', how())
        const live = s.nodes.filter((n) => !n.missing).sort((a, b) => a.y - b.y || a.x - b.x)
        const from = s.selection.length ? s.nodes.find((n) => n.key === s.selection[s.selection.length - 1])?.frame ?? null : null
        const id = nextToLook(s.marks, asksNow(), [...new Set(live.map((n) => n.frame))], from)
        const n = id ? live.find((x) => x.frame === id) : null
        // a person's navigation: a show still waiting or loading gives way (spec 31 D3)
        if (n) { navigated(); s.select(n.key); canvasCtl.fitNode(n.key) } else { h.noop('nothing-new'); toast('nothing new on this board') }
        return
      }
      if (e.key === 'n' && !e.shiftKey) { cmd('notes', how()); const visible = document.querySelectorAll('.sh-notes:not(.off)').length > 0; useNotes.getState().toggleAll(visible); toast(visible ? 'notes hidden' : 'notes shown'); return }
      // Shift+L = laser comment: the laser-sharp lighting on the element a comment tags
      // (pick hover, compose lock, open-thread highlight). Pins and cards stay - this
      // only dims the lighting inside the artwork.
      if (e.key === 'L' && e.shiftKey) {
        const c = commentsStore()
        cmd('laser-comment', how())
        c.setShowAnchor(!c.showAnchor)
        toast(c.showAnchor ? 'laser comment off' : 'laser comment on')
      }
      // I = copy the selected frame as a 2x PNG · Shift+I = 4x (dev only; one frame at a time)
      if ((e.key === 'i' || e.key === 'I') && !PUBLISHED && !e.altKey && !e.repeat) { s.copyFrameImage(e.shiftKey ? 4 : 2, how()); return }
      if (e.key === 'P' && e.shiftKey) {
        const h = cmd('copy-path', { ...how(), frames: s.selection.length })
        const paths = s.selection
          .map((k) => { const n = s.nodes.find((x) => x.key === k); const f = n && s.frameFor(n); return f ? framePath(s.board, f) : undefined })
          .filter((p): p is string => !!p)
        if (paths.length) {
          // pulse the toolbar icon into a check ONLY on a real copy success
          for (const k of s.selection) { const f = s.frameFor(s.nodes.find((x) => x.key === k)!); if (f) recordCopy('path', f.id) }
          navigator.clipboard.writeText(paths.join('\n')).then(
            () => { h.done(); toast(paths.length > 1 ? `${paths.length} paths copied` : 'path copied'); s.pulsePath() },
            () => { h.fail('clipboard-blocked'); toast('copy blocked - click the canvas first') })
        } else h.noop('no-selection')
      }
      if (e.key === 'd') {
        const h = cmd('theme', { ...how(), frames: s.selection.length || undefined })
        foldsIntoSave(h)
        if (CONFIG.themes.length <= 1) h.noop('one-theme')
        // scoped like the device digits: selection pins those frames; no selection cycles
        // the global VIEW theme (sticky across boards - the user's preference)
        else if (s.selection.length) {
          const scope = s.nodes.filter((n) => s.selection.includes(n.key))
          const cur = scope.length && scope.every((n) => n.theme === scope[0].theme) ? scope[0].theme : CONFIG.themes[0]
          s.setSelectedTheme(CONFIG.themes[(CONFIG.themes.indexOf(cur) + 1) % CONFIG.themes.length])
        } else {
          s.setTheme(CONFIG.themes[(CONFIG.themes.indexOf(s.viewTheme) + 1) % CONFIG.themes.length])
        }
      }
      // a person's camera (spec 31 D3): a show or link still loading gives way
      if (e.shiftKey && e.code === 'Digit0') { cmd('zoom-100', how('0')); navigatedByHand(); canvasCtl.zoom100() }
      if (e.shiftKey && e.code === 'Digit1') { cmd('fit-all', how('1')); navigatedByHand(); canvasCtl.fitAll() }
      if (e.shiftKey && e.code === 'Digit2') { const h = cmd('fit-selection', how('2')); navigatedByHand(); if (s.selection.length) canvasCtl.fitNodes(s.selection); else h.noop('no-selection') }
      // plain digits: 0 = default, 1..n = devices. Scoped to the selection when one
      // exists, board-wide otherwise. Every path tidies - presets never scramble layout.
      if (!e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        const idx = Number(e.code.slice(5))
        const names = Object.keys(CONFIG.viewports)
        const h = cmd('device', { ...how(String(idx)), frames: s.selection.length || undefined })
        if (idx !== 0 && !names[idx - 1]) { h.noop('unknown-device'); return }
        foldsIntoSave(h)
        const name = idx === 0 ? null : names[idx - 1]
        animateLayout()
        if (s.selection.length) {
          s.resizeSelected(name)
          setTimeout(() => canvasCtl.fitNodes(useStore.getState().selection), 30)
        } else {
          s.setDeviceView(name)
          setTimeout(() => canvasCtl.fitAll(), 30)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the sidebar reflects the ACTIVE BOARD: only scenes/frames with a node on this board
  const onBoard = new Set(nodes.map((n) => n.frame))
  const frames = (manifest?.frames ?? []).filter((f) => onBoard.has(f.id))
  // scene groups follow the CANVAS reading order (earliest node y, then x), the
  // same law as frame rows - a story board's phases list top-to-bottom as laid out
  const scenes = [...new Set(frames.map((f) => f.scene))].sort((a, b) => {
    const min = (sc: string) => nodes.reduce((acc, n) => {
      const f = frames.find((x) => x.id === n.frame)
      if (f?.scene !== sc) return acc
      return !acc || n.y < acc.y || (n.y === acc.y && n.x < acc.x) ? { y: n.y, x: n.x } : acc
    }, null as { y: number; x: number } | null)
    const ma = min(a), mb = min(b)
    if (!ma || !mb) return ma ? -1 : mb ? 1 : a.localeCompare(b)
    return ma.y - mb.y || ma.x - mb.x || a.localeCompare(b)
  })
    .map((name) => ({ name, frames: frames.filter((f) => f.scene === name).length }))
  // frame ids currently selected, for marking their parent scenes as `held`
  const selFrames = new Set(nodes.filter((n) => selection.includes(n.key)).map((n) => n.frame))
  // the shell follows the user's VIEW theme - per-frame pins never flip the chrome
  const dark = useStore((s) => s.viewTheme) === 'dark'
  // interact mode re-accents the ENTIRE shell purple - one token override class,
  // everything derived from --accent follows (mark, sidebar, bars, handles, beams)
  const interacting = useStore((s) => s.interact !== null)

  // leaving interact returns keyboard focus to the shell: while a frame held focus its
  // document swallowed every shortcut (the bridge only forwards Escape), so d/t/digits
  // appeared dead after an interact session
  const appRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!interacting) appRef.current?.focus({ preventScroll: true })
  }, [interacting])

  // Every published board is locked to a stage mode: the canvas shell is never
  // offered - no sidebar, no canvas surface, no toolbar. The bundle IS the
  // locked view (the Publish-to-web shape). Boot still ran above; the landing
  // effect entered the mode, and PlayOverlay's noDoor keeps it there.
  if (LOCKED_SHELL) {
    return (
      <div ref={appRef} tabIndex={-1} className={`sh-app${dark ? ' dark' : ''}`}>
        <PlayOverlay />
        <div className="sh-toasts">{toasts.map((t) => <div className="sh-toast" key={t.id}>{t.text}</div>)}</div>
      </div>
    )
  }

  return (
    <div ref={appRef} tabIndex={-1} className={`sh-app${dark ? ' dark' : ''}${interacting ? ' interacting' : ''}${laneLift}`}>
      <Canvas />
      {/* the scroll edge under the Mac app's transparent strip (0.27.2, A3.8 #31): over the world, under the chrome */}
      {TOP ? <div className="sh-edge" aria-hidden="true" /> : null}
      <SelectionBar />

      {/* floating pill panel (no top bar - spec); panel and fab are both always
          mounted so collapse/expand can crossfade-morph between them */}
      <aside className={`sh-panel${panelOpen ? '' : ' closed'}`} aria-hidden={!panelOpen}>
          <div className="sh-panel-top">
            {/* the mark links to the marver site; the title is the humanized repo name (C2: names
                the project so two concurrent canvases are never confused), ellipsed if long */}
            <Tip side="bottom" label="marver.design">
              <a className="mark-link" href={poweredByUrl(CONFIG.projectName, PUBLISHED ? 'published-canvas' : 'dev-canvas', 'shell')} target="_blank" rel="noreferrer" aria-label="marver.design" tabIndex={panelOpen ? 0 : -1}>
                <ParallelogramDuoIcon size={21} className="mark" />
              </a>
            </Tip>
            <span className="name" title={CONFIG.projectName || 'Marver'}>{CANVAS_NAME}</span>
            <Tip side="bottom" label={<><b>Collapse panel</b><span>⌘\</span></>}><button className="sh-ibtn" onClick={() => { cmd('panel', { via: 'click', in: 'shell' }); togglePanel() }} tabIndex={panelOpen ? 0 : -1}><PanelFilledIcon size={17} /></button></Tip>
          </div>
          <div className="sh-panel-scroll">
            <BoardList onMenu={cm.open} />
            <div className="hd" style={{ marginTop: 10 }}>Scenes</div>
            {scenes.map((sc) => (
              <SceneGroup key={sc.name} name={sc.name} label={sceneLabel(sc.name)} count={sc.frames}
                ids={frames.filter((f) => f.scene === sc.name).map((f) => f.id)}
                held={frames.some((f) => f.scene === sc.name && selFrames.has(f.id))}
                renaming={sceneNaming === sc.name}
                onRename={(raw, h) => {
                  setSceneNaming(null)
                  const title = raw === null ? undefined : readTitle(raw)
                  if (!title || title === sceneLabel(sc.name)) { h.cancel(); return }                    // Escape, empty, or unchanged = never mind
                  if (scenes.some((o) => o.name !== sc.name && sceneLabel(o.name) === title)) { h.fail('exists'); toast(`a scene called "${title}" already exists`); return }
                  // typing what the directory reads as anyway clears the title - the brief stays clean
                  useStore.getState().renameScene(sc.name, title === slugLabel(sc.name) ? '' : title).then((r) => { if (r.ok) h.done(); else { h.fail('api'); toast(r.error ?? 'rename failed') } }, () => h.fail('api'))
                }}
                onContextMenu={(e) => cm.open(e, [{
                  label: 'Copy path',
                  icon: <SignpostIcon size={15} />,
                  onClick: () => copyToClipboard(sc.name
                    ? `board: ${useStore.getState().board} · scene: ${sc.name}  (design/scenes/${sc.name}/)`
                    : `board: ${useStore.getState().board} · scene: (root)`, 'path copied', cmd('copy-path', { via: 'context', in: 'shell' })),
                }, ...(!PUBLISHED && sc.name ? [{ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setSceneNaming(sc.name) }] : []),
                ...(!PUBLISHED ? [{ label: 'Mark all as seen', icon: <CheckIcon size={15} />, onClick: () => markSeenFrom({ via: 'context', in: 'shell' }, frames.filter((f) => f.scene === sc.name).map((f) => f.id)) }] : []),
                // ...and Resolve all comments on that scene's frames (spec 31 B.1) - the root scene's ('') too
                ...(!PUBLISHED ? [{ label: 'Resolve all comments', icon: <CheckSquareOffsetIcon size={15} />, onClick: () => void resolveAllFrom({ via: 'context', in: 'shell' }, { scene: sc.name }) }] : [])])}
                onPick={() => {
                  const keys = nodes.filter((n) => frames.some((f) => f.scene === sc.name && f.id === n.frame) && !n.missing).map((n) => n.key)
                  cmd('scene-pick', { via: 'click', in: 'shell', frames: keys.length })
                  if (!keys.length) return
                  navigated()   // a person's navigation: a show still waiting or loading gives way (spec 31 D3)
                  useStore.getState().selectMany(keys)
                  canvasCtl.fitNodes(keys)
                }}>
                {(() => {
                  // variant groups render as ONE surface row with A/B/C chips
                  const nodeFor = (id: string) => nodes.find((x) => x.frame === id && !x.missing) ?? nodes.find((x) => x.frame === id)
                  // sidebar order follows the CANVAS (reading order: rows top-to-bottom,
                  // left-to-right) - a story board's list must tell the same story as its
                  // layout. Grouped frames anchor at their group's earliest position so
                  // the run stays contiguous; members sort by letter within it.
                  const pos = (id: string) => { const n = nodeFor(id); return n ? { y: n.y, x: n.x } : { y: Number.MAX_SAFE_INTEGER, x: 0 } }
                  const sceneFrames = frames.filter((f) => f.scene === sc.name)
                  const groupPos = new Map<string, { y: number; x: number }>()
                  for (const f of sceneFrames) {
                    if (!f.variantGroup) continue
                    const p = pos(f.id), g = groupPos.get(f.variantGroup)
                    if (!g || p.y < g.y || (p.y === g.y && p.x < g.x)) groupPos.set(f.variantGroup, p)
                  }
                  const keyOf = (f: FrameEntry) => f.variantGroup ? groupPos.get(f.variantGroup)! : pos(f.id)
                  sceneFrames.sort((a, b) => {
                    const ka = keyOf(a), kb = keyOf(b)
                    return ka.y - kb.y || ka.x - kb.x || (a.variant ?? '').localeCompare(b.variant ?? '')
                  })
                  const go = (id: string, shift: boolean) => {
                    const n = nodeFor(id)
                    if (!n) return
                    cmd('frame-pick', { via: 'click', in: 'shell', frame: id })
                    navigated()   // a person's navigation: a show still waiting or loading gives way (spec 31 D3)
                    select(n.key, shift)
                    if (!shift) canvasCtl.fitNode(n.key)
                  }
                  const frameMenu = (fr: FrameEntry): MenuItem[] => [
                    { label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => { recordCopy('path', fr.id); copyToClipboard(framePath(useStore.getState().board, fr), 'path copied', cmd('copy-path', { via: 'context', in: 'shell', frame: fr.id })) } },
                    // the Not on a board view (spec 26): put the frame where it belongs
                    ...(useStore.getState().board === UNPLACED ? [{ label: 'Add to board…', icon: <PlusIcon size={15} />, panel: (close: () => void) => <AddToBoard frame={fr.id} close={close} /> }] : []),
                  ]
                  const seen = new Set<string>()
                  const rows: ReactNode[] = []
                  for (const f of sceneFrames) {
                    if (f.variantGroup && !seen.has(f.variantGroup)) {
                      seen.add(f.variantGroup)
                      const members = sceneFrames.filter((m) => m.variantGroup === f.variantGroup)
                        .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))
                      if (members.length > 1) {
                        const rel = f.variantGroup === sc.name ? 'Variants'
                          : cap(f.variantGroup.slice(sc.name.length + 1).replace(/-/g, ' '))
                        const memberKeys = members.map((m) => nodeFor(m.id)?.key).filter((k): k is string => !!k)
                        const allOn = memberKeys.length > 0 && memberKeys.every((k) => selection.includes(k))
                        // held = SOME member active (same quiet wash as scene headers) - the
                        // group participates without claiming full selection
                        const held = !allOn && memberKeys.some((k) => selection.includes(k) || useStore.getState().interact === k)
                        // group header: click selects EVERY variant (the quick compare-and-test grab)
                        // the group row leads with the flask - variant-ness IS the row's
                        // identity; members carry their letter chips, indented below it
                        rows.push(
                          <div key={`g:${f.variantGroup}`} className={`sub vgroup${allOn ? ' on' : ''}${held ? ' held' : ''}`}
                            title="Select all variants"
                            onClick={() => { cmd('group-fit', { via: 'click', in: 'shell', frames: memberKeys.length }); navigated(); useStore.getState().selectMany(memberKeys); canvasCtl.fitNodes(memberKeys) }}>
                            <VariantsIcon size={13} className="iicon" />
                            <span className="glabel">{rel}</span>
                          </div>,
                        )
                        // one row per variant: [letter chip] + name, individually selectable
                        for (const m of members) {
                          const n = nodeFor(m.id)
                          const on = !!n && selection.includes(n.key)
                          const nm = m.title ?? cap((m.id.split('/').pop() ?? '').replace(/^[a-z]-/, '').replace(/-/g, ' '))
                          rows.push(
                            <MarkedRow key={m.id} frame={m.id} className={`sub vrow${on ? ' on' : ''}`} onClick={(e) => go(m.id, e.shiftKey)}
                              onContextMenu={(e) => cm.open(e, frameMenu(m))}>
                              <span className={`chip${on ? ' on' : ''}`}>{(m.variant ?? '?').toUpperCase()}</span><span className="nm">{nm}</span>
                            </MarkedRow>,
                          )
                        }
                        continue
                      }
                    } else if (f.variantGroup) continue
                    const n = nodeFor(f.id)
                    const on = !!n && selection.includes(n.key)
                    rows.push(
                      <MarkedRow key={f.id} frame={f.id} className={`sub${on ? ' on' : ''}`} onClick={(e) => go(f.id, e.shiftKey)} onContextMenu={(e) => cm.open(e, frameMenu(f))} title={f.intent}>
                        {/* every frame leads with an icon: the slide badge first (a deck
                            frame is a deck frame whatever it imports), intent glyph for
                            content frames, the plain rectangle for UI frames */}
                        {f.slide
                          ? <SlideFrameIcon size={13} className="iicon" role="img" aria-hidden={false} aria-label="slide" />
                          : f.intent
                            ? <IntentGlyph intent={f.intent} size={13} className="iicon" aria-label={f.intent} />
                            : <FrameRectIcon size={13} className="iicon" />}
                        <span className="nm">{cap(f.id.split('/').slice(1).join('/') || f.id)}</span>
                      </MarkedRow>,
                    )
                  }
                  return rows
                })()}
              </SceneGroup>
            ))}
            {frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
          </div>
      </aside>
      <Tip side="bottom" label={<><b>Open panel</b><span>⌘\</span></>}>
        <button className={`sh-fab${panelOpen ? ' hidden' : ''}`} onClick={() => { cmd('panel', { via: 'click', in: 'shell' }); togglePanel() }}
          aria-hidden={panelOpen} tabIndex={panelOpen ? -1 : 0}><PanelHollowIcon size={18} /></button>
      </Tip>

      {/* floating pill nav, top right; collapses to a chip (same ladder as panel/fab) */}
      <nav className={`sh-pill${pillOpen ? '' : ' closed'}`} aria-hidden={!pillOpen}>
        {/* far-left section: actions - comment mode, laser, tidy */}
        <CommentButton />
        <LaserButton />
        {/* Jam V2 (spec 27 Part 5): the session - between Laser and Tidy */}
        {!PUBLISHED && CONFIG.jam && <JamButton />}
        <Tip side="bottom" label={<><b>Tidy layout</b><span>T</span></>}>
          <button className="sh-pill-btn" onClick={() => tidyFrom({ via: 'click', in: 'pill' })}><ColumnsIcon size={16} /></button>
        </Tip>
        <i className="sep" />
        <DeviceMenu />
        <ThemeMenu />
        <i className="sep" />
        <ZoomMenu />
        <i className="sep" />
        {/* far right: view management - prototype, hide, collapse */}
        <Tip side="bottom" label={<><b>Prototype view</b><span>P</span></>}>
          <button className="sh-pill-btn" onClick={() => enterPlayFrom({ via: 'click', in: 'pill' })}><PlayIcon size={15} /></button>
        </Tip>
        <HideUIButton />
        <Tip side="bottom" label={<><b>Collapse toolbar</b><span>⌘/</span></>}>
          <button className="sh-pill-btn" onClick={() => { cmd('toolbar', { via: 'click', in: 'pill' }); setPillOpen(false) }} tabIndex={pillOpen ? 0 : -1}>
            <PanelFilledIcon size={17} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </Tip>
      </nav>
      <Tip side="bottom" label={<><b>Open toolbar</b><span>⌘/</span></>}>
        <button className={`sh-pill-fab${pillOpen ? ' hidden' : ''}`} onClick={() => { cmd('toolbar', { via: 'click', in: 'pill' }); setPillOpen(true) }}
          aria-hidden={pillOpen} tabIndex={pillOpen ? -1 : 0}><PanelHollowIcon size={18} style={{ transform: 'rotate(90deg)' }} />{recording && <i className="jm-live-dot jm-fab-dot" />}</button>
      </Tip>

      <PlayOverlay />
      <CommentsController />
      <ContextMenu menu={cm.menu} close={cm.close} />

      {CONFIG.setup
        ? <div className="sh-banner">no app detected - designs would be built from nothing. See design/instructions/setup.md, then restart</div>
        : CONFIG.noTheme && !contentOnly(manifest?.frames ?? []) && <div className="sh-banner">no theme configured - frames render unstyled. Create design/theme.css importing your app's stylesheet (or set theme in design/config.ts)</div>}
      {stopped && <StoppedBanner />}
      <UpdatePill />
      <ShowNotice />

      {/* Jam V2 (spec 27): the lane, the focus panel, the notes card, the recording ring */}
      {!PUBLISHED && <JamSurface sidebarRight={panelOpen ? 236 + 2 * 10 : 10} />}
      <JamToasts toasts={toasts} />
    </div>
  )
}

/** The canvas stopped (spec 28 A1.11): what happened and the way back - and, only when this tab holds some, that
 *  its unsaved edits are kept. It sits on the toolbar's centre line in the free gap between the sidebar and the
 *  toolbar, or just below the toolbar row when that gap is too narrow; it never covers either, and Hide UI (H)
 *  leaves it up. In play it wears the play chrome's dark skin. */
function StoppedBanner() {
  const link = useLink((s) => s.link)
  const unsaved = useLink((s) => s.unsaved)
  const play = useStore((s) => !!s.play)
  const ref = useRef<HTMLDivElement>(null)
  const cmd = <code>npx marver dev</code>
  const what = link === 'resuming' ? <>This canvas is back{unsaved ? ' - saving your edits' : ''}</>
    : link === 'elsewhere' ? <>Another canvas is running on this address - stop it and run {cmd} to bring this one back</>
    : <>This canvas stopped - run {cmd} to bring it back</>
  const kept = unsaved && link !== 'resuming'
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const place = () => { cancelAnimationFrame(raf); raf = 0; placeBanner(el) }
    const soon = () => { raf ||= requestAnimationFrame(place) }
    place()
    // what moves the gap: the window, the chrome around it opening, closing or changing size, play, Hide UI
    const seen = new Set<Element>()
    const ro = new ResizeObserver(soon)
    const watch = () => { for (const n of el.parentElement?.querySelectorAll(OBSTACLES) ?? []) if (!seen.has(n)) { seen.add(n); ro.observe(n) } }
    watch()
    const mo = new MutationObserver(() => { watch(); soon() })
    if (el.parentElement) mo.observe(el.parentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', soon)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); window.removeEventListener('resize', soon) }
  }, [link, unsaved, play])
  return (
    <div ref={ref} className={`sh-banner sh-stopped${play ? ' dark' : ''}`} role="status" data-link={link}>
      {what}{kept && <><span className="dot"> · </span><span className="kept">your unsaved edits are kept in this tab</span></>}
    </div>
  )
}

/** The chrome the stopped banner keeps clear of: the sidebar (or its button) on the left, the toolbar (or its
 *  button) on the right - the canvas's own, or play's brand and toolbar pills over it. */
const OBSTACLES = ':scope > .sh-panel, :scope > .sh-fab, :scope > nav.sh-pill, :scope > .sh-pill-fab, :scope > .sh-play > .sh-pill, :scope > .sh-play > .sh-pill-fab'
const BANNER_GAP = 12
function placeBanner(el: HTMLElement) {
  const app = el.parentElement
  if (!app) return
  const edge = parseFloat(getComputedStyle(app).getPropertyValue('--edge')) || 10
  // a box in the app's own coordinates, from layout - never the rect mid-morph (a closing panel scales down)
  const box = (n: HTMLElement) => {
    let x = 0, y = 0
    for (let e: HTMLElement | null = n; e && e !== app; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop }
    return { left: x, top: y, right: x + n.offsetWidth, bottom: y + n.offsetHeight }
  }
  const pick = (root: Element, sel: string) => {
    const n = root.querySelector<HTMLElement>(sel)
    return n && !n.matches('.closed, .hidden') && n.offsetWidth ? box(n) : null
  }
  let left: ReturnType<typeof box> | null = null, right: ReturnType<typeof box> | null = null
  if (!document.body.classList.contains('sh-hide-ui')) {
    const stage = app.querySelector(':scope > .sh-play')
    if (stage) {
      left = pick(stage, ':scope > .sh-play-brand')
      right = pick(stage, ':scope > .sh-play-pill:not(.sh-play-brand)') ?? pick(stage, ':scope > .sh-pill-fab')
    } else {
      left = pick(app, ':scope > .sh-panel') ?? pick(app, ':scope > .sh-fab')
      right = pick(app, ':scope > nav.sh-pill') ?? pick(app, ':scope > .sh-pill-fab')
    }
  }
  // the toolbar row: its centre line, and its foot - the sidebar runs down the page, so it is no part of the row
  const tall = !!left && left.bottom - left.top > 64
  const row = [right, tall ? null : left].filter((b): b is NonNullable<typeof b> => !!b)
  // with no row to measure: the toolbar's line, below the Mac app's strip when the shell took the inset
  const mid = row.length ? Math.max(...row.map((b) => (b.top + b.bottom) / 2)) : TOP + edge + 23
  const foot = Math.max(TOP + edge + 46, ...row.map((b) => b.bottom))
  const W = app.clientWidth
  const from = left ? left.right + BANNER_GAP : edge, to = right ? right.left - BANNER_GAP : W - edge
  const at = (where: 'row' | 'stack' | 'below', x0: number, x1: number, top?: number) => {
    el.dataset.at = where
    el.style.left = `${Math.round(x0 + Math.max(0, (x1 - x0 - el.offsetWidth) / 2))}px`
    el.style.top = `${Math.round(top ?? mid - el.offsetHeight / 2)}px`
  }
  el.style.transform = 'none'
  el.dataset.at = 'row'
  // one line in the gap
  el.style.whiteSpace = 'nowrap'
  el.style.maxWidth = 'none'
  const line = el.offsetHeight
  if (el.offsetWidth <= to - from) return at('row', from, to)
  // two lines in the gap: what happened, then the kept edits under it
  if (el.querySelector('.kept')) {
    el.dataset.at = 'stack'
    if (el.offsetWidth <= to - from) return at('stack', from, to)
    el.dataset.at = 'row'
  }
  // or wrapped in two, the box no wider than its longest line
  el.style.whiteSpace = 'normal'
  el.style.maxWidth = `${to - from}px`
  if (to - from >= 220 && el.offsetHeight <= line + 18) { hug(el); return at('row', from, to) }
  // too narrow: under the toolbar row, centred in what the sidebar leaves, the kept edits on a line of their own
  el.dataset.at = 'below'
  const lo = tall && left ? left.right + BANNER_GAP : edge, hi = W - edge
  el.style.maxWidth = `${Math.max(160, Math.min(680, hi - lo))}px`
  hug(el)
  at('below', lo, hi, row.length ? foot + 8 : edge)   // no row with the chrome hidden: the top edge
}
/** A wrapped banner's box shrinks to its longest line (a max-width box stays as wide as it may be). */
function hug(el: HTMLElement) {
  const r = document.createRange()
  r.selectNodeContents(el)
  const lines = [...r.getClientRects()]
  if (!lines.length) return
  const cs = getComputedStyle(el)
  const chrome = el.offsetWidth - el.clientWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
  const need = Math.ceil(Math.max(...lines.map((l) => l.right)) - Math.min(...lines.map((l) => l.left)) + chrome) + 1
  const was = el.style.maxWidth, h = el.offsetHeight
  el.style.maxWidth = `${Math.min(need, el.offsetWidth)}px`
  if (el.offsetHeight > h) el.style.maxWidth = was   // never a line more than it had (a balanced wrap re-flows)
}

/** The bottom-right notification corner. Plain toasts render as before.
 *  Jam pills are FRAME-FIRST (icon + frame title, then Marver · preview) and stack as a DECK:
 *  1-2 show in full; 3+ collapse to the newest pill with two card edges peeking beneath and a
 *  +N badge - click to expand the full list (newest first, timestamps, Clear all). */
function JamToasts({ toasts }: { toasts: import('./store.ts').Toast[] }) {
  const [expanded, setExpanded] = useState(false)
  const plain = toasts.filter((t) => !t.jam)
  const jams = toasts.filter((t) => t.jam)
  useEffect(() => { if (jams.length <= 2) setExpanded(false) }, [jams.length])
  const deck = jams.length > 2 && !expanded
  const newest = jams[jams.length - 1]
  return (
    <div className="sh-toasts">
      <PdfNotice />
      {/* the last two - and a notice with an action (Undo) stays among them while it lasts */}
      {(() => { const act = plain.filter((t) => t.action).slice(-1); return [...plain.filter((t) => !t.action).slice(act.length ? -1 : -2), ...act].sort((a, b) => a.id - b.id) })().map((t) => (
        <div key={t.id} className="sh-toast" data-toast={t.action?.id}><CheckIcon size={12} /> {t.text}
          {t.action && <button className="sh-toast-act" onClick={() => { const a = t.action!; useStore.getState().dropToast(t.id); a.run() }}>{t.action.label}</button>}
        </div>
      ))}
      {expanded && jams.length > 2 && (
        <div className="sh-jam-list">
          <div className="sh-jam-listhead">
            <span>{jams.length} NOTIFICATIONS</span>
            <button onClick={() => { cmd('notices-clear', { via: 'click', in: 'shell' }); useStore.getState().clearJamToasts(); setExpanded(false) }}>Clear all</button>
            <button aria-label="Collapse" onClick={() => { cmd('notices-collapse', { via: 'click', in: 'shell' }); setExpanded(false) }}><XIcon size={12} /></button>
          </div>
          {[...jams].reverse().map((t) => <JamToast key={t.id} id={t.id} note={t.jam!} />)}
        </div>
      )}
      {!expanded && (deck
        ? (
          <div className="sh-jam-deck" onClick={() => { cmd('notices-expand', { via: 'click', in: 'shell' }); setExpanded(true) }} role="button" aria-label={`${jams.length} notifications - expand`}>
            <div className="sh-jam-ghost g2" />
            <div className="sh-jam-ghost g1" />
            {newest?.jam && <JamToast id={newest.id} note={newest.jam} badge={jams.length - 1} inert />}
          </div>
        )
        : jams.map((t) => <JamToast key={t.id} id={t.id} note={t.jam!} />))}
    </div>
  )
}

/** The pill's face for a human notification - the author's picture, or the
 *  house initials fallback (same ladder the thread avatars use). */
function JamAvatar({ author }: { author: { name?: string; avatar?: string; id?: string; email?: string } }) {
  const { initials, hue } = avatarFallback(author)
  return author.avatar
    ? <img className="sh-jam-ava" src={author.avatar} alt="" referrerPolicy="no-referrer" />
    : <span className="sh-jam-ava init" style={{ background: `hsl(${hue} 55% 45%)` }}>{initials}</span>
}

/** View from a notification: threads are frame-scoped, so first try to reveal RIGHT HERE
 *  (the current board may show the thread's frame); only when it doesn't, switch to the
 *  note's origin board and retry while its comments load. Dismiss only on success: a
 *  cross-board note must never be a destructive no-op. */
async function viewNote(note: import('./store.ts').JamNote, dismiss: () => void, h: CmdHandle) {
  navigatedByHand()   // the person chose View (spec 31 D3): a show or link still loading gives way
  if (revealThread(note.threadId)) { h.done(); dismiss(); return }
  const s = useStore.getState()
  // a navigation: a link still finding its board gives way to it - and it to a newer one, wherever this one has got to
  const nav = navigated()
  // a thread in the old all-scenes log has no board of its own: its frame's board shows it (spec 26)
  if (note.board === ALL_SCENES) { if (note.frame) await revealFrame(note.frame, nav) }
  else if (note.board && s.board !== note.board && !await switchFor(note.board, nav)) return h.fail('missing')
  for (let i = 0; i < 12 && isLatest(nav); i++) {
    if (revealThread(note.threadId)) { h.done(); dismiss(); return }
    await new Promise((r) => setTimeout(r, 250))
  }
  h.fail('missing')
}

/** Retry a batch's failed jam cards from their notice - each one still failed (a newer change wins). */
async function retryNote(failed: { card: string; rev: number }[], h: CmdHandle) {
  const { useJamQueue } = await import('./jam-queue.ts')
  let found = false, refused = false
  for (const f of failed) {
    const card = useJamQueue.getState().cards?.find((c) => c.id === f.card)
    if (card && card.state === 'failed') { found = true; if (!await useJamQueue.getState().act(card, 'retry')) refused = true }
  }
  if (refused) h.fail('refused'); else if (!found) h.fail('missing'); else h.done()
}

/** One jam pill, frame-first: row 1 = intent icon + FRAME TITLE (blue) · age; row 2 = Marver · preview.
 *  `badge` shows the +N deck count (replacing View); `inert` disables inner clicks (the deck handles it). */
function JamToast({ id, note, badge, inert }: { id: number; note: import('./store.ts').JamNote; badge?: number; inert?: boolean }) {
  const dismiss = () => useStore.getState().dismissToast(id)
  // human pills are person-first: their avatar, "name mentioned you"; the
  // agent pill keeps its frame-first shape with the mark
  const human = note.kind && note.author
  return (
    <div className="sh-toast jam">
      {human
        ? <JamAvatar author={note.author!} />
        : <span className="sh-jam-mark"><ParallelogramFillIcon size={17} /></span>}
      <div className="sh-jam-txt">
        {human
          ? <b className="sh-jam-frame"><span className="t">{note.author!.name ?? 'Someone'}</span> <span className="v">{note.kind === 'mention' ? 'mentioned you' : 'replied'}</span></b>
          : note.stack?.length
            ? <b className="sh-jam-frame"><span className="t">{note.board === ALL_SCENES ? note.frameTitle ?? note.frame ?? '' : boardLabel(note.board)}</span> <span className="v">· {note.stack.length + 1} replies</span></b>
            : <b className="sh-jam-frame"><span className="t">{note.frameTitle ?? note.board}</span>{note.failed && <span className="v"> · failed</span>}</b>}
        <span className="sh-jam-prev">{note.preview}</span>
      </div>
      {badge != null
        ? <span className="sh-jam-badge">+{badge}</span>
        : !inert && <>
            {note.failed && <button className="sh-jam-view" onClick={() => { void retryNote(note.failed!, cmd('notice-retry', { via: 'click', in: 'shell' })); dismiss() }}>Retry</button>}
            {note.threadId && <button className="sh-jam-view" onClick={() => void viewNote(note, () => useStore.getState().advanceToast(id), cmd('notice-view', { via: 'click', in: 'shell' }))}>View</button>}
            <button className="sh-jam-x" aria-label="Dismiss" onClick={() => { cmd('notice-dismiss', { via: 'click', in: 'shell' }); dismiss() }}><XIcon size={13} /></button>
          </>}
    </div>
  )
}
