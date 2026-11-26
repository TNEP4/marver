/**
 * Comments on a drawing (spec 39 B1-B3) - the draw host answers the frame inspector for its drawing.
 *
 * The shared inspector (frame-host/inspect.js) reads `window.__mvAnchorProvider` at every call: inside a drawing it never
 * looks at the DOM (the drawing is one <canvas>), it asks this provider instead - which element is under the pointer,
 * what a click anchors, where each pin goes, which element to light. The shell's messages do not change.
 *
 * Pins follow without a render (B2): every geometry or camera change is posted (at most once a frame, only when it
 * differs) with `moving` while a pan, a zoom, a drag or remote edits are under way - the shell moves the pins by
 * writing CSS variables then, and places them again (overlaps, leads) once `moving` is false.
 */
import type { Engine, Geo } from './adapter.tsx'
import { localPoint } from './adapter.tsx'
import type { DrawHeader } from '../../shared/draw-protocol.ts'

type Anchor = { el?: { draw?: { id?: string; type?: string; label?: string; at?: { x: number; y: number }; rev?: number; epoch?: string }; semantics?: { tag?: string; quote?: string }; hue?: number }; pos?: { fx: number; fy: number } }
type Req = { key: string; anchor: Anchor }
export type PinRect =
  | { key: string; orphan: true }
  | { key: string; rect: { x: number; y: number; w: number; h: number }; point: { x: number; y: number }; scene: { x: number; y: number }; off: boolean }

/** one id rule for drawings and comments (spec 39 B3) - mirrors src/shared/anchor.ts validElementId */
// eslint-disable-next-line no-control-regex
const okId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id)

/** the hue a pin, outline and composer share: the element's stroke hue, Marver's blue (210) for black, grey, paper */
export function hueOf(color: unknown): number {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(color ?? ''))
  if (!m) return 210
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (sat < 0.18 || l < 0.08 || l > 0.96) return 210
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue = Math.round(hue * 60)
  return (hue + 360) % 360
}

const rot = (p: { x: number; y: number }, c: { x: number; y: number }, a: number) => {
  if (!a) return p
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) }
}

export interface CommentHost {
  engine: () => Engine | null
  header: () => DrawHeader
  rev: () => number
  post: (msg: Record<string, unknown>) => void
  id: string
}

export function installCommentProvider(host: CommentHost) {
  let downAt: { x: number; y: number } | null = null
  let travelled = 0
  // how far the pointer travelled while pressed - a press that moved 4 px or more panned, it is not a pick (kept until the
  // click that follows the release, counted only while a button is down)
  addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; travelled = 0 }, true)
  addEventListener('pointermove', (e) => { if (downAt && e.buttons) travelled = Math.max(travelled, Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)) }, true)
  addEventListener('pointerup', () => { downAt = null }, true)
  addEventListener('pointercancel', () => { downAt = null }, true)

  // ---- the outline (outside Excalidraw's dark filter, so colours never invert) ----
  const box = document.createElement('div')
  box.id = 'mv-draw-hl'
  box.setAttribute('aria-hidden', 'true')
  const lock = document.createElement('div')
  lock.id = 'mv-draw-lock'
  lock.setAttribute('aria-hidden', 'true')
  const style = document.createElement('style')
  // the inspector's own lighting (inspect.js HUE_HL): 2px outline, a soft fill, a ring - in the element's hue
  style.textContent = `
#mv-draw-hl, #mv-draw-lock { position: fixed; pointer-events: none; z-index: 2147483000; display: none; box-sizing: border-box;
  border: 2px solid hsl(var(--h, 210) 95% 45%); background: hsl(var(--h, 210) 95% 50% / .10);
  box-shadow: 0 0 0 3px hsl(var(--h, 210) 95% 50% / .32); transform-origin: center; border-radius: 3px }
#mv-draw-hl.ellipse, #mv-draw-lock.ellipse { border-radius: 50% }
#mv-draw-hl.paper, #mv-draw-lock.paper { width: 14px !important; height: 14px !important; border-radius: 50%; background: hsl(var(--h, 210) 95% 50% / .25) }
`
  const mount = () => { if (!box.isConnected) { document.head.appendChild(style); document.body.appendChild(box); document.body.appendChild(lock) } }

  let hoverKey = ''
  let locked: Anchor | null = null

  /** an element's or the paper's on-screen outline */
  const outline = (el: HTMLElement, a: Anchor | null) => {
    const eng = host.engine()
    if (!a || !eng) { el.style.display = 'none'; return }
    mount()
    const d = a.el?.draw
    el.style.setProperty('--h', String(a.el?.hue ?? 210))
    if (d?.at) {
      const p = eng.toView(d.at.x, d.at.y)
      el.className = 'paper'
      Object.assign(el.style, { display: 'block', left: `${p.x - 7}px`, top: `${p.y - 7}px`, transform: 'none' })
      return
    }
    const g = d?.id ? eng.geo(d.id) : null
    if (!g) { el.style.display = 'none'; return }
    const z = eng.camera().zoom
    const tl = eng.toView(g.x, g.y)
    el.className = g.type === 'ellipse' ? 'ellipse' : ''
    Object.assign(el.style, { display: 'block', left: `${tl.x - 3}px`, top: `${tl.y - 3}px`, width: `${g.w * z + 6}px`, height: `${g.h * z + 6}px`, transform: g.angle ? `rotate(${g.angle}rad)` : 'none' })
  }

  /** the comment's anchor for a click at this point (null: not ready, or not something to comment on) */
  const anchorAt = (cx: number, cy: number, withPos: boolean): { anchor: Anchor & Record<string, unknown> } | { refused: string } | null => {
    const eng = host.engine()
    if (!eng) return null
    const h = host.header()
    const meta = { rev: host.rev(), ...(h.epoch ? { epoch: h.epoch } : {}) }
    const hit = eng.hit(cx, cy)
    if (!hit) {
      const s = eng.toScene(cx, cy)
      const at = { x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 }
      return { anchor: { el: { draw: { at, ...meta }, semantics: { tag: 'excalidraw:paper' }, hue: 210 }, pos: { fx: 0.5, fy: 0.5 }, rect: { x: cx, y: cy, w: 0, h: 0 }, point: { x: cx, y: cy } } }
    }
    if (!okId(hit.id)) return { refused: "can't comment - this element's id is unusual" }
    const g = eng.geo(hit.id)!
    const el = (eng.elements() as any[]).find((e) => e.id === hit.id)
    const hue = hueOf(el?.strokeColor)
    const s = eng.toScene(cx, cy)
    const { fx, fy } = localPoint({ x: g.x, y: g.y, width: g.w, height: g.h, angle: g.angle }, s.x, s.y)
    const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
    const r = rect(eng, g)
    return {
      anchor: {
        el: { draw: { id: hit.id, type: hit.type, ...(hit.label ? { label: hit.label } : {}), ...meta }, semantics: { tag: `excalidraw:${hit.type}`, ...(hit.label ? { quote: hit.label } : {}) }, hue },
        ...(withPos ? { pos: { fx: clamp(fx), fy: clamp(fy) } } : {}),
        rect: r, point: { x: cx, y: cy },
      },
    }
  }

  /** the axis-aligned on-screen box of an element (rotated corners included), iframe px */
  const rect = (eng: Engine, g: Geo) => {
    const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 }
    const pts = [{ x: g.x, y: g.y }, { x: g.x + g.w, y: g.y }, { x: g.x, y: g.y + g.h }, { x: g.x + g.w, y: g.y + g.h }].map((p) => eng.toView(rot(p, c, g.angle).x, rot(p, c, g.angle).y))
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }

  /** where one comment's pin goes now */
  const place = (eng: Engine, q: Req): PinRect => {
    const d = q.anchor?.el?.draw
    const W = innerWidth, H = innerHeight
    const offAt = (p: { x: number; y: number }) => p.x < 0 || p.y < 0 || p.x > W || p.y > H
    if (d?.at && Number.isFinite(d.at.x) && Number.isFinite(d.at.y)) {
      const p = eng.toView(d.at.x, d.at.y)
      return { key: q.key, rect: { x: p.x, y: p.y, w: 0, h: 0 }, point: p, scene: { x: d.at.x, y: d.at.y }, off: offAt(p) }
    }
    const g = d?.id && okId(d.id) ? eng.geo(d.id) : null
    if (!g) return { key: q.key, orphan: true }          // exact id only (A1): gone is gone - never another element
    const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 }
    const pos = q.anchor.pos
    const sp = pos && Number.isFinite(pos.fx) && Number.isFinite(pos.fy) ? rot({ x: g.x + pos.fx * g.w, y: g.y + pos.fy * g.h }, c, g.angle) : rot(g.attach, c, g.angle)
    const p = eng.toView(sp.x, sp.y)
    return { key: q.key, rect: rect(eng, g), point: p, scene: sp, off: offAt(p) }
  }

  // ---- what the shell asked to follow, pushed on every change (B2) ----
  let watched: Req[] = []
  let lastJson = ''
  let queued = false
  let moving = false
  const push = (force = false) => {
    if (queued && !force) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const eng = host.engine()
      if (!eng || !watched.length) return
      const rects = watched.map((q) => { try { return place(eng, q) } catch { return { key: q.key, orphan: true } as PinRect } })
      const cam = eng.camera()
      const json = JSON.stringify([rects, moving])
      if (json === lastJson && !force) return
      lastJson = json
      host.post({ type: 'sh:anchor-rects', id: host.id, rects, camera: cam, moving })
      if (locked) outline(lock, locked)
    })
  }

  const provider = {
    /** true once the engine is up: before that a pick is refused, never a canvas-wide comment */
    ready: () => !!host.engine(),
    hover(e: MouseEvent): { label: string } | null {
      const eng = host.engine()
      if (!eng || locked) return null
      const a = anchorAt(e.clientX, e.clientY, false)
      if (!a) return null
      if ('refused' in a) { outline(box, null); hoverKey = ''; return { label: a.refused } }
      const d = a.anchor.el!.draw!
      const key = d.id ?? 'paper'
      if (key !== hoverKey) { hoverKey = key; outline(box, a.anchor) }
      else if (d.at) outline(box, a.anchor)
      const words = d.id ? (a.anchor.el as any).semantics.quote : ''
      return { label: d.id ? (words ? `${d.type} · “${String(words).slice(0, 40)}”` : String(d.type)) : 'paper' }
    },
    unhover() { hoverKey = ''; box.style.display = 'none' },
    /** a click: the anchor, or null (a drag that panned, not ready, an unusual id) */
    pick(e: MouseEvent): (Anchor & Record<string, unknown>) | null {
      if (travelled >= 4) return null
      const a = anchorAt(e.clientX, e.clientY, true)
      if (!a || 'refused' in a) return null
      return a.anchor
    },
    lock(a: Anchor | null) {
      locked = a && a.el?.draw ? a : null
      provider.unhover()
      outline(lock, locked)
    },
    resolve(list: Req[]): PinRect[] {
      watched = list.filter((q) => q.anchor?.el?.draw)
      const eng = host.engine()
      lastJson = ''
      if (!eng) return []          // not ready: no answer yet (never an orphan, never the whole canvas)
      return list.map((q) => (q.anchor?.el?.draw ? place(eng, q) : ({ key: q.key, orphan: true } as PinRect)))
    },
    /** the camera, elements or gestures changed: pins follow */
    changed(isMoving: boolean) { moving = isMoving; if (watched.length) push(); if (locked) outline(lock, locked) },
    /** a comment opened on purpose: bring its element into view, once */
    reveal(a: Anchor) {
      const eng = host.engine()
      const d = a?.el?.draw
      if (!eng || !d) return
      if (d.at) { eng.reveal({ x: d.at.x - 40, y: d.at.y - 40, w: 80, h: 80 }); return }
      const g = d.id ? eng.geo(d.id) : null
      if (g) eng.reveal({ x: g.x, y: g.y, w: g.w, h: g.h })
    },
  }
  ;(window as unknown as { __mvAnchorProvider?: typeof provider }).__mvAnchorProvider = provider
  return provider
}
