/**
 * The drawing's tool bar (spec 38, option 2): lock, hand | the tools | ⋯ | then, on the canvas, Copy path and Copy as
 * image (as the frame selection bar ends), in play the collapse button. The ⋯ holds the tools the bar leaves out, then
 * the drawing's own actions. Glass, constant size; the bar wears the selection bar's glow in the drawing purple.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DrawState, DrawTool } from '../../../shared/draw-protocol.ts'
import { ImagesSquareIcon, PanelFilledIcon, ParallelogramFillIcon, SignpostIcon, CheckIcon } from '../icons.tsx'
import { HoverTip, MI, MAIN_TOOLS, MORE_TOOLS, Ph, TOOL, type TipSide } from './kit.tsx'
import { drawSend, type DrawLink } from './link.ts'

export function DrawBar({ link, state, tools, mode, tipSide, menuSide = 'below', style, cam, onCopyPath, onCopyImage, onExport, onCollapse, onHideUI, onBack, copied }: {
  link: DrawLink
  state: DrawState | undefined
  tools: DrawTool[]
  mode: 'canvas' | 'play'
  tipSide?: TipSide
  menuSide?: 'below' | 'above'
  style?: CSSProperties
  /** placed from the camera's variables (the canvas) */
  cam?: boolean
  onCopyPath?: () => void
  onCopyImage?: () => void
  onExport: (kind: 'png' | 'pdf') => void
  onCollapse?: () => void
  onHideUI?: () => void
  onBack?: () => void
  copied?: 'path' | 'image' | null
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // the ⋯ closes on a click elsewhere, Escape, or a pick
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('pointerdown', off, true); addEventListener('keydown', key, true)
    return () => { removeEventListener('pointerdown', off, true); removeEventListener('keydown', key, true) }
  }, [open])
  const editable = !!state?.editable
  const tool = state?.tool ?? 'selection'
  const side: TipSide = tipSide ?? (mode === 'canvas' ? 'top' : 'bottom')
  const inMore = !tools.includes(tool) && tool !== 'selection' ? tool : null
  const pick = (t: DrawTool) => { drawSend(link, { op: 'tool', tool: t }); setOpen(false) }
  const btn = (id: DrawTool | 'more', on: boolean, onClick: () => void, icon?: ReactNode, cls = '') => (
    <HoverTip key={id} label={TOOL[id].label} keys={TOOL[id].key} side={side}>
      <button className={`dk-b${on ? ' on' : ''}${cls}`} aria-label={TOOL[id].label} disabled={!editable && id !== 'hand' && id !== 'more'} onClick={onClick}>{icon ?? TOOL[id].icon}</button>
    </HoverTip>
  )
  const left = MAIN_TOOLS.filter((t) => !tools.includes(t))
  const more = MORE_TOOLS.filter((t) => !tools.includes(t))
  const menuPos: CSSProperties = menuSide === 'below' ? { top: 'calc(100% + 6px)', right: 0 } : { bottom: 'calc(100% + 6px)', right: 0 }
  return (
    <div ref={ref} className={`dk-anchor${cam ? ' dk-cam' : ''}`} style={{ zIndex: open ? 45 : 30, ...style }}>
      <div className={`dk-glass dk-tools h${mode === 'canvas' ? ' sh-ctx dk-ctx dk-draw' : ''}`}>
        <HoverTip label={state?.locked ? 'Keep tool active - on' : 'Keep tool active'} keys="Q" side={side}>
          <button className={`dk-b lock${state?.locked ? ' on' : ''}`} aria-label="Keep tool active" disabled={!editable} onClick={() => drawSend(link, { op: 'lock' })}>
            <Ph n={state?.locked ? 'LockSimple' : 'LockSimpleOpen'} size={16} />
          </button>
        </HoverTip>
        {tools.includes('hand') && btn('hand', tool === 'hand', () => pick('hand'))}
        <i className="dk-sep" />
        {tools.filter((t) => t !== 'hand').map((t) => btn(t, tool === t, () => pick(t)))}
        {btn('more', !!inMore || open, () => setOpen((o) => !o), inMore ? TOOL[inMore].icon : undefined)}
        {mode === 'canvas' && <>
          <i className="dk-sep" />
          <HoverTip label="Copy path" keys="⇧P" side={side}>
            <button className="dk-b" aria-label="Copy path" onClick={onCopyPath}>{copied === 'path' ? <CheckIcon size={16} /> : <SignpostIcon size={16} />}</button>
          </HoverTip>
          <HoverTip label="Copy as image" keys="⇧I" side={side}>
            <button className="dk-b" aria-label="Copy as image" onClick={onCopyImage}>{copied === 'image' ? <CheckIcon size={16} /> : <ImagesSquareIcon size={16} />}</button>
          </HoverTip>
        </>}
        {mode === 'play' && onCollapse && <>
          <i className="dk-sep" />
          <HoverTip label="Collapse toolbar" keys="⌘/" side={side}>
            <button className="dk-b" aria-label="Collapse toolbar" onClick={onCollapse}><PanelFilledIcon size={17} style={{ transform: 'rotate(90deg)' }} /></button>
          </HoverTip>
        </>}
      </div>
      {open && (
        <div className="sh-menu dk-menu" style={{ position: 'absolute', ...menuPos }}>
          {editable && left.map((t) => <MI key={t} icon={TOOL[t].icon} label={TOOL[t].label} k={TOOL[t].key} on={tool === t} onClick={() => pick(t)} />)}
          {editable && left.length > 0 && more.length > 0 && <div className="div" />}
          {editable && more.map((t) => <MI key={t} icon={TOOL[t].icon} label={TOOL[t].label} k={TOOL[t].key} on={tool === t} onClick={() => pick(t)} />)}
          {editable && <div className="div" />}
          {/* the drawing's own actions: History and Send to Marver arrive with their releases (spec 38: not in this one) */}
          <MI icon={<Ph n="ClockCounterClockwise" size={15} />} label="History" off />
          {mode === 'canvas' && <MI icon={<ParallelogramFillIcon size={13} />} label="Send to Marver" k="⇧⌘↵" mv off />}
          <MI icon={<Ph n="FilePng" size={15} />} label="Export as PNG" onClick={() => { setOpen(false); onExport('png') }} />
          <MI icon={<Ph n="FilePdf" size={15} />} label="Export as PDF" onClick={() => { setOpen(false); onExport('pdf') }} />
          {mode === 'play' && <MI icon={<ImagesSquareIcon size={15} />} label="Copy as image" k="⇧I" onClick={() => { setOpen(false); onCopyImage?.() }} />}
          {mode === 'play' && <>
            <div className="div" />
            <MI icon={<Ph n="EyeSlash" size={15} />} label="Hide all UI" k="H" onClick={() => { setOpen(false); onHideUI?.() }} />
            <MI icon={<Ph n="ArrowLeft" size={15} />} label="Back to the canvas" k="esc" onClick={() => { setOpen(false); onBack?.() }} />
          </>}
        </div>
      )}
    </div>
  )
}
