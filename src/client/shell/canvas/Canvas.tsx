import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'
import { useStore } from '../store.ts'
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

// fit padding leaves the context bar above a frame and breathing room around it visible
const PAD = { x: 96, top: 116, bottom: 72 }

export const canvasCtl = {
  fitNode(_key: string) {},
  fitAll() {},
  zoom100() {},
}

export function Canvas() {
  const nodes = useStore((s) => s.nodes)
  const gesture = useStore((s) => s.gesture)
  const setScale = useStore((s) => s.setScale)
  const select = useStore((s) => s.select)
  const ref = useRef<ReactZoomPanPinchContentRef>(null)

  useEffect(() => {
    const wrap = () => document.querySelector('.sh-canvas') as HTMLElement | null
    const fitRect = (x: number, y: number, w: number, h: number) => {
      const el = wrap()
      if (!el || !ref.current) return
      const vw = el.clientWidth, vh = el.clientHeight
      const scale = Math.max(0.05, Math.min(1, (vw - PAD.x * 2) / w, (vh - PAD.top - PAD.bottom) / h))
      ref.current.setTransform(
        (vw - w * scale) / 2 - x * scale,
        PAD.top + (vh - PAD.top - PAD.bottom - h * scale) / 2 - y * scale,
        scale, 320, 'easeOut',
      )
    }
    canvasCtl.fitNode = (key: string) => {
      const n = useStore.getState().nodes.find((x) => x.key === key)
      if (n) fitRect(n.x, n.y, n.w, n.h + HEADER)
    }
    canvasCtl.fitAll = () => {
      const ns = useStore.getState().nodes
      if (!ns.length) return
      const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y))
      const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h + HEADER))
      fitRect(x0, y0, x1 - x0, y1 - y0)
    }
    canvasCtl.zoom100 = () => {
      const el = wrap(), inst = ref.current
      if (!el || !inst) return
      const { positionX, positionY, scale } = inst.instance.transformState
      const cx = el.clientWidth / 2, cy = el.clientHeight / 2
      inst.setTransform(cx - (cx - positionX) / scale, cy - (cy - positionY) / scale, 1, 250, 'easeOut')
    }
  }, [])

  // cmd+scroll = zoom on mac: rzpp only zooms on ctrlKey wheels (that is how trackpad pinch
  // arrives), so meta-wheels are rewritten into ctrl-wheels before rzpp sees them
  useEffect(() => {
    const el = document.querySelector('.sh-canvas') as HTMLElement | null
    if (!el) return
    const rewrite = (e: WheelEvent) => {
      if (!e.metaKey || e.ctrlKey) return
      e.preventDefault()
      e.stopImmediatePropagation()
      el.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true,
        deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
        clientX: e.clientX, clientY: e.clientY,
      }))
    }
    el.addEventListener('wheel', rewrite, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', rewrite, { capture: true })
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
      wheel={{ wheelDisabled: true, step: 0.15 }}
      panning={{ wheelPanning: true, velocityDisabled: true, excluded: ['sh-no-pan'], disabled: gesture }}
      pinch={{ step: 5 }}
      onPanningStart={pan(true)}
      onPanningStop={pan(false)}
      onZoomStart={zoom(true)}
      onZoomStop={zoom(false)}
      onTransformed={(r) => setScale(r.state.scale)}
    >
      <TransformComponent wrapperClass="sh-canvas" contentClass="sh-content">
        <div id="sh-world" onPointerDown={(e) => { if (e.target === e.currentTarget) select(null) }}>
          {nodes.map((n) => <FrameNode key={n.key} node={n} />)}
        </div>
      </TransformComponent>
    </TransformWrapper>
  )
}
