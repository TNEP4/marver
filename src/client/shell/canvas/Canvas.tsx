import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContentRef } from 'react-zoom-pan-pinch'
import { useStore } from '../store.ts'
import { FrameNode } from './FrameNode.tsx'

/**
 * The world. rzpp owns pan/zoom; nodes are absolutely positioned children of #sh-world.
 * Iframe laws: render order = store order (append-only, never sorted); will-change only during
 * gestures (G-3); iframes lose pointer-events during any gesture (G-4).
 */
export function Canvas() {
  const nodes = useStore((s) => s.nodes)
  const setScale = useStore((s) => s.setScale)
  const select = useStore((s) => s.select)
  const ref = useRef<ReactZoomPanPinchContentRef>(null)

  // expose pan-to-node for goto/sidebar (module-level registry keeps App simple)
  useEffect(() => {
    panTo.current = (nodeKey: string) => {
      const el = document.querySelector(`[data-node="${nodeKey}"]`) as HTMLElement | null
      if (el && ref.current) ref.current.zoomToElement(el, undefined, 300)
    }
  }, [])

  return (
    <TransformWrapper
      ref={ref}
      minScale={0.05}
      maxScale={2}
      initialPositionX={230}
      initialPositionY={24}
      limitToBounds={false}
      doubleClick={{ disabled: true }}
      wheel={{ activationKeys: ['Control', 'Meta'], step: 0.15 }}
      panning={{ wheelPanning: true, velocityDisabled: true, excluded: ['sh-no-pan'] }}
      pinch={{ step: 5 }}
      onPanningStart={() => document.getElementById('sh-world')?.classList.add('sh-gesturing')}
      onPanningStop={() => document.getElementById('sh-world')?.classList.remove('sh-gesturing')}
      onZoomStart={() => document.getElementById('sh-world')?.classList.add('sh-gesturing')}
      onZoomStop={() => document.getElementById('sh-world')?.classList.remove('sh-gesturing')}
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

export const panTo = { current: (_key: string) => {} }
