/**
 * The drawing mode on the canvas (spec 38, frame `drawing-frame/2-top-bar-canvas`): the tool bar centred above the
 * frame, the properties panel 16 px to its left, the frame's own view controls inside its bottom-right corner. All in
 * screen space from the camera's CSS variables (--sh-s/tx/ty), so a pan or zoom costs no render; constant size.
 * Clicks on these controls keep keyboard focus in the drawing (Excalidraw's keys keep working).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useStore, PUBLISHED } from '../store.ts'
import { iframeOf } from '../canvas/frame-registry.ts'
import { framePath } from '../ContextMenu.tsx'
import { TOP } from '../inset.ts'
import { canvasCtl } from '../canvas/ctl.ts'
import { onMotion } from '../canvas/camera-broadcast.ts'
import { api } from '../api.ts'
import { DrawBar } from './DrawBar.tsx'
import { DrawPanel } from './DrawPanel.tsx'
import { DrawView } from './DrawView.tsx'
import { CANVAS_TOOLS } from './kit.tsx'
import { exportDrawing, toggleDrawingTheme, useDraw, type DrawLink } from './link.ts'
import { cmd } from '../commands.ts'

const HEAD = 28            // the frame head (world px)
const PANEL_W = 232, GAP = 16
/** where a pinned drawing bar may start: 10 px under the shell's toolbar pill - its own rule (styles.css .sh-pill:
 *  top max(var(--edge), var(--mv-top)), 44 px tall), so the two never disagree */
const BAR_FLOOR = 'calc(max(var(--edge, 10px), var(--mv-top, 0px)) + 54px)'

/** A pointer-down on a control keeps focus where it was (the drawing's iframe) - inputs excepted. */
const keepFocus = (e: React.MouseEvent) => {
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, select')) return
  e.preventDefault()
}
const Hold = ({ children }: { children: ReactNode }) => <div style={{ display: 'contents' }} onMouseDown={keepFocus}>{children}</div>

export function DrawCanvasChrome() {
  const node = useStore((s) => (s.interact ? s.nodes.find((n) => n.key === s.interact) : undefined))
  const frame = useStore((s) => (node ? s.frameFor(node) : undefined))
  const state = useDraw((s) => (node ? s.states[node.key] : undefined))
  const toast = useStore((s) => s.toast)
  const dark = useStore((s) => s.viewTheme) === 'dark'
  const [copied, setCopied] = useState<'path' | 'image' | null>(null)
  const drawKey = node && frame?.kind === 'draw' && !node.missing ? node.key : null
  // opened beside the open sidebar: the camera makes room once, so the panel sits left of the frame and clear of the
  // sidebar - never over the drawing (it would cover where the person draws), never under the sidebar
  useEffect(() => { if (drawKey) makeRoom(drawKey) }, [drawKey])
  // where the camera could not make room (a frame too wide for the window), the panel drops below the sidebar instead of
  // covering it: a floor for its top, measured when drawing mode opens, when the camera settles, on resize, and when the
  // sidebar opens or closes
  const sideOpen = useStore((s) => s.panelOpen)
  const [floor, setFloor] = useState(0)
  useEffect(() => {
    if (!drawKey) { setFloor(0); return }
    const measure = () => setFloor(sidebarFloor(drawKey))
    const first = setTimeout(measure, 320)   // after makeRoom's flight (250 ms) lands
    const offMotion = onMotion((m) => { if (!m.camera) measure() })
    addEventListener('resize', measure)
    return () => { clearTimeout(first); offMotion(); removeEventListener('resize', measure) }
  }, [drawKey, sideOpen])
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(null), 1400); return () => clearTimeout(t) }, [copied])
  if (!node || !frame || frame.kind !== 'draw' || node.missing) return null
  const link: DrawLink = { key: node.key, title: frame.title ?? frame.id.split('/').pop() ?? 'drawing', frame: frame.id, win: () => iframeOf(node.key)?.contentWindow }
  const sx = (wx: number) => `calc(var(--sh-tx, 0px) + var(--sh-s, 1) * ${wx}px)`
  const sy = (wy: number) => `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${wy}px)`
  // above the frame with the frame bar's own 14 px gap (its 40 px + 14: one click and drawing mode keep the same air - Nic,
  // 26 Nov); with the frame's top off screen it pins just below the shell's toolbar row (never over it)
  const bar: CSSProperties = { left: sx(node.x + node.w / 2), top: `max(${BAR_FLOOR}, calc(${sy(node.y)} - 54px))`, transform: 'translateX(-50%)' }
  const panel: CSSProperties = { left: `max(8px, calc(${sx(node.x)} - ${PANEL_W + GAP}px))`, top: `max(${TOP + 8}px, ${sy(node.y + HEAD)}, ${floor}px)` }
  const view: CSSProperties = { left: `calc(${sx(node.x + node.w)} - 8px)`, top: `calc(${sy(node.y + HEAD + node.h)} - 8px)`, transform: 'translate(-100%, -100%)' }
  const copyPath = () => {
    cmd('copy-path', { via: 'click', in: 'shell', frames: 1 })
    const text = framePath(useStore.getState().board, frame)
    navigator.clipboard.writeText(text).then(() => { toast('path copied'); setCopied('path') }, () => toast('copy blocked - click the canvas first'))
  }
  const copyImage = () => { exportDrawing(link, 'clipboard', (t) => { toast(t); if (t === 'image copied') setCopied('image') }, dark) }
  return (
    <Hold>
      {/* a published drawing is view-only (spec 38): its own pan and zoom, nothing to draw with */}
      {state?.editable !== false && <>
        <DrawBar link={link} state={state} tools={CANVAS_TOOLS} mode="canvas" style={bar} cam copied={copied}
          onCopyPath={copyPath} onCopyImage={copyImage} onExport={(k) => exportDrawing(link, k, toast, dark)}
          onTheme={() => toggleDrawingTheme(node.key, 'click')} dark={node.theme === 'dark'} />
        <DrawPanel link={link} state={state} popSide="right" style={panel} cam />
      </>}
      <DrawView link={link} state={state} style={view} cam />
    </Hold>
  )
}

/** Pan right just enough that the panel's place (PANEL_W + GAP left of the frame) clears the open sidebar, when the
 *  two would overlap on screen - as far as the frame's right edge stays on screen. Nothing moves when they do not
 *  overlap, or when the sidebar is closed. */
/** The top a canvas panel must keep to stay clear of the open sidebar: its bottom + 14 px when the panel's column overlaps
 *  the sidebar's, else 0 (no floor). */
function sidebarFloor(key: string): number {
  const side = document.querySelector('.sh-panel:not(.closed)')?.getBoundingClientRect()
  const f = iframeOf(key)?.getBoundingClientRect()
  if (!side || !f) return 0
  const panelLeft = Math.max(8, f.left - (PANEL_W + GAP))
  if (panelLeft >= side.right + 10) return 0
  // a sidebar too tall to clear (many boards): below it the panel would leave the window - it keeps its place
  return side.bottom + 14 > innerHeight - 320 ? 0 : Math.round(side.bottom + 14)
}

function makeRoom(key: string): void {
  const side = document.querySelector('.sh-panel:not(.closed)')?.getBoundingClientRect()
  const f = iframeOf(key)?.getBoundingClientRect()
  if (!side || !f) return
  const panelLeft = f.left - (PANEL_W + GAP), panelTop = Math.max(TOP + 8, f.top)
  if (panelTop >= side.bottom + 8) return            // below the sidebar: no overlap
  const need = side.right + 10 - panelLeft
  // never at the drawing's cost: the frame keeps its right edge on screen (a narrow window makes what room it can)
  const room = innerWidth - 10 - f.right
  const dx = Math.min(need, Math.max(0, room))
  if (dx > 0) canvasCtl.panBy(dx, 0)
}

// ---- W: a new drawing at the pointer (spec 38) ---------------------------------------------------------------
let pointer: { x: number; y: number } | null = null
if (typeof window !== 'undefined') addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY } }, { passive: true, capture: true })

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''

/** Drop a 960x640 drawing centred on the pointer (else the middle of the view), in the scene of the nearest frame,
 *  and open it in drawing mode. Owner only (a published canvas has no W). */
export async function newDrawingAtPointer(): Promise<void> {
  if (PUBLISHED) return
  const st = useStore.getState()
  const t = canvasCtl.transform()
  if (!t || !st.manifest) return
  const at = pointer ?? { x: innerWidth / 2, y: innerHeight / 2 }
  const wx = (at.x - t.x) / t.s, wy = (at.y - t.y) / t.s
  // the nearest frame's scene, else `sketches`
  let scene = 'sketches', best = Infinity
  for (const n of st.nodes) {
    const f = st.frameFor(n)
    if (!f?.scene || n.missing) continue
    const dx = Math.max(n.x - wx, 0, wx - (n.x + n.w)), dy = Math.max(n.y - wy, 0, wy - (n.y + n.h))
    const d = Math.hypot(dx, dy)
    if (d < best) { best = d; scene = f.scene }
  }
  const W = 960, H = 640
  // the shell's own transport: it names this canvas's workspace, and a canvas that stopped answers as one
  const res = await api('draw/new', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ scene }) }).catch(() => null)
  const body = await res?.json().catch(() => null)
  if (!res?.ok || !body?.id) { st.toast(body?.error ? `no drawing: ${body.error}` : 'could not make a drawing'); return }
  const id: string = body.id
  // the manifest names it within a moment; then it lands where the pointer was, and opens for drawing
  const place = () => {
    const s = useStore.getState()
    if (!s.manifest?.frames.some((f) => f.id === id)) return false
    let node = s.nodes.find((n) => n.frame === id)
    if (!node) node = s.spawn(id) ?? undefined
    if (!node) return false
    const key = node.key
    useStore.setState((x) => ({ nodes: x.nodes.map((n) => (n.key === key ? { ...n, x: Math.round(wx - W / 2), y: Math.round(wy - H / 2 - HEAD), w: W, h: H } : n)), dirty: true }))
    useStore.getState().select(key, false)
    useStore.getState().setInteract(key)
    return true
  }
  if (place()) return
  const unsub = useStore.subscribe((s, prev) => { if (s.manifest !== prev.manifest && place()) unsub() })
  setTimeout(unsub, 8000)
}
