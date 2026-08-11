import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'
import { CONFIG, useStore } from '../store.ts'
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

export const canvasCtl = {
  fitNode(_key: string) {},
  fitNodes(_keys: string[]) {},
  fitAll() {},
  zoomTo(_scale: number) {},
  zoom100() { canvasCtl.zoomTo(1) },
}

export function Canvas() {
  const nodes = useStore((s) => s.nodes)
  const gesture = useStore((s) => s.gesture)
  const setScale = useStore((s) => s.setScale)
  const ref = useRef<ReactZoomPanPinchContentRef>(null)

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
    canvasCtl.fitNode = (key: string) => {
      const n = useStore.getState().nodes.find((x) => x.key === key)
      if (n) fitRect(n.x, n.y, n.w, n.h + HEADER, true)
    }
    const fitKeys = (keys: string[], focus: boolean) => {
      const sel = new Set(keys)
      const ns = useStore.getState().nodes.filter((n) => sel.has(n.key))
      if (!ns.length) return
      const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y))
      const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h + HEADER))
      fitRect(x0, y0, x1 - x0, y1 - y0, focus)
    }
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
  // arbitrary top-left crop. Runs once, on the first frame batch; board switches refit
  // through their own path.
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current || nodes.length === 0) return
    booted.current = true
    requestAnimationFrame(() => canvasCtl.fitAll())
  }, [nodes])

  // click on empty canvas = deselect + exit interact (Figma convention; also covers the
  // double-click-outside exit). Bound on the wrapper, NOT #sh-world - the world element is
  // 1px by design, so empty-canvas clicks never hit it.
  useEffect(() => {
    const el = document.querySelector('.sh-canvas') as HTMLElement | null
    if (!el) return
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.sh-node')) return
      const s = useStore.getState()
      if (s.selection.length || s.interact) s.select(null)
    }
    el.addEventListener('pointerdown', down)
    return () => el.removeEventListener('pointerdown', down)
  }, [])

  // Zoom curve: rzpp's wheel zoom is ADDITIVE in scale - a constant scale amount per
  // pinch, which reads as sluggish when zoomed in and runaway when zoomed out (zoom is
  // perceptually logarithmic). So ctrl/meta wheels (trackpad pinch arrives as ctrl-wheel
  // in Chrome; cmd+scroll folds in too) are intercepted on an ANCESTOR of the wrapper -
  // guaranteed to run before rzpp's own listener - and applied as an exponential step:
  // constant ratio per finger distance, uniform feel at every zoom level.
  useEffect(() => {
    const app = document.querySelector('.sh-app') as HTMLElement | null
    const el = document.querySelector('.sh-canvas') as HTMLElement | null
    if (!app || !el) return
    let settle = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (!(e.target as HTMLElement | null)?.closest?.('.sh-canvas')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const inst = ref.current
      if (!inst) return
      const { positionX, positionY, scale } = inst.instance.transformState
      // exponent scales with input; per-event ratio capped so a discrete mouse-wheel
      // notch (|deltaY| ~100) stays controllable while trackpad streams pass through
      const f = Math.min(1.4, Math.max(1 / 1.4, Math.exp(-e.deltaY * 0.0075 * (CONFIG.zoomSpeed ?? 1))))
      const next = Math.min(2, Math.max(0.05, scale * f))
      if (next === scale) return
      const k = next / scale
      const r = el.getBoundingClientRect()
      const cx = e.clientX - r.left, cy = e.clientY - r.top
      // rzpp's zoom callbacks never fire on setTransform - manage the gesture class here
      document.getElementById('sh-world')?.classList.add('sh-gesturing')
      clearTimeout(settle)
      settle = window.setTimeout(() => document.getElementById('sh-world')?.classList.remove('sh-gesturing'), 160)
      inst.setTransform(cx - (cx - positionX) * k, cy - (cy - positionY) * k, next, 0, 'linear')
    }
    app.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => { app.removeEventListener('wheel', onWheel, { capture: true }); clearTimeout(settle) }
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

  const pan = (on: boolean) => () => {
    document.getElementById('sh-world')?.classList[on ? 'add' : 'remove']('sh-gesturing')
    document.body.classList[on ? 'add' : 'remove']('sh-panning')
  }
  const zoom = (on: boolean) => () =>
    document.getElementById('sh-world')?.classList[on ? 'add' : 'remove']('sh-gesturing')

  return (
    <TransformWrapper
      ref={ref}
      minScale={0.05}
      maxScale={2}
      initialPositionX={290}
      initialPositionY={90}
      limitToBounds={false}
      doubleClick={{ disabled: true }}
      // wheelDisabled is load-bearing: rzpp's onWheelPanning is a no-op without it, and
      // ctrlKey wheels (pinch, ctrl/cmd+scroll via the rewrite above) still zoom
      // wheelDisabled is load-bearing: rzpp's onWheelPanning is a no-op without it.
      // ctrl/meta wheel zoom never reaches rzpp (exponential curve above); pinch.step
      // only serves real touch-screen pinch.
      wheel={{ wheelDisabled: true, step: 0.225 * (CONFIG.zoomSpeed ?? 1) }}
      panning={{ wheelPanning: true, velocityDisabled: true, excluded: ['sh-no-pan'], disabled: gesture }}
      pinch={{ step: 7.5 * (CONFIG.zoomSpeed ?? 1) }}
      onPanningStart={pan(true)}
      onPanningStop={pan(false)}
      onZoomStart={zoom(true)}
      onZoomStop={zoom(false)}
      onTransformed={(r) => { setScale(r.state.scale); paintGrid(r.state.positionX, r.state.positionY, r.state.scale) }}
      onInit={(r) => paintGrid(r.state.positionX, r.state.positionY, r.state.scale)}
    >
      <TransformComponent wrapperClass="sh-canvas" contentClass="sh-content">
        <div id="sh-world">
          {nodes.map((n) => <FrameNode key={n.key} node={n} />)}
        </div>
      </TransformComponent>
    </TransformWrapper>
  )
}
