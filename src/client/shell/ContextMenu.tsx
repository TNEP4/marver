import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore, SOURCE_REVEALED } from './store.ts'

/** Copy text to the clipboard, toasting the outcome. Success is confirmed out loud; a
 *  blocked clipboard (no user gesture / permission) says so instead of failing silently. */
export function copyToClipboard(text: string, okMsg: string) {
  const { toast } = useStore.getState()
  navigator.clipboard.writeText(text).then(() => toast(okMsg), () => toast('copy blocked - click the canvas first'))
}

/** The address a frame copies - the same string from the sidebar right-click, the floating
 *  toolbar, and ⇧P: the board it sits on, the frame id, and its file. */
// stripped build: the file column would only show the opaque token, so the
// copy keeps what is still honest - the board and the frame id
export const framePath = (board: string, f: { id: string; file: string }) =>
  SOURCE_REVEALED ? `board: ${board} · frame: ${f.id}  (${f.file})` : `board: ${board} · frame: ${f.id}`

export type MenuItem = { label: string; icon: ReactNode; onClick: () => void }
export type MenuState = { x: number; y: number; items: MenuItem[] }
export type MenuOpener = (e: { preventDefault(): void; clientX: number; clientY: number }, items: MenuItem[]) => void

/** A right-click menu for the sidebar. One instance lives in App; `open(e, items)` positions
 *  it at the cursor, CLAMPED into the viewport. It closes on outside pointerdown, on pick, and
 *  on Escape - the Escape listener runs in CAPTURE phase so it does not also trip App's global
 *  keydown (which would clear the selection/laser underneath the menu). */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const open: MenuOpener = (e, items) => {
    e.preventDefault()
    const MENU_W = 184
    // a menu taller than the window (many "Move to …" folders) pins to the top edge and scrolls
    const h = Math.min(items.length * 32 + 12, window.innerHeight - 16)
    setMenu({ x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8)), items })
  }
  return { menu, open, close: () => setMenu(null) }
}

export function ContextMenu({ menu, close }: { menu: MenuState | null; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as globalThis.Node)) close() }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() } }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onEsc, true)   // capture: beat App's bubble-phase Escape
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onEsc, true) }
  }, [menu])
  const app = document.querySelector('.sh-app')
  if (!menu || !app) return null
  return createPortal(
    <div className="sh-menu sh-ctxmenu" ref={ref} style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((it) => (
        <button key={it.label} onClick={() => { it.onClick(); close() }}>{it.icon}<span>{it.label}</span></button>
      ))}
    </div>,
    app,
  )
}
