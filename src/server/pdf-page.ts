/**
 * The scripts deck PDFs run inside a slide's own document and in the job's helper tab (spec 31 Part A) - plain
 * browser JavaScript, kept as functions here so they typecheck, and sent to Chrome by their source
 * (`Function.prototype.toString`). Nothing in them may close over this module: each takes its inputs as arguments.
 *
 * In the slide (`__mvPdf`, installed once per document by `PDF_INSTALL`):
 * - `freeze()`  - the finished slide, deterministically (#4): a finite animation is given `fill: both` and finished, an
 *                 infinite one paused at time 0 (its first pose), SVG SMIL paused, a video paused at its first frame;
 * - `clipped(W, H)` - does the document reach past the stage (#3)?
 * - `stage(W, H)` - the page geometry: `@page` at the stage size, the stage clipped, page breaks off, colours exact;
 * - `detect(W, H)` - the effects Chrome cannot print, outermost first (#7), each stamped `data-mv-pdf`;
 * - `links()`   - every `https:`/`http:`/`mailto:` link's boxes, for a raster page's annotations;
 * - `prepare(i)` / `restore()` - the state one patch's capture is taken in, and back;
 * - `apply(patches)` - every certified-to-be capture put in place.
 *
 * In the helper tab (an about:blank page of the job's own browser, never a slide): `crop` (a capture's boxes out of one
 * full screenshot) and `compare` (two pictures, inside boxes and outside them).
 */

/** Runs in the slide: installs `window.__mvPdf`. */
function install(): boolean {
  type Rect = { x: number; y: number; w: number; h: number }
  type Hit = { i: number; kind: 'glass' | 'whole' | 'shadow'; why: string; rect: Rect; transformed: boolean; replaced: boolean }
  const w = window as unknown as { __mvPdf?: unknown }
  if (w.__mvPdf) return true
  const touched: { el: HTMLElement | SVGElement; prop: string; value: string; prio: string }[] = []
  const setStyle = (el: HTMLElement | SVGElement, prop: string, value: string) => {
    touched.push({ el, prop, value: el.style.getPropertyValue(prop), prio: el.style.getPropertyPriority(prop) })
    el.style.setProperty(prop, value, 'important')
  }
  const restoreStyles = () => {
    for (let k = touched.length - 1; k >= 0; k--) {
      const t = touched[k]
      if (t.value) t.el.style.setProperty(t.prop, t.value, t.prio); else t.el.style.removeProperty(t.prop)
    }
    touched.length = 0
  }
  const hits = new Map<number, HTMLElement | SVGElement>()
  const shadowFix = new Map<number, Record<string, string>>()
  const kinds = new Map<number, string>()

  /** a filter list made only of drop-shadow()s (each may hold a colour function) */
  const dropOnly = (f: string): boolean => {
    let depth = 0, names: string[] = [], cur = ''
    for (const ch of f) {
      if (ch === '(') { if (depth === 0) names.push(cur.trim()); depth++; cur = '' }
      else if (ch === ')') depth--
      else if (depth === 0) cur += ch
    }
    return names.length > 0 && names.every((n) => n === 'drop-shadow')
  }
  const effectOf = (cs: CSSStyleDeclaration, dropShadowPrints: boolean): { glass: boolean; whole: string } => {
    const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none'
    const f = cs.filter || 'none'
    const bl = cs.mixBlendMode || 'normal'
    // a mask prints as if absent (measured on the build: a masked glyph shadow printed as a grey square)
    const mask = cs.maskImage || (cs as unknown as { webkitMaskImage?: string }).webkitMaskImage || 'none'
    const whole = f !== 'none' && !(dropShadowPrints && dropOnly(f)) ? `filter: ${f}` : bl !== 'normal' ? `mix-blend-mode: ${bl}` : mask !== 'none' ? 'mask-image' : ''
    return { glass: bf !== 'none', whole }
  }
  /** a transform that does not keep a box an upright box (a rotation, a skew, a flip, a perspective), on the element or
   *  any ancestor: a patch's capture would not map onto it. A move or a positive scale keeps it: the capture is the
   *  box's own border box, and the same transform takes both to the screen */
  const transformed = (el: Element): boolean => {
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const c = getComputedStyle(a)
      if (c.transform && c.transform !== 'none') {
        const m = /^matrix\(([^)]+)\)$/.exec(c.transform)
        if (!m) return true
        const v = m[1].split(',').map(Number)
        if (!(v[0] > 0) || !(v[3] > 0) || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6) return true
      }
      if (c.scale && c.scale !== 'none' && c.scale.split(/\s+/).some((x) => !(parseFloat(x) > 0))) return true
      if (c.rotate && c.rotate !== 'none' && !/^0(deg|rad|turn)?$/.test(c.rotate)) return true
    }
    return false
  }
  /** Large soft box-shadows print as solid grey boxes (Chrome's PDF backend, measured on the build): each blurred outer
   *  shadow is replaced by a stack of unblurred spread shadows that follows its Gaussian falloff - vector, and within a
   *  few levels of the blur on screen. Small ones print right and stay as they are. */
  const SHADOW_AREA = 20_000
  const splitTop = (v: string): string[] => {
    const out: string[] = []
    let d = 0, cur = ''
    for (const ch of v) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = '' } else cur += ch }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  /** a CSS colour as sRGB bytes and an alpha, read back through a 1x1 canvas (gamut-mapped like the screen) */
  let probe: CanvasRenderingContext2D | null = null
  const srgb = (c: string): [number, number, number, number] | null => {
    try {
      if (!probe) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; probe = cv.getContext('2d', { willReadFrequently: true }) }
      if (!probe) return null
      probe.clearRect(0, 0, 1, 1)
      probe.fillStyle = '#000'
      probe.fillStyle = c
      probe.fillRect(0, 0, 1, 1)
      const d = probe.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    } catch { return null }
  }
  const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y }
  const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))
  /** the element's box-shadow with each large blurred outer shadow stacked, and the extent it reaches; null when none needs it */
  const stackShadows = (v: string, w: number, h: number): { css: string; reach: number } | null => {
    if (!v || v === 'none') return null
    let changed = false, reach = 0
    const parts = splitTop(v).map((part) => {
      // `<color> x y blur spread` (an inset one ends in `inset` and stays); the colour in any syntax (oklch, lab...)
      const m = /^(.+?)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px$/.exec(part)
      if (!m) return part
      const rgba = srgb(m[1])
      if (!rgba) return part
      const [r, g, b, a] = rgba
      const x = Number(m[2]), y = Number(m[3]), B = Number(m[4]), S = Number(m[5])
      if (!(B >= 2) || !(a > 0) || (w + 2 * (B + S)) * (h + 2 * (B + S)) < SHADOW_AREA) return part
      changed = true
      reach = Math.max(reach, Math.abs(x) + B + Math.max(0, S), Math.abs(y) + B + Math.max(0, S))
      const sg = B / 2, N = 16, e = (k: number) => 2 * sg - k * (4 * sg / N)
      const layers: string[] = []
      let prev = 0
      for (let k = 0; k <= N; k++) {
        const A = k < N ? a * phi(-((e(k) + e(k + 1)) / 2) / sg) : a
        const ak = 1 - (1 - A) / (1 - prev)
        prev = A
        if (ak > 0.0005) layers.push(`rgba(${r}, ${g}, ${b}, ${ak.toFixed(4)}) ${x}px ${y}px 0px ${(S + e(k)).toFixed(2)}px`)
      }
      return layers.join(', ')
    })
    return changed ? { css: parts.join(', '), reach } : null
  }
  /** the element's box as the stage shows it: in the viewport, inside every clipping ancestor; null when nothing shows */
  /** the part of the stage an element can show in: the viewport, inside every clipping ancestor */
  const clipOf = (el: Element, W: number, H: number): { x0: number; y0: number; x1: number; y1: number } => {
    let x0 = 0, y0 = 0, x1 = W, y1 = H
    if (getComputedStyle(el).position !== 'fixed') {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const c = getComputedStyle(a)
        if (c.overflowX === 'visible' && c.overflowY === 'visible') continue
        const b = a.getBoundingClientRect()
        if (c.overflowX !== 'visible') { x0 = Math.max(x0, b.left); x1 = Math.min(x1, b.right) }
        if (c.overflowY !== 'visible') { y0 = Math.max(y0, b.top); y1 = Math.min(y1, b.bottom) }
        if (c.position === 'fixed') break
      }
    }
    return { x0, y0, x1, y1 }
  }
  const shown = (el: Element, W: number, H: number): Rect | null => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    const ck = (el as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
    if (ck && !ck.call(el, { opacityProperty: true, visibilityProperty: false })) return null
    const c = clipOf(el, W, H)
    const x0 = Math.max(c.x0, r.left), y0 = Math.max(c.y0, r.top), x1 = Math.min(c.x1, r.right), y1 = Math.min(c.y1, r.bottom)
    return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
  }
  /** How far past its border box an element's effect draws (CSS px): a blur's falloff, a drop-shadow, its own outer
   *  box-shadow - a whole patch captures that much around it, and paints it back from an overlay that may reach as far */
  const reachOf = (cs: CSSStyleDeclaration): number => {
    let e = 0
    const f = cs.filter || ''
    for (const m of f.matchAll(/(^|[\s)])blur\(([\d.]+)px\)/g)) e = Math.max(e, 3 * parseFloat(m[2]))
    for (const m of f.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const n = [...m[1].matchAll(/(-?[\d.]+)px/g)].map((x) => parseFloat(x[1]))
      e = Math.max(e, Math.max(Math.abs(n[0] || 0), Math.abs(n[1] || 0)) + 1.5 * (n[2] || 0))
    }
    if (cs.boxShadow && cs.boxShadow !== 'none') for (const part of splitTop(cs.boxShadow)) {
      if (/\binset\b/.test(part)) continue
      const n = [...part.matchAll(/(-?[\d.]+)px/g)].map((x) => parseFloat(x[1]))
      e = Math.max(e, Math.max(Math.abs(n[0] || 0), Math.abs(n[1] || 0)) + (n[2] || 0) + Math.max(0, n[3] || 0))
    }
    return e > 0 ? Math.ceil(e) + 2 : 0
  }
  /** per whole patch drawn by an overlay: how far its capture reaches past its border box on each side (CSS px, viewport) */
  const reaches = new Map<number, { l: number; t: number; r: number; b: number }>()
  /** every `https:`, `http:` or `mailto:` link under `root` with its boxes - an html `<a href>` or an svg `<a>` (whose
   *  href is an SVGAnimatedString, or an xlink:href), resolved against the document */
  const linksUnder = (root: ParentNode): { href: string; rects: Rect[] }[] => {
    const out: { href: string; rects: Rect[] }[] = []
    const W = innerWidth, H = innerHeight
    for (const a of Array.from(root.querySelectorAll('a'))) {
      const raw = a.getAttribute('href') ?? a.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      if (!raw) continue
      let href: string
      try { href = new URL(raw, document.baseURI).href } catch { continue }
      if (!/^(https?:|mailto:)/i.test(href)) continue
      // a link that does not show (hidden, transparent, display: none) is no link on the page
      const ck = (a as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
      if (ck && !ck.call(a, { opacityProperty: true, visibilityProperty: true })) continue
      // each box as much of it as shows: inside the stage and every clipping ancestor
      const clip = clipOf(a, W, H)
      const rects: Rect[] = []
      for (const r of Array.from(a.getClientRects())) {
        const x0 = Math.max(r.left, clip.x0), y0 = Math.max(r.top, clip.y0), x1 = Math.min(r.right, clip.x1), y1 = Math.min(r.bottom, clip.y1)
        if (x1 - x0 >= 1 && y1 - y0 >= 1) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
      }
      if (rects.length) out.push({ href, rects })
    }
    return out
  }
  const REPLACED = new Set(['IMG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'SELECT', 'TEXTAREA', 'svg'])

  const api = {
    freeze(): { finite: number; infinite: number; smil: number; video: number } {
      const out = { finite: 0, infinite: 0, smil: 0, video: 0 }
      for (const a of document.getAnimations()) {
        try {
          const eff = a.effect
          const t = eff ? eff.getComputedTiming() : null
          if (t && t.iterations === Infinity) { a.pause(); a.currentTime = 0; out.infinite++ }
          else { if (eff) eff.updateTiming({ fill: 'both' }); a.finish(); out.finite++ }
        } catch { /* an animation that cannot be finished (no end) is paused where it is */ try { a.pause() } catch { /* gone */ } }
      }
      for (const s of Array.from(document.querySelectorAll('svg'))) {
        try { if ((s as SVGSVGElement).animationsPaused && !(s as SVGSVGElement).animationsPaused()) { (s as SVGSVGElement).pauseAnimations(); out.smil++ } } catch { /* not an outer svg */ }
      }
      for (const v of Array.from(document.querySelectorAll('video'))) {
        try { v.pause(); v.autoplay = false; if (v.currentTime !== 0) v.currentTime = 0; out.video++ } catch { /* not seekable */ }
      }
      return out
    },
    clipped(W: number, H: number): boolean {
      const d = document.documentElement, b = document.body
      return Math.max(d.scrollHeight, b ? b.scrollHeight : 0) > H + 1 || Math.max(d.scrollWidth, b ? b.scrollWidth : 0) > W + 1
    },
    /** the page geometry, and nothing that lays the slide out again: `@page` at the stage size, every forced break off
     *  (content after one would leave page 1), colours exact. A document taller than its stage prints past page 1, which
     *  is dropped - the stage's own clip, without restyling html or body (which reflows a flex or grid body) */
    stage(W: number, H: number): void {
      let st = document.getElementById('mv-pdf-stage')
      if (!st) { st = document.createElement('style'); st.id = 'mv-pdf-stage'; document.head.appendChild(st) }
      st.textContent = `@page { size: ${W}px ${H}px; margin: 0 }
*, *::before, *::after { break-before: auto !important; break-after: auto !important; break-inside: auto !important;
  page-break-before: auto !important; page-break-after: auto !important; page-break-inside: auto !important;
  -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important }`
    },
    detect(W: number, H: number, dropShadowPrints: boolean): Hit[] {
      const out: Hit[] = []
      for (const el of Array.from(document.querySelectorAll('[data-mv-pdf]'))) el.removeAttribute('data-mv-pdf')
      for (const el of Array.from(document.querySelectorAll('[data-mv-pdf-sh]'))) el.removeAttribute('data-mv-pdf-sh')
      hits.clear(); shadowFix.clear(); reaches.clear()
      const visit = (el: Element) => {
        for (const k of Array.from(el.children)) {
          if (k.id === 'mv-pdf-links') continue
          const cs = getComputedStyle(k)
          if (cs.display === 'none') continue
          const own = effectOf(cs, dropShadowPrints)
          let whole = own.whole
          for (const ps of ['::before', '::after']) {
            const p = getComputedStyle(k, ps)
            if (!p.content || p.content === 'none' || p.content === 'normal' || p.display === 'none') continue
            const e = effectOf(p, dropShadowPrints)
            if (e.whole || e.glass) { whole = whole || `${ps} ${e.whole || 'backdrop-filter'}`; break }
          }
          const media = k.tagName === 'CANVAS' || k.tagName === 'VIDEO' ? k.tagName.toLowerCase() : ''
          let target: Element = k
          let kind: 'glass' | 'whole' | null = whole || media ? 'whole' : own.glass ? 'glass' : null
          // an effect inside an svg is the whole svg's: an <img> cannot go inside one
          if (kind && k instanceof SVGElement && k.tagName !== 'svg') {
            let top: SVGElement = k
            for (let o = (k as SVGElement).ownerSVGElement; o; o = o.ownerSVGElement) top = o
            target = top; kind = 'whole'
          }
          if (kind) {
            const rect = shown(target, W, H)
            if (rect) {
              if (target.hasAttribute('data-mv-pdf')) continue
              const i = out.length
              target.setAttribute('data-mv-pdf', String(i))
              hits.set(i, target as HTMLElement)
              let box = rect
              const tcs = getComputedStyle(target)
              if (kind === 'whole' && !REPLACED.has(target.tagName) && tcs.display !== 'inline' && tcs.overflowX === 'visible' && tcs.overflowY === 'visible') {
                const e = Math.max(reachOf(tcs), reachOf(getComputedStyle(target, '::before')), reachOf(getComputedStyle(target, '::after')))
                const x0 = Math.max(0, rect.x - e), y0 = Math.max(0, rect.y - e), x1 = Math.min(W, rect.x + rect.w + e), y1 = Math.min(H, rect.y + rect.h + e)
                reaches.set(i, { l: rect.x - x0, t: rect.y - y0, r: x1 - rect.x - rect.w, b: y1 - rect.y - rect.h })
                box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
              }
              out.push({ i, kind, why: whole || media || 'backdrop-filter', rect: box, transformed: transformed(target), replaced: REPLACED.has(target.tagName) })
              if (kind === 'whole' || target !== k) continue
            } else if (kind === 'whole') continue
          }
          // into an html element; inside an svg, every element is looked at and an effect is the outer svg's (visitSvg)
          if (!(k instanceof SVGElement)) visit(k)
          else visitSvg(k)
        }
      }
      // inside an svg every element is looked at (an effect makes its outer svg a whole patch, once)
      function visitSvg(el: Element): void { for (const c of Array.from(el.children)) { visitOne(c); visitSvg(c) } }
      function visitOne(c: Element): void {
        const e = effectOf(getComputedStyle(c), dropShadowPrints)
        if (!e.whole && !e.glass) return
        let top: Element = c
        for (let o = (c as SVGElement).ownerSVGElement; o; o = o.ownerSVGElement) top = o
        if (top.hasAttribute('data-mv-pdf')) return
        const rect = shown(top, W, H)
        if (!rect) return
        const i = out.length
        top.setAttribute('data-mv-pdf', String(i))
        hits.set(i, top as SVGElement)
        out.push({ i, kind: 'whole', why: e.whole || 'backdrop-filter', rect, transformed: transformed(top), replaced: true })
      }
      if (document.body) visit(document.body)
      // shadows: any element shown (and its pseudo-elements), outside the boxes a whole patch pictures
      const inWhole = (el: Element) => out.some((h) => h.kind === 'whole' && hits.get(h.i) !== el && hits.get(h.i)!.contains(el))
      for (const el of Array.from(document.body ? document.body.querySelectorAll('*') : [])) {
        if (el.id === 'mv-pdf-links' || inWhole(el)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const fixes: Record<string, string> = {}
        let reach = 0
        for (const ps of ['', '::before', '::after']) {
          const c = getComputedStyle(el, ps || null)
          if (ps && (!c.content || c.content === 'none' || c.content === 'normal')) continue
          const w = ps ? parseFloat(c.width) || r.width : r.width, h = ps ? parseFloat(c.height) || r.height : r.height
          const st = stackShadows(c.boxShadow, w, h)
          if (st) { fixes[ps || 'self'] = st.css; reach = Math.max(reach, st.reach) }
        }
        if (!Object.keys(fixes).length) continue
        const box = { x: r.left - reach, y: r.top - reach, w: r.width + 2 * reach, h: r.height + 2 * reach }
        if (box.x >= W || box.y >= H || box.x + box.w <= 0 || box.y + box.h <= 0) continue
        const i = out.length
        el.setAttribute('data-mv-pdf-sh', String(i))
        hits.set(i, el as HTMLElement)
        shadowFix.set(i, fixes)
        out.push({ i, kind: 'shadow', why: 'box-shadow', rect: box, transformed: transformed(el), replaced: false })
      }
      return out
    },
    links(): { href: string; rects: Rect[] }[] { return linksUnder(document) },
    /** the state patch `i` is captured in: the elements drawn after it and over its box hidden, its ancestors at full
     *  opacity; a glass element also without its own content, border and shadow (they stay live) */
    prepare(i: number): Rect | null {
      restoreStyles()
      const el = hits.get(i)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const reach = reaches.get(i)
      const box = reach ? { x: r.left - reach.l, y: r.top - reach.t, w: r.width + reach.l + reach.r, h: r.height + reach.t + reach.b } : { x: r.left, y: r.top, w: r.width, h: r.height }
      // an image is patched by its source: what it draws is its content box (its own border and padding stay live)
      if (el.tagName === 'IMG' && (kinds.get(i) ?? '') === 'whole') {
        const c = getComputedStyle(el)
        const px = (v: string) => parseFloat(v) || 0
        const l = px(c.borderLeftWidth) + px(c.paddingLeft), t = px(c.borderTopWidth) + px(c.paddingTop)
        const rr = px(c.borderRightWidth) + px(c.paddingRight), bb = px(c.borderBottomWidth) + px(c.paddingBottom)
        const k = (el as HTMLElement).offsetWidth ? r.width / ((el as HTMLElement).offsetWidth || 1) : 1
        box.x += l * k; box.y += t * k; box.w -= (l + rr) * k; box.h -= (t + bb) * k
      }
      const over = (b: DOMRect) => b.left < box.x + box.w && box.x < b.right && b.top < box.y + box.h && box.y < b.bottom
      for (const o of Array.from(document.body.querySelectorAll('*'))) {
        if (o === el || el.contains(o) || o.contains(el)) continue
        if (!(el.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
        if (!(o instanceof HTMLElement || o instanceof SVGElement) || !over(o.getBoundingClientRect())) continue
        setStyle(o, 'opacity', '0')
        setStyle(o, 'transition', 'none')
      }
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) if (getComputedStyle(a).opacity !== '1') setStyle(a, 'opacity', '1')
      if (getComputedStyle(el).opacity !== '1') setStyle(el, 'opacity', '1')
      const kind = kinds.get(i) ?? ''
      if (kind === 'glass') {
        for (const c of Array.from(el.children)) if (c instanceof HTMLElement || c instanceof SVGElement) { setStyle(c, 'opacity', '0'); setStyle(c, 'transition', 'none') }
        setStyle(el, 'color', 'transparent'); setStyle(el, '-webkit-text-fill-color', 'transparent'); setStyle(el, 'text-shadow', 'none')
        setStyle(el, 'border-color', 'transparent'); setStyle(el, 'box-shadow', 'none'); setStyle(el, 'outline-color', 'transparent')
        let ps = document.getElementById('mv-pdf-cap')
        if (!ps) { ps = document.createElement('style'); ps.id = 'mv-pdf-cap'; document.head.appendChild(ps) }
        ps.textContent = `[data-mv-pdf="${i}"]::before, [data-mv-pdf="${i}"]::after { opacity: 0 !important; transition: none !important }`
      }
      return box
    },
    restore(): void {
      restoreStyles()
      const ps = document.getElementById('mv-pdf-cap')
      if (ps) ps.textContent = ''
    },
    mark(i: number, kind: string): void { kinds.set(i, kind) },
    /** every capture put in place; links inside a whole patch kept as transparent links over it */
    apply(patches: { i: number; kind: 'glass' | 'whole' | 'shadow'; url: string; links: { href: string; rects: Rect[] }[] }[]): number {
      const keep = (el: HTMLElement | SVGElement, prop: string, value: string) => el.style.setProperty(prop, value, 'important')
      let rules = ''
      let layer = document.getElementById('mv-pdf-links')
      for (const p of patches) {
        const el = hits.get(p.i)
        if (!el) continue
        if (p.kind === 'shadow') {
          const fix = shadowFix.get(p.i) ?? {}
          for (const [ps, css] of Object.entries(fix)) {
            if (ps === 'self') keep(el, 'box-shadow', css)
            else rules += `[data-mv-pdf-sh="${p.i}"]${ps} { box-shadow: ${css} !important }\n`
          }
          continue
        }
        const cs = getComputedStyle(el)
        const bg = (e: HTMLElement | SVGElement) => {
          keep(e, 'background-color', 'transparent'); keep(e, 'background-image', `url("${p.url}")`)
          keep(e, 'background-size', '100% 100%'); keep(e, 'background-position', '0 0'); keep(e, 'background-repeat', 'no-repeat')
          keep(e, 'background-origin', 'border-box'); keep(e, 'background-clip', 'border-box'); keep(e, 'background-attachment', 'scroll')
        }
        if (p.kind === 'glass') {
          keep(el, 'backdrop-filter', 'none'); keep(el, '-webkit-backdrop-filter', 'none')
          bg(el)
          continue
        }
        const r = el.getBoundingClientRect()
        if (el.tagName === 'IMG') {
          // its geometry pinned as laid out (a new source must not resize it), then only its source swapped
          const img = el as HTMLImageElement
          keep(img, 'width', cs.width); keep(img, 'height', cs.height)
          if (img.parentElement?.tagName === 'PICTURE') for (const so of Array.from(img.parentElement.querySelectorAll('source'))) so.remove()
          img.removeAttribute('srcset'); img.removeAttribute('sizes'); img.loading = 'eager'
          img.src = p.url
          keep(img, 'object-fit', 'fill'); keep(img, 'object-position', '0 0')
          keep(img, 'filter', 'none'); keep(img, 'mix-blend-mode', 'normal'); keep(img, 'box-shadow', 'none'); keep(img, 'mask', 'none'); keep(img, '-webkit-mask', 'none')
        } else if (REPLACED.has(el.tagName)) {
          const img = document.createElement('img')
          // its border box as laid out (fractional), which the capture fills
          const px = (v: string) => parseFloat(v) || 0
          const extra = cs.boxSizing === 'border-box' ? [0, 0] : [px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth), px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth)]
          const W = px(cs.width) + extra[0], H = px(cs.height) + extra[1]
          const cls = el.getAttribute('class'); if (cls) img.setAttribute('class', cls)
          const sty = el.getAttribute('style'); if (sty) img.setAttribute('style', sty)
          img.setAttribute('data-mv-pdf', String(p.i))
          img.alt = el.getAttribute('aria-label') ?? ''
          img.src = p.url
          keep(img, 'display', cs.display === 'inline' ? 'inline-block' : cs.display)
          keep(img, 'box-sizing', 'border-box'); keep(img, 'width', `${W || r.width}px`); keep(img, 'height', `${H || r.height}px`)
          keep(img, 'padding', '0'); keep(img, 'border-width', '0'); keep(img, 'object-fit', 'fill'); keep(img, 'object-position', '0 0')
          keep(img, 'filter', 'none'); keep(img, 'mix-blend-mode', 'normal'); keep(img, 'box-shadow', 'none'); keep(img, 'vertical-align', cs.verticalAlign)
          keep(img, 'mask', 'none'); keep(img, '-webkit-mask', 'none')
          if ((el as HTMLMediaElement).pause) try { (el as HTMLMediaElement).pause() } catch { /* gone */ }
          el.replaceWith(img)
          hits.set(p.i, img)
        } else {
          // a box with children: it keeps its place in layout and in paint order; its effect is taken off, its own
          // children and pseudo-elements hidden, and what it drew comes back as the capture - from an overlay (its
          // ::after, absolutely placed over its border box and as far past it as the effect reached), else as its own
          // background
          keep(el, 'filter', 'none'); keep(el, 'mix-blend-mode', 'normal'); keep(el, 'backdrop-filter', 'none'); keep(el, '-webkit-backdrop-filter', 'none')
          keep(el, 'mask', 'none'); keep(el, '-webkit-mask', 'none')
          keep(el, 'isolation', 'isolate')
          keep(el, 'color', 'transparent'); keep(el, '-webkit-text-fill-color', 'transparent'); keep(el, 'text-shadow', 'none')
          keep(el, 'border-color', 'transparent')
          const reach = reaches.get(p.i)
          // hidden, not merely transparent: Chrome's PDF backend still draws a transparent descendant's filter (a grey box)
          rules += `[data-mv-pdf="${p.i}"] *, [data-mv-pdf="${p.i}"] *::before, [data-mv-pdf="${p.i}"] *::after, [data-mv-pdf="${p.i}"]::before${reach ? '' : `, [data-mv-pdf="${p.i}"]::after`} { visibility: hidden !important; opacity: 0 !important; filter: none !important; backdrop-filter: none !important; transition: none !important }\n`
          if (reach) {
            // in the element's own units (an ancestor's scale divides them), from its padding box's corner
            const he = el as HTMLElement
            const k = he.offsetWidth ? r.width / he.offsetWidth : 1
            const px = (v: string) => parseFloat(v) || 0
            if (cs.position === 'static') keep(el, 'position', 'relative')
            keep(el, 'box-shadow', 'none'); keep(el, 'background', 'none')
            const L = -(px(cs.borderLeftWidth) + reach.l / k), T = -(px(cs.borderTopWidth) + reach.t / k)
            const Wd = (r.width + reach.l + reach.r) / k, Hd = (r.height + reach.t + reach.b) / k
            rules += `[data-mv-pdf="${p.i}"]::after { content: "" !important; display: block !important; position: absolute !important; left: ${L}px !important; top: ${T}px !important; right: auto !important; bottom: auto !important; width: ${Wd}px !important; height: ${Hd}px !important; margin: 0 !important; padding: 0 !important; border: 0 !important; box-sizing: border-box !important; background: url("${p.url}") 0 0 / 100% 100% no-repeat !important; visibility: visible !important; opacity: 1 !important; filter: none !important; mix-blend-mode: normal !important; backdrop-filter: none !important; transform: none !important; clip-path: none !important; mask: none !important; -webkit-mask: none !important; box-shadow: none !important; z-index: auto !important; pointer-events: none !important; animation: none !important; transition: none !important }\n`
          } else {
            if (/inset/.test(cs.boxShadow)) keep(el, 'box-shadow', 'none')
            bg(el)
          }
        }
        if (p.links.length) {
          if (!layer) {
            layer = document.createElement('div'); layer.id = 'mv-pdf-links'
            layer.setAttribute('style', 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none')
            document.body.appendChild(layer)
          }
          for (const l of p.links) for (const b of l.rects) {
            const a = document.createElement('a')
            a.href = l.href
            a.setAttribute('style', `position:absolute;display:block;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;pointer-events:auto`)
            layer.appendChild(a)
          }
        }
      }
      if (rules) { const st = document.createElement('style'); st.id = 'mv-pdf-patch'; st.textContent = rules; document.head.appendChild(st) }
      return patches.length
    },
    /** the links inside patch `i`, taken before it is applied */
    linksIn(i: number): { href: string; rects: Rect[] }[] {
      const el = hits.get(i)
      return el ? linksUnder(el) : []
    },
  }
  w.__mvPdf = api
  return true
}
export const PDF_INSTALL = `(${install.toString()})()`

/** Runs at document start, before the frame's own code (Page.addScriptToEvaluateOnNewDocument): every finite animation
 *  is given `fill: both` as it starts - CSS animations on `animationstart`, script ones through Element.animate - so one
 *  that ends before the slide is ready still holds its end pose when it is frozen (#4). */
function early(): void {
  const keep = (a: Animation) => {
    try {
      const e = a.effect
      if (!e || e.getComputedTiming().iterations === Infinity) return
      const f = e.getTiming().fill
      if (f !== 'both' && f !== 'forwards') e.updateTiming({ fill: 'both' })
    } catch { /* an effect that takes no timing */ }
  }
  const sweep = () => { try { for (const a of document.getAnimations()) keep(a) } catch { /* not yet */ } }
  addEventListener('animationstart', sweep, true)
  addEventListener('transitionrun', sweep, true)
  const animate = Element.prototype.animate
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) { const a = animate.apply(this, args); keep(a); return a }
}
export const PDF_EARLY = `(${early.toString()})()`

/** Runs in the slide: settled when nothing it loads is still in flight (`marver shot`'s check, #6). */
export const SETTLED = `(() => {
  if (typeof window.__mvLodBusy === 'function' && window.__mvLodBusy() > 0) return false
  if (typeof window.__mvPosterBusy === 'function' && window.__mvPosterBusy() > 0) return false
  const H = window.innerHeight, W = window.innerWidth
  for (const im of document.images) {
    if (im.complete) continue
    const r = im.getBoundingClientRect()
    if (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue
    return false
  }
  for (const c of document.querySelectorAll('.mv-chart')) if (!c.querySelector('svg, canvas')) return false
  for (const d of document.querySelectorAll('.mv-diagram')) if (!d.querySelector('.mv-diagram-svg svg, .mv-diagram-err')) return false
  return true
})()`

/** Runs in the slide: every SVG `<image>` decoded (an export prints them; an undecoded one prints blank). */
export const SVG_IMAGES = `Promise.race([Promise.all(Array.from(document.querySelectorAll('image')).map((el) => { const href = el.getAttribute('href') || el.getAttribute('xlink:href'); if (!href) return 1; const im = new Image(); im.src = new URL(href, location.href).href; return im.decode().catch(() => 1) })), new Promise((r) => setTimeout(r, 3000))]).then(() => true)`

export const TWO_FRAMES = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'

/** Runs in the helper tab: cut each box (CSS px) out of one screenshot taken at `dsf`, as PNG and JPEG data URLs (the
 *  caller keeps the smaller, preferring PNG). */
async function crop(shot: string, dsf: number, boxes: { x: number; y: number; w: number; h: number }[]): Promise<{ png: string; jpeg: string }[]> {
  const im = new Image()
  im.src = 'data:image/png;base64,' + shot
  await im.decode()
  return boxes.map((b) => {
    // edges rounded to device pixels, as Chrome snaps a box's edges
    const sx = Math.max(0, Math.round(b.x * dsf)), sy = Math.max(0, Math.round(b.y * dsf))
    const sw = Math.max(1, Math.min(im.width - sx, Math.round((b.x + b.w) * dsf) - sx)), sh = Math.max(1, Math.min(im.height - sy, Math.round((b.y + b.h) * dsf) - sy))
    const c = document.createElement('canvas'); c.width = sw; c.height = sh
    c.getContext('2d')!.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh)
    return { png: c.toDataURL('image/png'), jpeg: c.toDataURL('image/jpeg', 0.92) }
  })
}
export const CROP = crop.toString()

/**
 * Runs in the helper tab: compare picture `b` with the reference `a` (both base64; `b` scaled to `a`'s size).
 * - inside each box (CSS px at `dsf`): the share of pixels whose largest channel differs by more than `tol`;
 * - outside every box: `marver`'s bake rule - changed pixels beyond 32 levels, and the worst 16x16 block;
 * - `coarse`: the share of the page whose averages over 8 CSS px blocks differ by more than 32 levels - a missing or
 *   wrong area differs in its average (print certification);
 * - `fine`: the share of pixels, of either picture, differing by more than 48 levels from every pixel within one pixel of
 *   them in the other - text drawn by another rasteriser differs only at its edges, a changed pattern everywhere.
 */
async function compare(a: string, b: string, dsf: number, boxes: { x: number; y: number; w: number; h: number }[], tol: number, atB = false): Promise<{ boxes: number[]; outside: { gt32: number; n: number; blockMax: number }; coarse: number; fine: number }> {
  const load = async (d: string) => { const im = new Image(); im.src = 'data:image/png;base64,' + d; await im.decode(); return im }
  const [ia, ib] = await Promise.all([load(a), load(b)])
  // `atB`: both at the second picture's size (a print rasterised at 2x against a 3x screenshot) - never upscaled
  const W = atB ? ib.width : ia.width, H = atB ? ib.height : ia.height
  dsf = atB ? dsf * (ib.width / ia.width) : dsf
  const px = (im: HTMLImageElement) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.imageSmoothingQuality = 'high'
    // on white paper: a page with no background of its own prints transparent, and a screenshot shows it white
    g.fillStyle = '#fff'
    g.fillRect(0, 0, W, H)
    g.drawImage(im, 0, 0, W, H)
    return g.getImageData(0, 0, W, H).data
  }
  const A = px(ia), B = px(ib)
  const d = (p: number) => { const i = p * 4; return Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) }
  /** pixel (x, y) of P has no pixel of Q within one pixel of it closer than `t` levels */
  const unmatched = (P: Uint8ClampedArray, Q: Uint8ClampedArray, x: number, y: number, t: number) => {
    const i = (y * W + x) * 4
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
      const j = (yy * W + xx) * 4
      if (Math.max(Math.abs(P[i] - Q[j]), Math.abs(P[i + 1] - Q[j + 1]), Math.abs(P[i + 2] - Q[j + 2])) <= t) return false
    }
    return true
  }
  const owned = new Uint8Array(W * H)
  const inBoxes = boxes.map((bx) => {
    const x0 = Math.max(0, Math.floor(bx.x * dsf)), y0 = Math.max(0, Math.floor(bx.y * dsf))
    const x1 = Math.min(W, Math.ceil((bx.x + bx.w) * dsf)), y1 = Math.min(H, Math.ceil((bx.y + bx.h) * dsf))
    // a pixel differs only when no pixel of the other picture within one device pixel matches it, both ways: a box
    // snapped a device pixel apart (a third of a CSS px at 3x) is the same picture, a line added beside white is not
    let bad = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = y * W + x; owned[p] = 1; n++; if (d(p) > tol && (unmatched(A, B, x, y, tol) || unmatched(B, A, x, y, tol))) bad++ }
    return n ? bad / n : 0
  })
  const cols = Math.ceil(W / 16), blocks = new Uint16Array(cols * Math.ceil(H / 16))
  let gt32 = 0, n = 0, blockMax = 0
  for (let p = 0; p < W * H; p++) {
    if (owned[p]) continue
    n++
    if (d(p) > 32) { gt32++; const k = Math.floor(p / W / 16) * cols + Math.floor((p % W) / 16); if (++blocks[k] > blockMax) blockMax = blocks[k] }
  }
  // averages over blocks of 8 CSS px
  const K = Math.max(2, Math.round(8 * dsf)), cw = Math.floor(W / K), ch = Math.floor(H / K)
  let coarseBad = 0
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let ra = 0, ga = 0, ba = 0, rb = 0, gb = 0, bb = 0
    for (let y = cy * K; y < cy * K + K; y++) for (let x = cx * K; x < cx * K + K; x++) {
      const i = (y * W + x) * 4
      ra += A[i]; ga += A[i + 1]; ba += A[i + 2]; rb += B[i]; gb += B[i + 1]; bb += B[i + 2]
    }
    const k2 = K * K
    if (Math.max(Math.abs(ra - rb), Math.abs(ga - gb), Math.abs(ba - bb)) / k2 > 32) coarseBad++
  }
  // the page pixel by pixel, each matched within one pixel of the other picture: text another rasteriser draws differs
  // at its edges only, a pattern changed (stripes swapped, a box moved) differs everywhere it is
  let fineBad = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d(y * W + x) <= 48) continue
    if (unmatched(A, B, x, y, 48) || unmatched(B, A, x, y, 48)) fineBad++
  }
  return { boxes: inBoxes, outside: { gt32, n, blockMax }, coarse: cw * ch ? coarseBad / (cw * ch) : 0, fine: fineBad / (W * H) }
}
export const COMPARE = compare.toString()

/** Runs in the helper tab: a PNG re-encoded as JPEG (a raster page, a handout picture), optionally scaled. */
async function toJpeg(png: string, quality: number, scale: number): Promise<string> {
  const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode()
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width * scale)); c.height = Math.max(1, Math.round(im.height * scale))
  const g = c.getContext('2d')!; g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', quality).slice('data:image/jpeg;base64,'.length)
}
export const TO_JPEG = toJpeg.toString()
