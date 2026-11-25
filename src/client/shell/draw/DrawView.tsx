/**
 * The drawing's own view controls (spec 38): − % + | fit · back to the frame's view [· map] | undo · redo. Inside the
 * frame's corner on the canvas (constant size), bottom right in play. The % opens the zoom menu - with the frame's
 * own view: go back to it, or make this view the frame's. The mini-map shows only while the drawing pans.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { DrawState } from '../../../shared/draw-protocol.ts'
import { FrameCornersIcon } from '../icons.tsx'
import { HoverTip, MI, Ph, ResetView, type TipSide } from './kit.tsx'
import { send, type DrawLink } from './link.ts'

export function DrawView({ link, state, size = 'sm', map, menuSide = 'top', tipSide = 'top', style }: {
  link: DrawLink; state: DrawState | undefined; size?: 'sm' | 'lg'; map?: boolean; menuSide?: 'top' | 'bottom'; tipSide?: TipSide; style?: CSSProperties
}) {
  const [menu, setMenu] = useState(false)
  const [mapOn, setMapOn] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false) }
    addEventListener('pointerdown', off, true)
    return () => removeEventListener('pointerdown', off, true)
  }, [menu])
  const s = size === 'lg' ? 16 : 14
  const editable = !!state?.editable
  const B = (label: string, key: string | undefined, icon: React.ReactNode, onClick: () => void, cls = '', disabled = false) => (
    <HoverTip key={label} label={label} keys={key} side={tipSide}><button className={`dk-b${cls}`} aria-label={label} disabled={disabled} onClick={onClick}>{icon}</button></HoverTip>
  )
  const zoom = Math.round((state?.zoom ?? 1) * 100)
  const view = (v: 'in' | 'out' | 'fit' | 'frame' | 'save' | 'reset') => { send(link, { op: 'view', v }); setMenu(false) }
  return (
    <div ref={ref} className="dk-anchor" style={{ zIndex: menu ? 45 : 30, ...style }}>
      <div className={`dk-glass dk-view dk-draw${size === 'lg' ? ' lg' : ''}`}>
        {B('Zoom out', '⌘−', <Ph n="Minus" size={s} />, () => view('out'))}
        {B('Zoom', undefined, <>{zoom}%</>, () => setMenu((m) => !m), ` pct${menu ? ' on' : ''}`)}
        {B('Zoom in', '⌘+', <Ph n="Plus" size={s} />, () => view('in'))}
        <i className="dk-sep" />
        {B('Fit the drawing', '⇧1', <FrameCornersIcon size={s} />, () => view('fit'))}
        {B('Back to the frame’s view', undefined, <ResetView size={s - 1} />, () => view('frame'), state?.offFrameView ? ' on' : '')}
        {map && B('Minimap', undefined, <Ph n="MapTrifold" size={s} />, () => setMapOn((m) => !m), mapOn ? ' on' : '')}
        {editable && <>
          <i className="dk-sep" />
          {B('Undo', '⌘Z', <Ph n="ArrowUUpLeft" size={s} />, () => send(link, { op: 'undo' }), '', !state?.canUndo)}
          {B('Redo', '⇧⌘Z', <Ph n="ArrowUUpRight" size={s} />, () => send(link, { op: 'redo' }), '', !state?.canRedo)}
        </>}
      </div>
      {menu && (
        <div className="sh-menu dk-menu" style={{ position: 'absolute', width: 224, ...(menuSide === 'top' ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }), right: 0 }}>
          <MI icon={<Ph n="Plus" size={14} />} label="Zoom in" k="⌘+" onClick={() => view('in')} />
          <MI icon={<Ph n="Minus" size={14} />} label="Zoom out" k="⌘−" onClick={() => view('out')} />
          <MI icon={<FrameCornersIcon size={14} />} label="Zoom to fit" k="⇧1" onClick={() => view('fit')} />
          <MI icon={<span className="z1">1:1</span>} label="Zoom to 100 %" k="⇧0" onClick={() => view('reset')} />
          <div className="div" />
          <MI icon={<ResetView size={13} />} label="Back to the frame’s view" onClick={() => view('frame')} />
          {editable && <MI icon={<Ph n="Crop" size={14} />} label="Use this view for the frame" onClick={() => view('save')} />}
        </div>
      )}
      {(state?.panning || mapOn) && state?.map && <MiniMap state={state} />}
    </div>
  )
}

/** The drawing's content and the current view, at a glance - above the controls, while the drawing pans. */
function MiniMap({ state }: { state: DrawState }) {
  const { content, view } = state.map
  const box = content ? { x: Math.min(content.x, view.x), y: Math.min(content.y, view.y), x2: Math.max(content.x + content.w, view.x + view.w), y2: Math.max(content.y + content.h, view.y + view.h) } : { x: view.x, y: view.y, x2: view.x + view.w, y2: view.y + view.h }
  const W = 132, k = W / Math.max(1, box.x2 - box.x), H = Math.max(40, Math.min(110, (box.y2 - box.y) * k))
  const r = (b: { x: number; y: number; w: number; h: number }): CSSProperties => ({ left: 6 + (b.x - box.x) * k, top: 6 + (b.y - box.y) * k, width: Math.max(2, b.w * k), height: Math.max(2, b.h * k) })
  return (
    <div className="dk-map" style={{ right: 0, bottom: 'calc(100% + 8px)', width: W + 12, height: H + 12 }}>
      {content && <i className="d" style={r(content)} />}
      <i className="v" style={r(view)} />
    </div>
  )
}
