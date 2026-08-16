import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'
import { CONFIG, useStore } from '../store.ts'
import { bootHash } from '../hash.ts'
import { startPerf } from '../perf.ts'
import { startDiag } from '../diag.ts'
import { POOL, setVisible, onSnapshotAdmitted } from './lifecycle.ts'
import { onAdmit } from './snapshots.ts'
import { FrameNode, HEADER } from './FrameNode.tsx'

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
function insets(el: HTMLElement) {
  const c = el.getBoundingClientRect()
  const rect = (q: string) => document.querySelector(q)?.getBoundingClientRect()
  const side = rect('.sh-panel:not(.closed)') ?? rect('.sh-fab')
  const pill = rect('.sh-pill')
  return {
    left: (side ? Math.max(0, side.right - c.left) : 0) + GAP,
    right: GAP + 16,
    top: (pill ? Math.max(0, pill.bottom - c.top) : 0) + 12 + BAR,
    bottom: GAP + 16,
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
  const el = document.querySelector('.sh-canvas') as HTMLElement | null
  if (!el) return
  let step = GRID * scale
  while (step < 14) step *= 2
  while (step >= 28) step /= 2
  const t = (step - 14) / 14
  el.style.setProperty('--grid-size', `${step}px ${step}px`)
  el.style.setProperty('--grid-pos', `${positionX % step}px ${positionY % step}px`)
  el.style.setProperty('--grid-alpha', (0.35 + 0.65 * Math.min(1, t)).toFixed(3))
  // screen-space overlays (selection bar) position themselves from these - no re-render per frame
  const app = document.querySelector('.sh-app') as HTMLElement | null
  if (app) {
    app.style.setProperty('--sh-s', String(scale))
    app.style.setProperty('--sh-inv', String(1 / scale))   // world-units-per-screen-px, for zoom-invariant strokes
    app.style.setProperty('--sh-tx', `${positionX}px`)
    app.style.setProperty('--sh-ty', `${positionY}px`)
  }
  cull(positionX, positionY, scale)
}

/**
 * Viewport culling (the tldraw/Figma recipe, and codex's #1-2 fix for the whole-viewport white
 * flash): a frame OFF the screen still renders + rasterises its iframe layer at the current zoom
 * scale. Zoom into one frame and Chrome is still re-rastering the other ~14 at that scale every
 * tick - the tile/GPU-memory budget starves and it draws blank (white) tiles across the whole
 * compositor. So we mark off-screen nodes `data-cull` and CSS `content-visibility: hidden` makes
 * Chrome SKIP their rendering entirely (state preserved, no reload). Screen rect is pure math from
 * the node's world box + the live transform (no getBoundingClientRect = no forced layout). A half-
 * viewport overscan keeps frames just past the edge live so panning never pops. DOM is touched only
 * when a node actually crosses the boundary, so a settled board writes nothing per frame.
 */
const culled = new Set<string>()
function cull(px: number, py: number, scale: number) {
  const vw = window.innerWidth, vh = window.innerHeight
  const mx = vw * 0.5, my = vh * 0.5                       // overscan: half a screen each side
  for (const n of useStore.getState().nodes) {
    const sx = px + n.x * scale, sy = py + n.y * scale
    const sw = n.w * scale, sh = (n.h + HEADER) * scale
    const off = sx + sw < -mx || sx > vw + mx || sy + sh < -my || sy > vh + my
    if (off === culled.has(n.key)) continue               // no state change - touch nothing
    if (off) culled.add(n.key); else culled.delete(n.key)
    const el = document.querySelector(`[data-node="${CSS.escape(n.key)}"]`) as HTMLElement | null
    if (el) el.toggleAttribute('data-cull', off)
    if (POOL) setVisible(n.key, !off)                     // M6: feed on-screen visibility to the lifecycle coordinator
  }
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

/** B0.2: one wheel event, whatever its origin - a shell-document wheel over the canvas, or
 *  a wheel forwarded from a passive frame's iframe. clientX/Y are shell-viewport pixels. */
export interface CanvasWheelInput {
  deltaX: number; deltaY: number; deltaMode: number
  ctrlKey: boolean; metaKey: boolean; clientX: number; clientY: number
}

export const canvasCtl = {
  fitNode(_key: string) {},
  fitNodes(_keys: string[]) {},
  fitAll() {},
  zoomTo(_scale: number) {},
  zoom100() { canvasCtl.zoomTo(1) },
  wheel(_input: CanvasWheelInput) {},
}

/** Variant-group captions (SPEC-023 §4): "Landing · 3 variants" above each group with
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
  const scaleTimer = useRef(0)
  const camTimer = useRef(0)

  useEffect(() => { startPerf(); startDiag(); if (POOL) onAdmit(onSnapshotAdmitted) }, [])   // B0.4: samplers + M6 snapshot→lifecycle admit hook
  // re-cull when the node set changes (new frames, moves) even if the camera hasn't moved
  useEffect(() => {
    const st = ref.current?.instance.transformState
    if (st) cull(st.positionX, st.positionY, st.scale)
  }, [nodes])
  // never leave the camera flag (or its pending timer) behind if the canvas unmounts mid-move
  useEffect(() => () => { clearTimeout(camTimer.current); document.body.classList.remove('sh-cam') }, [])

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
        // clamp order matters: left/top win when the band is tighter than the content
        px = Math.max(Math.min((vw - w * scale) / 2, vw - p.right - w * scale), p.left)
        py = Math.max(Math.min((vh - h * scale) / 2, vh - p.bottom - h * scale), p.top)
      }
      ref.current.setTransform(px - x * scale, py - y * scale, scale, 320, 'easeOut')
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
      fitRect(x0, y0, x1 - x0, y1 - y0, focus)
    }
    canvasCtl.fitNode = (key: string) => fitKeys([key], true)
    canvasCtl.fitNodes = (keys: string[]) => fitKeys(keys, true)
    canvasCtl.fitAll = () => fitKeys(useStore.getState().nodes.map((n) => n.key), false)
    canvasCtl.zoomTo = (target: number) => {
      const el = wrap(), inst = ref.current
      if (!el || !inst) return
      const { positionX, positionY, scale } = inst.instance.transformState
      const cx = el.clientWidth / 2, cy = el.clientHeight / 2
      const k = target / scale   // zoom about the viewport center
      inst.setTransform(cx - (cx - positionX) * k, cy - (cy - positionY) * k, target, 250, 'easeOut')
    }
  }, [])

  // first load opens on the whole board (same as ⇧1) - the default 100% transform is an
  // arbitrary top-left crop. A deep link with a selection (#/b/x?n=...) restores it and
  // fits the camera to it instead. Runs once, on the first frame batch; board switches
  // refit through their own path.
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current || nodes.length === 0) return
    booted.current = true
    const fit = () => {
      const keys = (bootHash.n ?? []).filter((k) => useStore.getState().nodes.some((n) => n.key === k))
      if (keys.length) {
        useStore.setState({ selection: keys })
        canvasCtl.fitNodes(keys)
      } else canvasCtl.fitAll()
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
      if (t?.closest('.sh-node') || t?.closest('.sh-gcaption')) return
      const s = useStore.getState()
      if (s.selection.length || s.interact) s.select(null)
    }
    el.addEventListener('pointerdown', down)
    return () => el.removeEventListener('pointerdown', down)
  }, [])

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
      // sh-camera = a CANVAS pan/zoom (drives the snapshot cover); sh-gesturing also drops iframe
      // pointer-events. A frame click/drag sets only sh-gesturing, so it never flashes a snapshot.
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
      maxScale={2}
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
        // camera-active flag for EVERY transform path. rzpp fires onZoomStart/Stop ONLY for its
        // own wheel/pinch/pan; programmatic setTransform (toolbar zoom, fit, device preset, board
        // switch, boot fit) never triggers them, so the flash fixes below - if keyed off the
        // gesture callbacks - would miss every button-driven camera move. onTransformed fires for
        // all of them. Debounced off 180ms after the LAST transform = one uniform settle for every
        // path (no instant blur-back pop). The flash-fix CSS keys off body.sh-cam.
        document.body.classList.add('sh-cam')
        clearTimeout(camTimer.current)
        camTimer.current = window.setTimeout(() => document.body.classList.remove('sh-cam'), 180)
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
