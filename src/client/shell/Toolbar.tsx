/**
 * Shared top-right toolbar pieces (prototype-review Phase 1). The canvas pill and the
 * prototype pill render the SAME controls so they never drift: laser / comment buttons
 * (store-level, zero coupling), a Hide-UI toggle (one shared body class), and controlled
 * Device / Theme dropdowns whose wiring stays local to each surface (canvas mutates
 * selection/board; play mutates play.device/theme). usePopover + Popover live here too so
 * both App and Play share the popover chrome.
 */
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore, CONFIG, cap } from './store.ts'
import { useComments } from './comments-store.ts'
import { Tip } from './Tip.tsx'
import { CaretIcon, CheckIcon, CommentIcon, DevicesIcon, EyeSlashIcon, FrameCornersIcon, LaserIcon, MoonIcon, SunIcon, deviceIcon } from './icons.tsx'

const commentsStore = () => useComments.getState()

/** Shared popover machinery: trigger position, outside-click close, portal to the app
 *  root (glass never nests - a nested backdrop-filter cannot sample the page). */
export function usePopover() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const toggle = () => {
    if (!open && boxRef.current) {
      const r = boxRef.current.getBoundingClientRect()
      setPos({ left: r.left, top: r.bottom + 10 })
    }
    setOpen(!open)
  }
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      const t = e.target as globalThis.Node
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  return { open, setOpen, pos, boxRef, menuRef, toggle }
}

export function Popover({ pop, children, dark }: { pop: ReturnType<typeof usePopover>; children: ReactNode; dark?: boolean }) {
  const app = document.querySelector('.sh-app')
  if (!pop.open || !app) return null
  return createPortal(
    <div className={`sh-menu${dark ? ' sh-menu-dark' : ''}`} ref={pop.menuRef} style={{ left: pop.pos.left, top: pop.pos.top }}>{children}</div>,
    app,
  )
}

// ---- Hide UI: one shared, binary body class (canvas + prototype) ---------------------
// The state IS the body class - one source of truth for both pills, so they can never
// desync. Not persisted, so a page refresh always restores the chrome (the safety net
// for a forgotten shortcut). toggleHideUI is the only writer; useHideUI subscribes.

const hideListeners = new Set<() => void>()
export const isHideUI = () => document.body.classList.contains('sh-hide-ui')
export function toggleHideUI() {
  document.body.classList.toggle('sh-hide-ui', !isHideUI())
  hideListeners.forEach((f) => f())
}
export function useHideUI() {
  const [on, setOn] = useState(isHideUI)
  useEffect(() => {
    const f = () => setOn(isHideUI())
    hideListeners.add(f)
    return () => { hideListeners.delete(f) }
  }, [])
  return on
}

// ---- shared controls ----------------------------------------------------------------

/** Laser toggle - store-level, identical on canvas and prototype. The per-surface code
 *  broadcasts sh:laser to its frame(s); this only flips the flag (and drops comment mode,
 *  since the two are one-at-a-time). */
export function LaserButton() {
  const laser = useStore((s) => s.laser)
  const showAnchor = useComments((s) => s.showAnchor)
  return (
    <Tip side="bottom" label={<><b>Laser mode</b><span>L · ⇧L {showAnchor ? 'deactivates' : 'activates'} laser comment</span></>}>
      <button className={`sh-pill-btn${laser ? ' on' : ''}`} onClick={() => {
        if (!laser) commentsStore().setMode(false)
        useStore.getState().setLaser(!laser)
      }}><LaserIcon size={16} /></button>
    </Tip>
  )
}

/** Comment toggle - store-level, identical on canvas and prototype. */
export function CommentButton() {
  const commentMode = useComments((s) => s.commentMode)
  const show = useComments((s) => s.show)
  return (
    <Tip side="bottom" label={<><b>Comment</b><span>C · ⇧C {show ? 'hides' : 'shows'} pins</span></>}>
      <button className={`sh-pill-btn${commentMode ? ' on' : ''}`} onClick={() => {
        const c = commentsStore()
        if (!c.commentMode) useStore.getState().setLaser(false)
        c.setMode(!c.commentMode)
        useStore.getState().toast(c.commentMode ? 'comment mode off' : 'comment mode - click an element in a frame')
      }}><CommentIcon size={16} /></button>
    </Tip>
  )
}

/** Hide-UI toggle - the dedicated binary control (no auto-fade, no hover-reveal). Its
 *  tooltip carries the way back; H is the shortcut, wired per-surface. */
export function HideUIButton() {
  const on = useHideUI()
  return (
    <Tip side="bottom" label={<><b>Hide all UI</b><span>press H to reveal</span></>}>
      <button className={`sh-pill-btn${on ? ' on' : ''}`} onClick={toggleHideUI}><EyeSlashIcon size={16} /></button>
    </Tip>
  )
}

/** Controlled device dropdown. `value` is the active device name ('fill' allowed when
 *  includeFill), null = default/mixed. The trigger + menu chrome is shared; the adapter
 *  owns what select does. */
export function DevicePicker({ value, onSelect, includeDefault, includeFill, hint, dark }: {
  value: string | null
  onSelect: (name: string | null) => void
  includeDefault?: boolean
  includeFill?: boolean
  hint?: ReactNode
  dark?: boolean
}) {
  const pop = usePopover()
  const entries = Object.entries(CONFIG.viewports)
  const pick = (name: string | null) => { onSelect(name); pop.setOpen(false) }
  const triggerIcon = value === 'fill' ? <FrameCornersIcon size={16} /> : deviceIcon(value, 16)
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <Tip side="bottom" label={<><b>Device view</b>{hint && <span>{hint}</span>}</>}>
        <button className="sh-pill-btn" onClick={pop.toggle}>
          {triggerIcon}
          <CaretIcon size={11} style={{ transform: pop.open ? 'rotate(180deg)' : undefined }} />
        </button>
      </Tip>
      <Popover pop={pop} dark={dark}>
        {includeDefault && <>
          <button onClick={() => pick(null)}>
            <DevicesIcon size={15} /><span>Default</span><kbd>0</kbd>
            {value === null && <CheckIcon size={13} className="chk" />}
          </button>
          <i className="div" />
        </>}
        {entries.map(([name, vp], i) => (
          <button key={name} onClick={() => pick(name)} title={`${vp.width} × ${vp.height}`}>
            {deviceIcon(name)}<span>{cap(name)}</span><kbd>{i < 9 ? i + 1 : ''}</kbd>
            {value === name && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
        {includeFill && <button onClick={() => pick('fill')}>
          <FrameCornersIcon size={15} /><span>Fill window</span><kbd>{entries.length + 1}</kbd>
          {value === 'fill' && <CheckIcon size={13} className="chk" />}
        </button>}
      </Popover>
    </div>
  )
}

/** Controlled theme dropdown. `value` drives the trigger (the level the picker acts on -
 *  the scope MAJORITY on the canvas); `checked` is the menu tick and can differ (undefined
 *  = tick `value`; null = tick nothing, e.g. a mixed selection). onSelect owns the write. */
export function ThemePicker({ value, checked, onSelect, hint, dark }: { value: string; checked?: string | null; onSelect: (t: string) => void; hint?: ReactNode; dark?: boolean }) {
  const pop = usePopover()
  const pick = (t: string) => { onSelect(t); pop.setOpen(false) }
  const tick = checked === undefined ? value : checked
  return (
    <div className="sh-theme" ref={pop.boxRef}>
      <Tip side="bottom" label={<><b>Theme</b>{hint && <span>{hint}</span>}</>}>
        <button className="sh-pill-btn" onClick={pop.toggle}>
          {value === 'dark' ? <MoonIcon size={16} /> : <SunIcon size={16} />}
          <CaretIcon size={11} style={{ transform: pop.open ? 'rotate(180deg)' : undefined }} />
        </button>
      </Tip>
      <Popover pop={pop} dark={dark}>
        {CONFIG.themes.map((t) => (
          <button key={t} onClick={() => pick(t)}>
            {t === 'dark' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
            <span>{t}</span>
            {tick === t && <CheckIcon size={13} className="chk" />}
          </button>
        ))}
      </Popover>
    </div>
  )
}
