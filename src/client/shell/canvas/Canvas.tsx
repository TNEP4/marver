import { useEffect, useLayoutEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'
import { CONFIG, useStore } from '../store.ts'
import { letGoOfTile } from '../jam-state.ts'
import { bootHash, linkTargets } from '../hash.ts'
import { revealFrame } from '../goto.ts'
import { startPerf } from '../perf.ts'
import { FrameNode, HEADER } from './FrameNode.tsx'
import { NOTE_GAP } from '../notes.ts'
import { onMotion, startCameraBroadcast, setCameraScale } from './camera-broadcast.ts'
import { attachCanvas, recorder } from '../recorder.ts'
import { sleepingCount } from './sleep.ts'
import { aimed } from './admission.ts'
import { keepOverResume, resumed, WS } from '../api.ts'
import { APP_REOPEN } from '../marver-app.ts'
import { TOP } from '../inset.ts'

/**
 * The world. rzpp owns pan/zoom; nodes are absolutely positioned children of #sh-world.
 *
 * Interaction model (Figma conventions):
 *   two-finger scroll = pan · ctrl/cmd+scroll or pinch = zoom · space+drag or middle-drag = pan
 *   dragging a frame moves the FRAME ONLY - `excluded` classes plus the store gesture
 *   flag keep rzpp's native listeners out of it (React stopPropagation fires too late:
 *   rzpp listens on its wrapper, below React's delegation root in the bubble path).
 *
 * Iframe laws: render order = store order (append-only, never sorted); will-change only during
 * gestures (G-3); iframes lose pointer-events during any gesture (G-4).
 */

/**
 * Fit centers content in the space the chrome leaves free, measured live at fit time:
 * the open sidebar (or its collapsed FAB) claims a left column, the pill row claims a
 * top band, and the screen-space selection bar needs headroom above the fitted content.
 * Measuring instead of hardcoding keeps every fit trigger (shift+1/2, device presets,
 * board switch) correct whether the sidebar is open or collapsed.
 */
const GAP = 32
const BAR = 56

/** The camera survives a reload (spec 28 A2.9): kept per canvas and board, `mv-camera:<workspace>:<board>`, a second
 *  after it settles, and the next load of that board opens there - when its link names no selection, or when the Mac
 *  app reloaded the tab after a crash (`marverApp.reopen`). A1's camera carried over a resume wins. Dev canvases only:
 *  a published one has no workspace, and opens on the whole board as before. */
type Camera = { x: number; y: number; scale: number }
const cameraKey = (board: string) => `mv-camera:${WS}:${board}`
function savedCamera(board: string): Camera | null {
  if (!WS) return null
  try {
    const c = JSON.parse(localStorage.getItem(cameraKey(board)) ?? 'null')
    return c && [c.x, c.y, c.scale].every((v) => typeof v === 'number' && Number.isFinite(v)) && c.scale >= 0.05 && c.scale <= 5 ? { x: c.x, y: c.y, scale: c.scale } : null
  } catch { return null }
}
let keepTimer: ReturnType<typeof setTimeout> | undefined
/** the camera write waiting for its second of quiet, if any */
let keepPending: (() => void) | undefined
/** Where the camera's flight lands (a fit, a zoom), for canvasCtl.landing: read only while rzpp animates. */
let flight: Camera | null = null
function keepCamera(x: number, y: number, scale: number) {
  if (!WS) return
  const board = useStore.getState().board
  clearTimeout(keepTimer)
  const write = () => {
    keepPending = undefined
    if (useStore.getState().board !== board) return   // switched meanwhile: this camera was the other board's
    try { localStorage.setItem(cameraKey(board), JSON.stringify({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, scale })) } catch { /* storage off: the next load fits */ }
  }
  keepPending = write
  keepTimer = setTimeout(write, 1000)
}
/**
 * The pending camera, written now (spec 28 A3.8 #43): the page is hidden or leaving, and the Mac app may unload a
 * hidden tab, which ends its page with the second of quiet not yet over. A hide mid-flight writes where the flight
 * was going: a hidden page's animation frames stop, so it would not land before the page went. Nothing pending,
 * nothing written. In Chrome too - a tab switch, a closed tab.
 */
export function flushCamera(): void {
  if (flight && canvasCtl.cameraBusy()) keepCamera(flight.x, flight.y, flight.scale)
  if (!keepPending) return
  clearTimeout(keepTimer)
  keepPending()
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCamera() })
  addEventListener('pagehide', flushCamera)
}
function insets(el: HTMLElement) {
  const c = el.getBoundingClientRect()
  const rect = (q: string) => document.querySelector(q)?.getBoundingClientRect()
  const side = rect('.sh-panel:not(.closed)') ?? rect('.sh-fab')
  const pill = rect('.sh-pill')
  // Jam (spec 27): the focus panel sits right of the sidebar and the lane along the bottom - a card's
  // frames fit in the space left of neither
  const focus = rect('.jm-focus')
  const lane = rect('.jm-lane')
  const leftEdge = Math.max(side ? side.right : 0, focus ? focus.right : 0)
  return {
    left: (leftEdge ? Math.max(0, leftEdge - c.left) : 0) + GAP,
    right: GAP + 16,
    // the toolbar's foot, or the Mac app's strip when the toolbar is hidden (Hide UI) - the strip is always there
    top: Math.max(pill ? pill.bottom - c.top : 0, TOP) + 12 + BAR,
    bottom: (lane ? Math.max(0, c.bottom - lane.top) : 0) + GAP + 16,
  }
}

/**
 * World-space dot grid (sense-of-scale, the Figma/tldraw recipe): the grid pans and
 * zooms with the content, and its pitch re-quantizes in octaves so the on-screen
 * spacing always lands in [14, 28)px - zooming out doubles the world spacing instead
 * of dissolving into noise. Alpha fades across the octave so level switches don't pop.
 * Painted via CSS vars on the wrapper - no React re-render per frame.
 */
const GRID = 20
function paintGrid(positionX: number, positionY: number, scale: number) {
  // on .sh-app, which the canvas's ::before and the scroll edge (A3.8 #31) both inherit them from - the same element the
  // camera's own variables go on every frame, so the style work per frame does not grow
  const app = document.querySelector('.sh-app') as HTMLElement | null
  if (!app) return
  let step = GRID * scale
  while (step < 14) step *= 2
  while (step >= 28) step /= 2
  const t = (step - 14) / 14
  app.style.setProperty('--grid-size', `${step}px ${step}px`)
  app.style.setProperty('--grid-pos', `${positionX % step}px ${positionY % step}px`)
  app.style.setProperty('--grid-alpha', (0.35 + 0.65 * Math.min(1, t)).toFixed(3))
  // screen-space overlays (selection bar) position themselves from these - no re-render per frame
  app.style.setProperty('--sh-s', String(scale))
  app.style.setProperty('--sh-inv', String(1 / scale))   // world-units-per-screen-px, for zoom-invariant strokes
  app.style.setProperty('--sh-tx', `${positionX}px`)
  app.style.setProperty('--sh-ty', `${positionY}px`)
}

/**
 * Preset transitions: device resizes and tidy moves are store mutations that commit in
 * one React render - instant, jarring jumps. Arming this class right before the mutation
 * lets the nodes ease to their new size/position on the same duration+curve the camera
 * fit uses, so frames and viewport travel together. Drags stay direct (class absent).
 */
let presetTimer = 0
export function animateLayout(ms = 360) {
  const w = document.getElementById('sh-world')
  if (!w) return
  w.classList.add('sh-preset')
  clearTimeout(presetTimer)
  presetTimer = window.setTimeout(() => w.classList.remove('sh-preset'), ms)
}

// the control channel lives in ctl.ts so play/focus can import it without
// dragging the canvas into a locked-shell bundle; Canvas assigns the real
// implementations below when it mounts
import { canvasCtl, type CanvasWheelInput } from './ctl.ts'
export { canvasCtl, type CanvasWheelInput }
import { anchorNode, anchoredCamera, type Held } from './anchor.ts'
/** The node a content-driven reflow must not move on screen (holdView -> the layout effect). */
let heldView: Held | null = null

/** Variant-group captions: "Landing · 3 variants" above each group with
 *  2+ members on this board. World-space (scales with the canvas); min screen size via
 *  --sh-inv. Groups with one lone member on a curated board keep the badge, no caption. */
function GroupCaptions() {
  const nodes = useStore((s) => s.nodes)
  const manifest = useStore((s) => s.manifest)
  const selection = useStore((s) => s.selection)
  if (!manifest) return null
  const byId = new Map(manifest.frames.map((f) => [f.id, f]))   // O(F+N), not O(F*N) per drag
  const groups = new Map<string, { x: number; y: number; ids: Set<string>; keys: string[] }>()
  for (const n of nodes) {
    if (n.missing) continue
    const f = byId.get(n.frame)
    if (!f?.variantGroup) continue
    const g = groups.get(f.variantGroup)
    if (!g) groups.set(f.variantGroup, { x: n.x, y: n.y, ids: new Set([n.frame]), keys: [n.key] })
    else { g.x = Math.min(g.x, n.x); g.y = Math.min(g.y, n.y); g.ids.add(n.frame); g.keys.push(n.key) }
  }
  return (
    <>
      {[...groups.entries()].filter(([, g]) => g.ids.size > 1).map(([id, g]) => {
        const allOn = g.keys.every((k) => selection.includes(k))
        return (
          <div key={id} className={`sh-gcaption sh-no-pan${allOn ? ' on' : ''}`}
            style={{ transform: `translate(${g.x}px, ${g.y}px) translateY(calc(-100% - clamp(4px, 8px * var(--sh-inv, 1), 40px)))` }}
            title="Select all variants"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => { useStore.getState().selectMany(g.keys); canvasCtl.fitNodes(g.keys) }}>
            {id.split('/').map((s) => s[0].toUpperCase() + s.slice(1)).join(' / ')} · {g.ids.size} variants
          </div>
        )
      })}
    </>
  )
}

export function Canvas() {
  const nodes = useStore((s) => s.nodes)
  const gesture = useStore((s) => s.gesture)
  const setScale = useStore((s) => s.setScale)
  const ref = useRef<ReactZoomPanPinchContentRef>(null)
  // every camera move the canvas aims (a fit, a zoom, a camera restored): where it lands, while rzpp flies there, and the
  // boot queue told - the first frame of a board starts now, ranked on that view, not once the flight is over
  const fly = (x: number, y: number, scale: number, ms: number) => {
    flight = ms ? { x, y, scale } : null
    ref.current?.setTransform(x, y, scale, ms, 'easeOut')
    aimed()
  }
  const scaleTimer = useRef(0)

  // B0.4: frame-time sampler + image-LOD camera signal; the recorder hears when the camera stops and what sleeps (spec 28 A1.7)
  useEffect(() => { startPerf(); startCameraBroadcast(); return attachCanvas({ onMotion, sleeping: sleepingCount }) }, [])

  useEffect(() => {
    const wrap = () => document.querySelector('.sh-canvas') as HTMLElement | null
    // focus=true (selection fits): center on the TRUE viewport center for a proper focus
    // state, then clamp back into the chrome-free band only if the content would slide
    // under the sidebar or pill. Small frames land dead center; wide selections degrade
    // to band-centering. fitAll stays band-centered - there everything must be visible.
    const fitRect = (x: number, y: number, w: number, h: number, focus = false) => {
      const el = wrap()
      if (!el || !ref.current) return
      const p = insets(el)
      const vw = el.clientWidth, vh = el.clientHeight
      const aw = vw - p.left - p.right
      const ah = vh - p.top - p.bottom
      const scale = Math.max(0.05, Math.min(1, aw / w, ah / h))
      let px = p.left + (aw - w * scale) / 2
      let py = p.top + (ah - h * scale) / 2
      if (focus) {
        // clamp order matters: left/top win when the band is tighter than the content. The centre is the usable
        // rectangle's: below the Mac app's strip when the shell took the inset (TOP 44)
        px = Math.max(Math.min((vw - w * scale) / 2, vw - p.right - w * scale), p.left)
        py = Math.max(Math.min(TOP + (vh - TOP - h * scale) / 2, vh - p.bottom - h * scale), p.top)
      }
      const tx = px - x * scale, ty = py - y * scale
      // where this fit lands, in world px: the first one after a board's commit shows its visible cohort (spec 28 A1.7)
      recorder.placed({ x: -tx / scale, y: -ty / scale, w: vw / scale, h: vh / scale })
      fly(tx, ty, scale, 320)
    }
    const fitKeys = (keys: string[], focus: boolean) => {
      const st = useStore.getState()
      const sel = new Set(keys)
      const ns = st.nodes.filter((n) => sel.has(n.key))
      if (!ns.length) return
      let x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y))
      const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h + HEADER))
      // grouped frames carry chrome OUTSIDE their box (badge left, caption above) -
      // fit must include that envelope or the variant text lands under the sidebar.
      // Screen-clamped sizes need a scale estimate first: one pre-pass, then pad.
      if (ns.some((n) => st.frameFor(n)?.variantGroup)) {
        const el = wrap()
        if (el) {
          const p = insets(el)
          const s1 = Math.max(0.05, Math.min(1, (el.clientWidth - p.left - p.right) / (x1 - x0), (el.clientHeight - p.top - p.bottom) / (y1 - y0)))
          x0 -= Math.max(140, 44 / s1)   // badge letter+name column (min 44 screen px)
          y0 -= Math.max(64, 36 / s1)    // caption line above the group
        }
      }
      // sticky notes (spec 18): a visible column hangs left of its frame, and may run below it
      let y1n = y1
      for (const n of ns) {
        const col = document.querySelector(`[data-node-notes="${CSS.escape(n.key)}"]:not(.off)`) as HTMLElement | null
        if (!col) continue
        x0 = Math.min(x0, n.x - col.offsetWidth - NOTE_GAP)
        y1n = Math.max(y1n, n.y + col.offsetTop + col.offsetHeight)
      }
      fitRect(x0, y0, x1 - x0, y1n - y0, focus)
    }
    canvasCtl.fitNode = (key: string) => fitKeys([key], true)
    canvasCtl.fitNodes = (keys: string[]) => fitKeys(keys, true)
    canvasCtl.fitAll = () => fitKeys(useStore.getState().nodes.map((n) => n.key), false)
    canvasCtl.zoomTo = (target: number) => {
      const el = wrap(), inst = ref.current
      if (!el || !inst) return
      const { positionX, positionY, scale } = inst.instance.transformState
      const cx = el.clientWidth / 2, cy = TOP + (el.clientHeight - TOP) / 2
      const k = target / scale   // zoom about the usable rectangle's centre (below the Mac app's strip with the inset)
      fly(cx - (cx - positionX) * k, cy - (cy - positionY) * k, target, 250)
    }
    canvasCtl.cameraBusy = () => !!ref.current?.instance.animation
    // a rect on screen now, where it will be when the flight lands: the same world point under the landing transform
    canvasCtl.landing = (r: DOMRect) => {
      const el = wrap(), inst = ref.current
      if (!flight || !el || !inst?.instance.animation) return r
      const { positionX, positionY, scale } = inst.instance.transformState
      const c = el.getBoundingClientRect(), k = flight.scale / scale
      return new DOMRect(c.left + flight.x + (r.left - c.left - positionX) * k, c.top + flight.y + (r.top - c.top - positionY) * k, r.width * k, r.height * k)
    }
    // a page that reloads itself when its canvas comes back (spec 28 A1.11) opens where the person was looking
    const unkeep = keepOverResume(() => {
      const t = ref.current?.instance.transformState
      return t ? { board: useStore.getState().board, camera: { x: t.positionX, y: t.positionY, scale: t.scale } } : {}
    })
    canvasCtl.view = () => {
      const el = wrap(), inst = ref.current
      if (!el || !inst) return null
      const { positionX, positionY, scale } = inst.instance.transformState
      return { x: -positionX / scale, y: -positionY / scale, w: el.clientWidth / scale, h: el.clientHeight / scale }
    }
    canvasCtl.holdView = () => {
      heldView = null
      const el = wrap(), inst = ref.current
      // a camera already in flight (a fit, a zoom) lands where it was sent; a pan in progress is
      // the human's own motion - neither is ours to correct
      if (!el || !inst || inst.instance.animation || inst.instance.isPanning) return
      const held = anchorNode(useStore.getState(), inst.instance.transformState, el.clientWidth, el.clientHeight)
      if (!held) return
      heldView = held
      // the reflow commits before the next frame; an anchor nothing consumed must never steer a later change
      requestAnimationFrame(() => { if (heldView === held) heldView = null })
    }
    return unkeep
  }, [])

  // first load opens on the whole board (same as ⇧1) - the default 100% transform is an
  // arbitrary top-left crop. A deep link with a selection (#/b/x?n=..., or by frame id
  // ?f=scene/frame, or a whole scene ?s=scene) restores it and fits the camera to it instead. Runs once, on the first frame batch; board switches
  // refit through their own path.
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current || nodes.length === 0) return
    let revealed = false
    booted.current = true
    // the page before this one reloaded itself when its canvas came back: its camera, on the board it showed
    const board = useStore.getState().board
    const carried = resumed?.camera && resumed.board === board ? resumed.camera : null
    // else the camera this board was left at (A2.9) - a link naming a selection fits it instead, unless the app
    // reloaded this tab after a crash
    const named = !!(bootHash.n?.length || bootHash.f?.length || bootHash.s?.length)
    const cam = carried ?? (!named || APP_REOPEN ? savedCamera(board) : null)
    const fit = () => {
      const keys = linkTargets(bootHash, useStore.getState().nodes)
      if (keys.length) {
        useStore.setState({ selection: keys })
        const st = useStore.getState()   // a link opened is a look (marks not in yet: their first load acknowledges it)
        st.look(keys)
      }
      const el = document.querySelector('.sh-canvas') as HTMLElement | null
      if (cam && el && ref.current) {
        recorder.placed({ x: -cam.x / cam.scale, y: -cam.y / cam.scale, w: el.clientWidth / cam.scale, h: el.clientHeight / cam.scale })
        fly(cam.x, cam.y, cam.scale, 0)
      } else if (keys.length) {
        canvasCtl.fitNodes(keys)
      } else {
        canvasCtl.fitAll()
        // a link naming a frame this board does not show follows the frame where it lives
        if (bootHash.f?.length && !revealed) { revealed = true; void revealFrame(bootHash.f[0]) }
      }
    }
    requestAnimationFrame(() => {
      fit()
      // published builds boot fast enough that rzpp's own init can land AFTER this fit
      // and stomp it back to the identity transform - one verification pass re-fits
      setTimeout(() => {
        const st = ref.current?.instance.transformState
        if (st && st.scale === 1 && st.positionX === 0 && st.positionY === 0) fit()
      }, 150)
    })
  }, [nodes])

  // click on empty canvas = deselect + exit interact (Figma convention; also covers the
  // double-click-outside exit). Bound on the wrapper, NOT #sh-world - the world element is
  // 1px by design, so empty-canvas clicks never hit it.
  useEffect(() => {
    const el = document.querySelector('.sh-canvas') as HTMLElement | null
    if (!el) return
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      // anywhere on the canvas, a frame too: the panel closes and its tile lets go - except on a comment's
      // own controls (its pin, its card, its reply): opening one closes the panel there and keeps the
      // tile when the thread is its own (JamSurface)
      if (!t?.closest('.cm-layer, .cm-card, .cm-pin, .cm-stack')) letGoOfTile()
      if (t?.closest('.sh-node') || t?.closest('.sh-gcaption')) return
      const s = useStore.getState()
      if (s.selection.length || s.interact) s.select(null)
    }
    el.addEventListener('pointerdown', down)
    return () => el.removeEventListener('pointerdown', down)
  }, [])

  // scroll anchoring, the commit half (holdView above): in the SAME commit that moved the nodes,
  // before paint, shift the camera by the held node's displacement - it never visibly moves
  useLayoutEffect(() => {
    const held = heldView
    if (!held) return
    heldView = null
    const inst = ref.current
    const n = nodes.find((x) => x.key === held.key)
    if (!inst || !n || inst.instance.animation) return
    const { positionX, positionY, scale } = inst.instance.transformState
    const [x, y] = anchoredCamera(held, n, positionX, positionY, scale)
    if (x !== positionX || y !== positionY) inst.setTransform(x, y, scale, 0)
  }, [nodes])

  // B0.2: the shell is the SINGLE wheel-camera owner. rzpp's wheel-pan is disabled (below);
  // both entry paths - a shell-document wheel over the canvas, and a wheel forwarded from a
  // passive frame's iframe (sh:wheel) - feed one applyCanvasWheel. Plain wheel pans (mirrors
  // rzpp's old position-delta math); ctrl/meta wheel zooms about the cursor on an exponential
  // curve (constant ratio per finger distance - uniform feel at every zoom, unlike rzpp's
  // additive step). setTransform drives onTransformed, which repaints the grid.
  useEffect(() => {
    const app = document.querySelector('.sh-app') as HTMLElement | null
    const canvas = document.querySelector('.sh-canvas') as HTMLElement | null
    if (!app || !canvas) return
    let settle = 0
    const beginGesture = (panning: boolean) => {
      // sh-camera = a CANVAS pan/zoom (the image-LOD freeze signal); sh-gesturing also drops iframe
      // pointer-events. A frame click/drag sets only sh-gesturing.
      document.getElementById('sh-world')?.classList.add('sh-gesturing', 'sh-camera')
      document.body.classList.toggle('sh-panning', panning)
      clearTimeout(settle)
      settle = window.setTimeout(() => {
        document.getElementById('sh-world')?.classList.remove('sh-gesturing', 'sh-camera')
        document.body.classList.remove('sh-panning')
      }, 160)
    }
    const applyCanvasWheel = (w: CanvasWheelInput) => {
      const inst = ref.current
      if (!inst || useStore.getState().play) return
      const { positionX, positionY, scale } = inst.instance.transformState
      const zooming = w.ctrlKey || w.metaKey
      beginGesture(!zooming)
      if (!zooming) { inst.setTransform(positionX - w.deltaX, positionY - w.deltaY, scale, 0, 'linear'); return }
      const f = Math.min(1.4, Math.max(1 / 1.4, Math.exp(-w.deltaY * 0.0075 * (CONFIG.zoomSpeed ?? 1))))
      const next = Math.min(2, Math.max(0.05, scale * f))
      if (next === scale) return
      const r = canvas.getBoundingClientRect()
      const cx = w.clientX - r.left, cy = w.clientY - r.top
      const k = next / scale
      inst.setTransform(cx - (cx - positionX) * k, cy - (cy - positionY) * k, next, 0, 'linear')
    }
    canvasCtl.wheel = applyCanvasWheel
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.('.sh-canvas')) return
      if (t.closest('[data-sh-wheel-local]')) return   // escape hatch for scrollable shell UI in-canvas
      e.preventDefault()
      e.stopImmediatePropagation()
      applyCanvasWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey, metaKey: e.metaKey, clientX: e.clientX, clientY: e.clientY })
    }
    app.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => { canvasCtl.wheel = () => {}; app.removeEventListener('wheel', onWheel, { capture: true }); clearTimeout(settle) }
  }, [])

  // space-pan: hold space, drag anywhere - nodes drop pointer-events so the canvas takes the drag
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target as HTMLElement
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      e.preventDefault()
      document.body.classList.add('sh-space')
    }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') document.body.classList.remove('sh-space') }
    const drop = () => document.body.classList.remove('sh-space')
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', drop)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', drop)
    }
  }, [])

  const camera = (on: boolean) => {
    document.getElementById('sh-world')?.classList[on ? 'add' : 'remove']('sh-gesturing', 'sh-camera')
  }
  const pan = (on: boolean) => () => {
    camera(on)
    document.body.classList[on ? 'add' : 'remove']('sh-panning')
  }
  const zoom = (on: boolean) => () => camera(on)

  // no initialPosition props on the wrapper: rzpp applies them ASYNC after mount and
  // stomps the boot fit when data is inlined (published builds) - the boot fit owns
  // the first camera, and until it lands the default (0,0,1) is a known sentinel
  return (
    <TransformWrapper
      ref={ref}
      minScale={0.05}
      maxScale={5}
      limitToBounds={false}
      doubleClick={{ disabled: true }}
      // wheelDisabled is load-bearing: rzpp's onWheelPanning is a no-op without it, and
      // ctrlKey wheels (pinch, ctrl/cmd+scroll via the rewrite above) still zoom
      // wheelDisabled is load-bearing: rzpp's onWheelPanning is a no-op without it.
      // ctrl/meta wheel zoom never reaches rzpp (exponential curve above); pinch.step
      // only serves real touch-screen pinch.
      wheel={{ wheelDisabled: true, step: 0.225 * (CONFIG.zoomSpeed ?? 1) }}
      // B0.2: rzpp no longer owns wheel-pan (the shell's applyCanvasWheel does, so it works
      // over passive frames and forwarded from iframes too). excluded still governs pointer-drag.
      panning={{ wheelPanning: false, velocityDisabled: true, excluded: ['sh-no-pan'], disabled: gesture }}
      pinch={{ step: 7.5 * (CONFIG.zoomSpeed ?? 1) }}
      onPanningStart={pan(true)}
      onPanningStop={pan(false)}
      onZoomStart={zoom(true)}
      onZoomStop={zoom(false)}
      // B0.1: the grid repaints live via CSS vars (no React), but the store scale - which
      // only the zoom-% badge reads - commits after the transform SETTLES, so no React
      // re-render happens per tick during a pan/zoom.
      onTransformed={(r) => {
        paintGrid(r.state.positionX, r.state.positionY, r.state.scale)
        setCameraScale(r.state.scale)   // keep the LOD's settle-scale current (cheap number write, no React)
        if (booted.current) keepCamera(r.state.positionX, r.state.positionY, r.state.scale)   // over a reload (A2.9)
        clearTimeout(scaleTimer.current)
        scaleTimer.current = window.setTimeout(() => setScale(r.state.scale), 120)
      }}
      onInit={(r) => paintGrid(r.state.positionX, r.state.positionY, r.state.scale)}
    >
      <TransformComponent wrapperClass="sh-canvas" contentClass="sh-content">
        <div id="sh-world">
          <GroupCaptions />
          {nodes.map((n) => <FrameNode key={n.key} node={n} />)}
        </div>
      </TransformComponent>
    </TransformWrapper>
  )
}
