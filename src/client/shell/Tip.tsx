import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** shadcn-style tooltip: snappy (150ms in, instant out), contrast-flipped, zoom-fade.
 *  Portaled to the app root - glass never nests, and neither do overlays. `inv` pins the
 *  flipped (light) bubble for surfaces with fixed dark chrome (play mode), where the
 *  theme-following default would sit dark-on-dark. */
export function Tip({ label, side = 'top', inv = false, children }: { label: ReactNode; side?: 'top' | 'bottom'; inv?: boolean; children: ReactElement }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = side === 'top' ? r.top - 7 : r.bottom + 7
    timer.current = window.setTimeout(() => setPos({ x: r.left + r.width / 2, y }), 150)
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
    const r = el.getBoundingClientRect()
    const over = r.right - (window.innerWidth - 8)
    if (over > 0) el.style.marginLeft = `${-over}px`
    else if (r.left < 8) el.style.marginLeft = `${8 - r.left}px`
  }, [pos])
  return (
    <>
      {cloneElement(child, {
        onMouseEnter: (e: React.MouseEvent) => { child.props.onMouseEnter?.(e); show(e) },
        onMouseLeave: (e: React.MouseEvent) => { child.props.onMouseLeave?.(e); hide() },
        onClick: (e: React.MouseEvent) => { child.props.onClick?.(e); hide() },
      })}
      {pos && app && createPortal(
        <div ref={tipRef} className={`sh-tip${side === 'bottom' ? ' below' : ''}${inv ? ' inv' : ''}`} style={{ left: pos.x, top: pos.y }}>{label}</div>,
        app,
      )}
    </>
  )
}
