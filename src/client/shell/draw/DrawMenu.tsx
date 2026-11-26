/**
 * A drawing's right-click, in Marver's design (spec 39 A6/B8) - drawn by the shell over the frame (it never clips at the
 * frame's edge), the drawing menus' glass and rows (`MI`), shortcuts as glyphs in Apple's order (`keyGlyphs`), and a
 * Comment row first.
 *
 * The drawing tells the shell what Excalidraw's own menu holds at that moment (its actions, filtered by their own
 * predicates) and the comment the point would take; Excalidraw's menu itself never shows. Rows that change the drawing
 * run Excalidraw's own action (the panel's path: `sh:draw-cmd {op:'action'}`, its allow-list, its predicate checked
 * again); clipboard rows are written here, inside the person's click (a browser allows a clipboard write only there),
 * with what the drawing hands back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { useStore, PUBLISHED } from '../store.ts'
import { TOP } from '../inset.ts'
import { iframeOf } from '../canvas/frame-registry.ts'
import { onMotion } from '../canvas/camera-broadcast.ts'
import { framePath } from '../ContextMenu.tsx'
import { cmd } from '../commands.ts'
import { useComments } from '../comments-store.ts'
import { commentGate } from '../comment-keys.ts'
import { markSeenFrom, resolveAllFrom } from '../marks-ui.tsx'
import { isNew } from '../../../shared/marks.ts'
import { CommentIcon, ImagesSquareIcon, SignpostIcon, CheckIcon } from '../icons.tsx'
import { MI, Ph, keyGlyphs } from './kit.tsx'
import { useDrawPlay } from './play-state.ts'

type Row = { name: string; labelKey: string }
type Open = { key: string; frame: string; x: number; y: number; rows: Row[]; element: boolean; anchor: unknown; editable: boolean; hitId?: string }

export const useDrawMenu = create<{ m: Open | null; open(m: Open): void; close(): void }>((set) => ({
  m: null,
  open: (m) => set({ m }),
  close: () => set({ m: null }),
}))

/** the window of the drawing a menu belongs to: a canvas frame by its node, play's own */
const winOf = (key: string): Window | null | undefined =>
  key.startsWith('play:') ? (document.querySelector('.dk-playhost iframe') as HTMLIFrameElement | null)?.contentWindow : iframeOf(key)?.contentWindow
const post = (key: string, msg: Record<string, unknown>) => { try { winOf(key)?.postMessage(msg, location.origin) } catch { /* gone */ } }
const iframeEl = (key: string): HTMLIFrameElement | null =>
  key.startsWith('play:') ? (document.querySelector('.dk-playhost iframe') as HTMLIFrameElement | null) : (iframeOf(key) ?? null)

// ---- what the drawing hands back for a clipboard row -------------------------------------------------------------
const pending = new Map<string, { res: (b: Blob) => void; rej: (e: Error) => void }>()
let ridN = 0
const askData = (key: string, what: 'copy' | 'svg' | 'text' | 'png', dark: boolean, ids?: string[]): Promise<Blob> => new Promise((res, rej) => {
  const rid = `m${++ridN}`
  const timer = setTimeout(() => { pending.delete(rid); rej(new Error('timed out')) }, 10_000)
  pending.set(rid, { res: (b) => { clearTimeout(timer); res(b) }, rej: (e) => { clearTimeout(timer); rej(e) } })
  post(key, { type: 'sh:draw-cmd', op: 'menu-data', what, dark, rid, ...(ids?.length ? { ids } : {}) })
})

/** The drawing's menu messages - called from drawMessage. True when the message was one. */
export function drawMenuMessage(key: string, data: any): boolean {
  if (data?.type === 'sh:draw-menu') {
    const el = iframeEl(key)
    if (!el) return true
    const r = el.getBoundingClientRect()
    const k = el.offsetWidth ? r.width / el.offsetWidth : 1
    const frame = String(data.id ?? '')
    useDrawMenu.getState().open({ key, frame, x: r.left + Number(data.point?.x ?? 0) * k, y: r.top + Number(data.point?.y ?? 0) * k, rows: Array.isArray(data.rows) ? data.rows : [], element: !!data.element, anchor: data.anchor ?? null, editable: !!data.editable, ...(typeof data.hitId === 'string' ? { hitId: data.hitId } : {}) })
    return true
  }
  if (data?.type === 'sh:draw-menu-data') {
    const p = pending.get(String(data.rid))
    if (!p) return true
    pending.delete(String(data.rid))
    if (data.error) p.rej(new Error(String(data.error)))
    else p.res(data.blob instanceof Blob ? data.blob : new Blob([String(data.data ?? '')], { type: String(data.mime ?? 'text/plain') }))
    return true
  }
  return false
}

// ---- the rows -----------------------------------------------------------------------------------------------------
type Clip = 'copy' | 'cut' | 'svg' | 'text' | 'png' | 'paste'
type Spec = { label: string | ((labelKey: string) => string); icon: ReactNode; k?: string; clip?: Clip; warn?: boolean }
/** Excalidraw's own rows, named as the panel names them; an action missing here is dropped (Add to library, its
 *  element links, its view rows - grid, zen, view mode, stats: Marver owns those) */
const ROWS: Record<string, Spec> = {
  cut: { label: 'Cut', icon: <Ph n="Scissors" size={15} />, k: keyGlyphs('Mod+X'), clip: 'cut' },
  copy: { label: 'Copy', icon: <Ph n="Clipboard" size={15} />, k: keyGlyphs('Mod+C'), clip: 'copy' },
  paste: { label: 'Paste', icon: <Ph n="ClipboardText" size={15} />, k: keyGlyphs('Mod+V'), clip: 'paste' },
  duplicateSelection: { label: 'Duplicate', icon: <Ph n="Copy" size={15} />, k: keyGlyphs('Mod+D') },
  copyAsPng: { label: 'Copy selection as image', icon: <ImagesSquareIcon size={15} />, clip: 'png' },
  copyAsSvg: { label: 'Copy as SVG', icon: <Ph n="FileSvg" size={15} />, clip: 'svg' },
  copyText: { label: 'Copy as text', icon: <Ph n="TextAa" size={15} />, clip: 'text' },
  copyStyles: { label: 'Copy styles', icon: <Ph n="PaintBrush" size={15} />, k: keyGlyphs('Alt+Mod+C') },
  pasteStyles: { label: 'Paste styles', icon: <Ph n="PaintBrush" size={15} />, k: keyGlyphs('Alt+Mod+V') },
  group: { label: 'Group', icon: <Ph n="SelectionAll" size={15} />, k: keyGlyphs('Mod+G') },
  ungroup: { label: 'Ungroup', icon: <Ph n="SelectionAll" size={15} />, k: keyGlyphs('Shift+Mod+G') },
  unbindText: { label: 'Unbind text', icon: <Ph n="LinkBreak" size={15} /> },
  bindText: { label: 'Bind text', icon: <Ph n="Link" size={15} /> },
  wrapTextInContainer: { label: 'Wrap text in a box', icon: <Ph n="Square" size={15} /> },
  autoResize: { label: 'Auto-size text', icon: <Ph n="TextT" size={15} /> },
  wrapSelectionInFrame: { label: 'Wrap in drawing frame', icon: <Ph n="Hash" size={15} /> },
  selectAllElementsInFrame: { label: 'Select all in frame', icon: <Ph n="SelectionPlus" size={15} /> },
  removeAllElementsFromFrame: { label: 'Remove from frame', icon: <Ph n="Hash" size={15} /> },
  hyperlink: { label: 'Link', icon: <Ph n="Link" size={15} />, k: keyGlyphs('Mod+K') },
  toggleLinearEditor: { label: 'Edit points', icon: <Ph n="PencilSimple" size={15} />, k: keyGlyphs('Mod+Enter') },
  cropEditor: { label: 'Crop', icon: <Ph n="Crop" size={15} /> },
  sendBackward: { label: 'Send backward', icon: <Ph n="ArrowDown" size={15} />, k: keyGlyphs('Mod+[') },
  bringForward: { label: 'Bring forward', icon: <Ph n="ArrowUp" size={15} />, k: keyGlyphs('Mod+]') },
  sendToBack: { label: 'Send to back', icon: <Ph n="ArrowLineDown" size={15} />, k: keyGlyphs('Alt+Mod+[') },
  bringToFront: { label: 'Bring to front', icon: <Ph n="ArrowLineUp" size={15} />, k: keyGlyphs('Alt+Mod+]') },
  flipHorizontal: { label: 'Flip horizontal', icon: <Ph n="FlipHorizontal" size={15} />, k: keyGlyphs('Shift+H') },
  flipVertical: { label: 'Flip vertical', icon: <Ph n="FlipVertical" size={15} />, k: keyGlyphs('Shift+V') },
  toggleElementLock: { label: (lk) => (/unlock/i.test(lk) ? 'Unlock' : 'Lock'), icon: <Ph n="LockKey" size={15} />, k: keyGlyphs('Shift+Mod+L') },
  unlockAllElements: { label: 'Unlock all', icon: <Ph n="LockSimpleOpen" size={15} /> },
  selectAll: { label: 'Select all', icon: <Ph n="SelectionPlus" size={15} />, k: keyGlyphs('Mod+A') },
  deleteSelectedElements: { label: 'Delete', icon: <Ph n="Trash" size={15} />, k: keyGlyphs('Backspace'), warn: true },
}
/** read-only rows a published (view-only) drawing keeps */
const READ_ONLY = new Set(['copyAsPng', 'copyText'])

type Item = { id: string; label: string; icon: ReactNode; k?: string; warn?: boolean; run: () => void } | '|'

function itemsFor(m: Open): Item[] {
  const s = useStore.getState()
  const dark = s.viewTheme === 'dark'
  const toast = s.toast
  const how = { via: 'context' as const, in: (m.key.startsWith('play:') ? 'stage' : 'frame') as 'stage' | 'frame', frame: m.frame }
  const out: Item[] = []
  // Comment first - the comment button's own gate (unplaced, a view-only role asks, signed out signs in)
  const gate = commentGate()
  if (gate !== 'unplaced') {
    const paper = !m.element
    out.push({
      id: 'comment', label: gate === 'locked' ? 'Ask to comment' : paper ? 'Comment here' : 'Comment', icon: <CommentIcon size={15} />, k: 'C',
      run: () => {
        const c = useComments.getState()
        if (gate === 'locked') { const h = cmd('ask-to-comment', how); void c.askToComment().then((ok) => { if (ok) h.done(); else h.fail('api'); toast(ok ? 'asked the owner for comment access - they decide' : 'could not send the request - try again') }); return }
        if (PUBLISHED && !c.me) { cmd('comments', how); c.setMode(true); return }   // signs in first, as the comment button does
        if (!m.anchor) { toast("can't comment there"); return }
        cmd('comment-pick', how)
        if (c.active) c.setActive(null)
        const node = m.key.startsWith('play:') ? (useDrawPlay.getState().node ?? m.key) : m.key
        c.setDraft({ nodeKey: node, frame: m.frame, anchor: m.anchor })
      },
    })
    out.push('|')
  }
  const write = (what: Exclude<Clip, 'paste' | 'cut'>, label: string, after?: () => void) => {
    const h = cmd('draw-cmd', { ...how, arg: what } as any)
    const mime = what === 'png' ? 'image/png' : 'text/plain'
    // a view-only drawing has no selection: the element right-clicked is what is copied
    const data = askData(m.key, what, dark, !m.editable && m.hitId ? [m.hitId] : undefined)
    // inside the click: a clipboard item whose data the drawing fills (a browser allows the write only here)
    navigator.clipboard.write([new ClipboardItem({ [mime]: data })]).then(
      () => { h.done(); toast(label); after?.() },
      () => { h.fail('clipboard-blocked'); toast('copy blocked - click the drawing first') })
  }
  const action = (name: string) => { cmd('draw-cmd', { ...how, arg: name } as any); post(m.key, { type: 'sh:draw-cmd', op: 'action', name }) }
  for (const r of m.rows) {
    if (r.name === '|') { if (out.length && out[out.length - 1] !== '|') out.push('|'); continue }
    if (!m.editable && !READ_ONLY.has(r.name)) continue
    const spec = ROWS[r.name]
    if (!spec) continue
    // on the paper, Copy as image is the whole drawing (as in the bar); on a selection, the selection
    const label = r.name === 'copyAsPng' && !m.element ? 'Copy as image' : typeof spec.label === 'function' ? spec.label(r.labelKey) : spec.label
    const k = r.name === 'copyAsPng' && !m.element ? '⇧I' : spec.k
    const run = spec.clip === 'copy' ? () => write('copy', 'copied')
      : spec.clip === 'cut' ? () => write('copy', 'cut', () => post(m.key, { type: 'sh:draw-cmd', op: 'action', name: 'deleteSelectedElements' }))
      : spec.clip === 'svg' ? () => write('svg', 'SVG copied')
      : spec.clip === 'text' ? () => write('text', 'text copied')
      : spec.clip === 'png' ? () => write('png', 'image copied')
      : spec.clip === 'paste' ? () => {
          const h = cmd('draw-cmd', { ...how, arg: 'paste' } as any)
          // read inside the click, pasted by the drawing at the pointer
          navigator.clipboard.readText().then((text) => { h.done(); post(m.key, { type: 'sh:draw-cmd', op: 'paste', text }) }, () => { h.fail('clipboard-blocked'); toast('paste blocked - press ⌘V in the drawing') })
        }
      : () => action(r.name)
    out.push({ id: r.name, label, icon: spec.icon, k, warn: spec.warn, run })
  }
  // the paper's own rows (the frame row menu's, where they apply)
  if (!m.element) {
    if (out.length && out[out.length - 1] !== '|') out.push('|')
    out.push({ id: 'fit', label: 'Zoom to fit', icon: <Ph n="Scan" size={15} />, k: '⇧1', run: () => { cmd('draw-cmd', { ...how, arg: 'fit' } as any); post(m.key, { type: 'sh:draw-cmd', op: 'view', v: 'fit' }) } })
    const f = s.manifest?.frames.find((x) => x.id === m.frame)
    if (f) out.push({ id: 'path', label: 'Copy path', icon: <SignpostIcon size={15} />, k: '⇧P', run: () => { const h = cmd('copy-path', how); navigator.clipboard.writeText(framePath(s.board, f)).then(() => { h.done(); toast('path copied') }, () => { h.fail('clipboard-blocked'); toast('copy blocked - click the drawing first') }) } })
    if (!PUBLISHED && isNew(s.marks, m.frame)) out.push({ id: 'seen', label: 'Mark as seen', icon: <CheckIcon size={15} />, run: () => markSeenFrom(how, [m.frame]) })
    if (!PUBLISHED && useComments.getState().threads.some((t) => t.frame === m.frame && !t.resolved)) out.push({ id: 'resolve', label: 'Resolve comments', icon: <Ph n="Check" size={15} />, run: () => void resolveAllFrom(how, { frame: m.frame }) })
  }
  while (out.length && out[out.length - 1] === '|') out.pop()
  return out
}

/** Arrows walk a menu's rows, Enter runs the lit one, Escape closes it - for the drawing's menus (spec 39 A6), from the
 *  shell's keys and from the keys a drawing forwards while a menu is open over it */
export function useMenuKeys(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void, key?: string) {
  const [hi, setHi] = useState(-1)
  useEffect(() => { setHi(-1) }, [open])
  useEffect(() => {
    if (!open) return
    if (key) post(key, { type: 'sh:draw-cmd', op: 'menu', open: true })
    const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const step = (d: number) => setHi((i) => { const n = buttons().length; return n ? (i + d + n) % n : -1 })
    const act = (k: string) => {
      if (k === 'up') step(-1)
      else if (k === 'down') step(1)
      else if (k === 'enter') setHi((i) => { buttons()[i]?.click(); return i })
      else if (k === 'close') close()
    }
    const onKey = (e: KeyboardEvent) => {
      const k = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'Enter' ? 'enter' : e.key === 'Escape' ? 'close' : ''
      if (!k) return
      e.preventDefault(); e.stopPropagation()
      act(k)
    }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'sh:draw-key' || typeof e.data.key !== 'string' || !e.data.key.startsWith('menu-')) return
      act(e.data.key.slice(5))
    }
    addEventListener('keydown', onKey, true)
    addEventListener('message', onMsg)
    return () => { removeEventListener('keydown', onKey, true); removeEventListener('message', onMsg); if (key) post(key, { type: 'sh:draw-cmd', op: 'menu', open: false }) }
  }, [open, key])
  useEffect(() => {
    const b = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    b.forEach((x, i) => x.classList.toggle('hi', i === hi))
  }, [hi])
}

export function DrawContextMenu() {
  const m = useDrawMenu((s) => s.m)
  const close = useDrawMenu((s) => s.close)
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
  useMenuKeys(ref, !!m, close, m?.key)
  // kept inside the window: placed once laid out, and again a frame later (its icons and fonts can still grow it)
  const [shown, setShown] = useState(false)
  useLayoutEffect(() => {
    setShown(false)
    if (!m || !ref.current) { setTop(null); return }
    // its layout height (offsetHeight): the open animation scales it, so its on-screen box reads short at first
    const place = () => { const h = ref.current?.offsetHeight ?? 0; setTop(Math.max(TOP + 8, Math.min(m.y, window.innerHeight - h - 8))) }
    place()
    // shown only at its final place - it never jumps under the pointer; placed again whenever its size settles
    const raf = requestAnimationFrame(() => { place(); setShown(true) })
    const ro = new ResizeObserver(place)
    ro.observe(ref.current)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [m])
  // it closes on a press anywhere (in the drawing too: its frame-down), when the board or the drawing moves under it,
  // on resize - one drawing menu at a time
  useEffect(() => {
    if (!m) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as globalThis.Node)) close() }
    const onMsg = (e: MessageEvent) => { if (e.origin === location.origin && (e.data?.type === 'sh:frame-down' || (e.data?.type === 'sh:draw-state' && e.data.panning))) close() }
    const offMotion = onMotion((mo) => { if (mo.camera) close() })
    addEventListener('pointerdown', onDown, true)
    addEventListener('message', onMsg)
    addEventListener('resize', close)
    return () => { removeEventListener('pointerdown', onDown, true); removeEventListener('message', onMsg); removeEventListener('resize', close); offMotion() }
  }, [m])
  const app = document.querySelector('.sh-app')
  if (!m || !app) return null
  const items = itemsFor(m)
  if (!items.length) return null
  const W = 248
  return createPortal(
    <div ref={ref} className="sh-menu sh-ctxmenu dk-menu dk-ctxmenu" role="menu" style={{ position: 'fixed', left: Math.max(8, Math.min(m.x, window.innerWidth - W - 8)), top: top ?? m.y, width: W, zIndex: 70, maxHeight: `calc(100vh - ${TOP + 16}px)`, overflowY: 'auto', visibility: top === null || !shown ? 'hidden' : undefined }}>
      {items.map((it, i) => it === '|'
        ? <div key={`sep${i}`} className="div" />
        : <span key={it.id} className={it.warn ? 'warn' : undefined}><MI icon={it.icon} label={it.label} k={it.k} onClick={() => { close(); it.run() }} /></span>)}
    </div>,
    app,
  )
}
