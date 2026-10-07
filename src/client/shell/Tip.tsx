import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** shadcn-style tooltip: snappy (150ms in, instant out), contrast-flipped, zoom-fade.
 *  Portaled to the app root - glass never nests, and neither do overlays. `inv` pins the
 *  flipped (light) bubble for surfaces with fixed dark chrome (play mode), where the
 *  theme-following default would sit dark-on-dark. */
export function Tip({ label, side = 'top', inv = false, children }: { label: ReactNode; side?: 'top' | 'bottom' | 'right'; inv?: boolean; children: ReactElement }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // right: beside the trigger, centred on it - a sidebar row's glyph, read toward the canvas
    const at = side === 'right' ? { x: r.right + 9, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: side === 'top' ? r.top - 7 : r.bottom + 7 }
    timer.current = window.setTimeout(() => setPos(at), 150)
  }
  const hide = () => { window.clearTimeout(timer.current); setPos(null) }
  const app = document.querySelector('.sh-app')
  const child = children as ReactElement<any>
  // clamp into the viewport: edge-of-screen triggers (play button) otherwise clip
  const tipRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!el) return
    el.style.marginLeft = '0px'
    el.style.marginTop = '0px'
    if (!pos) return
    // the box it settles into, from its unscaled size - not the rect mid-animation (scaled .95, it
    // reads smaller than it lands): top centres above, below centres under, right centres beside
    const w = el.offsetWidth, h = el.offsetHeight
    const left = side === 'right' ? pos.x : pos.x - w / 2
    const top = side === 'right' ? pos.y - h / 2 : side === 'top' ? pos.y - h : pos.y
    const r = { left, right: left + w, top, bottom: top + h }
    const over = r.right - (window.innerWidth - 8)
    if (over > 0) el.style.marginLeft = `${-over}px`
    else if (r.left < 8) el.style.marginLeft = `${8 - r.left}px`
    // and up and down: a tall tip beside a row near the bottom (a status and its evidence) stays whole
    const below = r.bottom - (window.innerHeight - 8)
    if (below > 0) el.style.marginTop = `${-below}px`
    else if (r.top < 8) el.style.marginTop = `${8 - r.top}px`
  }, [pos])
  // a tip is placed once, where its trigger was: anything that scrolls under it puts it away
  useLayoutEffect(() => {
    if (!pos) return
    const away = () => hide()
    window.addEventListener('scroll', away, true)
    window.addEventListener('resize', away)
    return () => { window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away) }
  }, [pos])
  return (
    <>
      {cloneElement(child, {
        onMouseEnter: (e: React.MouseEvent) => { child.props.onMouseEnter?.(e); show(e) },
        onMouseLeave: (e: React.MouseEvent) => { child.props.onMouseLeave?.(e); hide() },
        onClick: (e: React.MouseEvent) => { child.props.onClick?.(e); hide() },
      })}
      {pos && app && createPortal(
        <div ref={tipRef} className={`sh-tip${side === 'bottom' ? ' below' : side === 'right' ? ' right' : ''}${inv ? ' inv' : ''}`} style={{ left: pos.x, top: pos.y }}>{label}</div>,
        app,
      )}
    </>
  )
}
