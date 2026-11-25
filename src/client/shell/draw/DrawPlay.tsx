/**
 * A drawing in play (spec 38, frames `2-top-bar-play` and `2-top-bar-play-collapsed`): the drawing fills the tab on its
 * own paper; one left panel (its name and the drawing menu, collapse ⌘\, then the properties), the tool bar top right
 * (collapse ⌘/), the view controls bottom right; Hide all UI (H brings it back); Esc goes back to the canvas.
 * Positions are the canvas's own: right under the Mac app's strip, 10 px in. Published: view only (name, view).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { useStore, PUBLISHED } from '../store.ts'
import { withWs } from '../api.ts'
import { ROUTE } from '../../const.ts'
import { framePath } from '../ContextMenu.tsx'
import { PanelFilledIcon, PanelHollowIcon } from '../icons.tsx'
import { DrawBar } from './DrawBar.tsx'
import { DrawPanel } from './DrawPanel.tsx'
import { DrawView } from './DrawView.tsx'
import { HoverTip, MAIN_TOOLS, MI, Ph } from './kit.tsx'
import { drawMessage, exportDrawing, sendQuiet, useDraw, type DrawLink } from './link.ts'
import { cmd } from '../commands.ts'

export const useDrawPlay = create<{ at: string | null; open(id: string): void; close(): void }>((set) => ({
  at: null,
  open: (id) => set({ at: id }),
  close: () => set({ at: null }),
}))

/** P on a selected drawing (or the board's play while one is selected or in drawing mode) plays the drawing. */
export function playDrawingIfSelected(): boolean {
  const s = useStore.getState()
  const key = s.interact ?? (s.selection.length === 1 ? s.selection[0] : null)
  let n = key ? s.nodes.find((x) => x.key === key) : undefined
  // a board of drawings only: play its first one (the prototype play has nothing to show there)
  if (!n && !s.nodes.some((x) => !x.missing && s.frameFor(x)?.kind === 'tsx')) n = s.nodes.find((x) => !x.missing && s.frameFor(x)?.kind === 'draw')
  const f = n ? s.frameFor(n) : undefined
  if (!n || !f || f.kind !== 'draw' || n.missing) return false
  if (s.interact) s.setInteract(null)
  useDrawPlay.getState().open(f.id)
  return true
}

const EDGE: CSSProperties = { top: 'max(10px, var(--mv-top, 0px))' }

export function DrawPlay() {
  const at = useDrawPlay((s) => s.at)
  const close = useDrawPlay((s) => s.close)
  const frame = useStore((s) => (at ? s.manifest?.frames.find((f) => f.id === at) : undefined))
  const theme = useStore((s) => s.viewTheme)
  const toast = useStore((s) => s.toast)
  const key = at ? `play:${at}` : ''
  const state = useDraw((s) => (key ? s.states[key] : undefined))
  const iframe = useRef<HTMLIFrameElement>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [barOpen, setBarOpen] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [menu, setMenu] = useState(false)
  const src = useRef('')
  const flushed = useRef<(() => void) | null>(null)
  const [closing, setClosing] = useState(false)
  if (at && !src.current) src.current = withWs(`${ROUTE}/draw/?id=${encodeURIComponent(at)}&theme=${theme}&r=play`)
  if (!at) src.current = ''

  const link: DrawLink | null = at && frame ? { key, title: frame.title ?? at.split('/').pop() ?? 'drawing', frame: at, win: () => iframe.current?.contentWindow } : null

  // this host's messages: its state, its exports, Escape (back to the canvas), the keys it hands back
  useEffect(() => {
    if (!at) return
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.current?.contentWindow || (e.origin && e.origin !== location.origin)) return
      const d = e.data
      // play owns the drawing's wheel and keys - published too (view only there: the host keeps it in view mode)
      if (d?.type === 'sh:ready') { try { iframe.current?.contentWindow?.postMessage({ type: 'sh:interactive', on: true }, location.origin) } catch { /* gone */ } return }
      if (d?.type === 'sh:draw-flushed') { flushed.current?.(); return }
      if (d?.type === 'sh:exit-interact') { leave(); return }
      if (d?.type === 'sh:draw-key') {
        if (d.key === 'reveal') setHidden(false)
        else if (d.key === 'panel') setPanelOpen((o) => !o)
        else if (d.key === 'toolbar') setBarOpen((o) => !o)
        return
      }
      drawMessage(key, d)
    }
    addEventListener('message', onMsg)
    return () => removeEventListener('message', onMsg)
  }, [at])
  // theme follows the canvas's
  useEffect(() => { try { iframe.current?.contentWindow?.postMessage({ type: 'sh:set-theme', theme }, location.origin) } catch { /* not yet */ } }, [theme])
  // the host intercepts H while the UI is hidden (it reveals), Excalidraw's hand otherwise
  useEffect(() => { if (link) sendQuiet(link, { op: 'ui', hidden }) }, [hidden, at])

  if (!at || !link) return null
  // leaving waits for the drawing's last save (3 s at most - a dead server never traps the person in play)
  // leaving hides play at once; the drawing's document stays (out of sight) until its last save has landed, so a slow
  // save never loses a stroke
  const leave = () => {
    const done = () => { flushed.current = null; setClosing(false); useDraw.getState().drop(key); close() }
    cmd('play-exit', { via: 'click', in: 'stage' })
    if (!link || PUBLISHED) { done(); return }
    flushed.current = done
    setClosing(true)
    sendQuiet(link, { op: 'flush' })
  }
  const dark = theme === 'dark'
  const copyPath = () => { if (!frame) return; navigator.clipboard.writeText(framePath(useStore.getState().board, frame)).then(() => toast('path copied'), () => toast('copy blocked - click the drawing first')) }
  const copyImage = () => exportDrawing(link, 'clipboard', toast, dark)
  const keepFocus = (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault() }

  const head = (
    <div className="dk-phead">
      <HoverTip label="Drawing menu" side="right">
        <button className="dk-b name" aria-label="Drawing menu" onClick={() => setMenu((m) => !m)}><Ph n="PenNib" size={14} /><span>{link.title}</span><Ph n="CaretDown" size={10} className="cv" /></button>
      </HoverTip>
      <HoverTip label="Collapse panel" keys="⌘\" side="bottom">
        <button className="dk-b ic" aria-label="Collapse panel" onClick={() => { cmd('panel', { via: 'click', in: 'stage' }); setPanelOpen(false) }}><PanelFilledIcon size={17} /></button>
      </HoverTip>
    </div>
  )
  return (
    <div className={`sh-play dk-playhost${hidden ? ' hidden-ui' : ''}`} onMouseDown={keepFocus} aria-hidden={closing || undefined}
      style={{ position: 'fixed', inset: 0, zIndex: 60, paddingTop: 'var(--mv-top, 0px)', boxSizing: 'border-box', ...(closing ? { visibility: 'hidden', pointerEvents: 'none' } : {}) }}>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 'var(--mv-top, 0px)' }}>
        <iframe ref={iframe} src={src.current} title={link.title} />
      </div>
      {panelOpen
        ? <DrawPanel link={link} state={state} top={head} popSide="right" style={{ ...EDGE, left: 10 }} />
        : <div className="dk-anchor" style={{ ...EDGE, left: 10 }}><HoverTip label="Expand panel" keys="⌘\" side="right"><button className="dk-glass dk-fab" aria-label="Expand panel" onClick={() => { cmd('panel', { via: 'click', in: 'stage' }); setPanelOpen(true) }}><PanelHollowIcon size={18} /></button></HoverTip></div>}
      {menu && panelOpen && (
        <div className="sh-menu dk-menu" style={{ position: 'absolute', top: 'calc(max(10px, var(--mv-top, 0px)) + 44px)', left: 20, zIndex: 50 }} onMouseLeave={() => setMenu(false)}>
          <MI icon={<Ph n="FilePng" size={15} />} label="Export as PNG" onClick={() => { setMenu(false); exportDrawing(link, 'png', toast, dark) }} />
          <MI icon={<Ph n="FilePdf" size={15} />} label="Export as PDF" onClick={() => { setMenu(false); exportDrawing(link, 'pdf', toast, dark) }} />
          <div className="div" />
          <MI icon={<Ph n="Copy" size={15} />} label="Copy as image" k="⇧I" onClick={() => { setMenu(false); copyImage() }} />
          <MI icon={<Ph n="Link" size={15} />} label="Copy path" k="⇧P" onClick={() => { cmd('copy-path', { via: 'click', in: 'stage' }); setMenu(false); copyPath() }} />
          <div className="div" />
          <MI icon={<Ph n="EyeSlash" size={15} />} label="Hide all UI" k="H" onClick={() => { cmd('hide-ui', { via: 'click', in: 'stage' }); setMenu(false); setHidden(true) }} />
        </div>
      )}
      {state?.editable !== false && (barOpen
        ? <DrawBar link={link} state={state} tools={MAIN_TOOLS} mode="play" style={{ ...EDGE, right: 10 }}
            onExport={(k) => exportDrawing(link, k, toast, dark)} onCopyImage={copyImage}
            onCollapse={() => { cmd('toolbar', { via: 'click', in: 'stage' }); setBarOpen(false) }} onHideUI={() => { cmd('hide-ui', { via: 'click', in: 'stage' }); setHidden(true) }} onBack={leave} />
        : <div className="dk-anchor" style={{ ...EDGE, right: 10 }}><HoverTip label="Expand toolbar" keys="⌘/" side="bottom"><button className="dk-glass dk-fab" aria-label="Expand toolbar" onClick={() => { cmd('toolbar', { via: 'click', in: 'stage' }); setBarOpen(true) }}><PanelHollowIcon size={18} style={{ transform: 'rotate(90deg)' }} /></button></HoverTip></div>)}
      <DrawView link={link} state={state} size="lg" map menuSide="top" style={{ right: 10, bottom: 10 }} />
      {state?.editable === false && (
        <div className="dk-anchor" style={{ ...EDGE, right: 10 }}>
          <HoverTip label="Back to the canvas" keys="esc" side="bottom"><button className="dk-glass dk-fab" aria-label="Back to the canvas" onClick={leave}><Ph n="X" size={16} /></button></HoverTip>
        </div>
      )}
    </div>
  )
}
