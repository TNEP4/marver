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
  const shown = (el: Element, W: number, H: number): Rect | null => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    const ck = (el as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility
    if (ck && !ck.call(el, { opacityProperty: true, visibilityProperty: false })) return null
    let x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom)
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
    return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
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
    stage(W: number, H: number): void {
      let st = document.getElementById('mv-pdf-stage')
      if (!st) { st = document.createElement('style'); st.id = 'mv-pdf-stage'; document.head.appendChild(st) }
      st.textContent = `@page { size: ${W}px ${H}px; margin: 0 }
html { width: ${W}px !important; height: ${H}px !important; overflow: hidden !important }
*, *::before, *::after { break-before: auto !important; break-after: auto !important; break-inside: auto !important;
  page-break-before: auto !important; page-break-after: auto !important; page-break-inside: auto !important;
  -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important }`
    },
    detect(W: number, H: number, dropShadowPrints: boolean): Hit[] {
      const out: Hit[] = []
      for (const el of Array.from(document.querySelectorAll('[data-mv-pdf]'))) el.removeAttribute('data-mv-pdf')
      for (const el of Array.from(document.querySelectorAll('[data-mv-pdf-sh]'))) el.removeAttribute('data-mv-pdf-sh')
      hits.clear(); shadowFix.clear()
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
          if (kind && k instanceof SVGElement && k.tagName !== 'svg') { target = (k as SVGElement).ownerSVGElement ?? k; kind = 'whole' }
          if (kind) {
            const rect = shown(target, W, H)
            if (rect) {
              if (target.hasAttribute('data-mv-pdf')) continue
              const i = out.length
              target.setAttribute('data-mv-pdf', String(i))
              hits.set(i, target as HTMLElement)
              out.push({ i, kind, why: whole || media || 'backdrop-filter', rect, transformed: transformed(target), replaced: REPLACED.has(target.tagName) })
              if (kind === 'whole' || target !== k) continue
            } else if (kind === 'whole') continue
          }
          if (!(k instanceof SVGElement)) visit(k)
        }
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
    links(): { href: string; rects: Rect[] }[] {
      const out: { href: string; rects: Rect[] }[] = []
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (a as HTMLAnchorElement).href
        if (!/^(https?:|mailto:)/i.test(href)) continue
        const rects = Array.from(a.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
        if (rects.length) out.push({ href, rects })
      }
      return out
    },
    /** the state patch `i` is captured in: the elements drawn after it and over its box hidden, its ancestors at full
     *  opacity; a glass element also without its own content, border and shadow (they stay live) */
    prepare(i: number): Rect | null {
      restoreStyles()
      const el = hits.get(i)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const box = { x: r.left, y: r.top, w: r.width, h: r.height }
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
          const img = el as HTMLImageElement
          const W = img.offsetWidth, H = img.offsetHeight
          img.removeAttribute('srcset'); img.removeAttribute('sizes'); img.loading = 'eager'
          img.src = p.url
          keep(img, 'box-sizing', 'border-box'); keep(img, 'width', `${W}px`); keep(img, 'height', `${H}px`)
          keep(img, 'padding', '0'); keep(img, 'border-width', '0'); keep(img, 'object-fit', 'fill'); keep(img, 'object-position', '0 0')
          keep(img, 'filter', 'none'); keep(img, 'mix-blend-mode', 'normal'); keep(img, 'box-shadow', 'none'); keep(img, 'mask', 'none'); keep(img, '-webkit-mask', 'none')
        } else if (REPLACED.has(el.tagName)) {
          const img = document.createElement('img')
          const W = (el as HTMLElement).offsetWidth ?? r.width, H = (el as HTMLElement).offsetHeight ?? r.height
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
          // a box with children: it keeps its place in layout and in paint order; what it drew is the capture, as an
          // image filling its border box; its own children and pseudo-elements are hidden, its effect taken off
          keep(el, 'filter', 'none'); keep(el, 'mix-blend-mode', 'normal'); keep(el, 'backdrop-filter', 'none'); keep(el, '-webkit-backdrop-filter', 'none')
          keep(el, 'mask', 'none'); keep(el, '-webkit-mask', 'none')
          keep(el, 'isolation', 'isolate')
          keep(el, 'color', 'transparent'); keep(el, '-webkit-text-fill-color', 'transparent'); keep(el, 'text-shadow', 'none')
          keep(el, 'border-color', 'transparent')
          if (/inset/.test(cs.boxShadow)) keep(el, 'box-shadow', 'none')
          // hidden, not merely transparent: Chrome's PDF backend still draws a transparent descendant's filter (a grey box)
          rules += `[data-mv-pdf="${p.i}"] *, [data-mv-pdf="${p.i}"] *::before, [data-mv-pdf="${p.i}"] *::after, [data-mv-pdf="${p.i}"]::before, [data-mv-pdf="${p.i}"]::after { visibility: hidden !important; opacity: 0 !important; filter: none !important; backdrop-filter: none !important; transition: none !important }\n`
          bg(el)
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
      if (!el) return []
      const out: { href: string; rects: Rect[] }[] = []
      for (const a of Array.from(el.querySelectorAll('a[href]'))) {
        const href = (a as HTMLAnchorElement).href
        if (!/^(https?:|mailto:)/i.test(href)) continue
        const rects = Array.from(a.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }))
        if (rects.length) out.push({ href, rects })
      }
      return out
    },
  }
  w.__mvPdf = api
  return true
}
export const PDF_INSTALL = `(${install.toString()})()`

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
    const sx = Math.max(0, Math.round(b.x * dsf)), sy = Math.max(0, Math.round(b.y * dsf))
    const sw = Math.max(1, Math.min(im.width - sx, Math.round(b.w * dsf))), sh = Math.max(1, Math.min(im.height - sy, Math.round(b.h * dsf)))
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
 * - `coarse`: the share of the page whose averages over 8 CSS px blocks differ by more than 32 levels - text drawn by
 *   another rasteriser differs at its edges, a missing or wrong area differs in its average (print certification).
 */
async function compare(a: string, b: string, dsf: number, boxes: { x: number; y: number; w: number; h: number }[], tol: number): Promise<{ boxes: number[]; outside: { gt32: number; n: number; blockMax: number }; coarse: number }> {
  const load = async (d: string) => { const im = new Image(); im.src = 'data:image/png;base64,' + d; await im.decode(); return im }
  const [ia, ib] = await Promise.all([load(a), load(b)])
  const W = ia.width, H = ia.height
  const px = (im: HTMLImageElement) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.imageSmoothingQuality = 'high'
    g.drawImage(im, 0, 0, W, H)
    return g.getImageData(0, 0, W, H).data
  }
  const A = px(ia), B = px(ib)
  const d = (p: number) => { const i = p * 4; return Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) }
  const owned = new Uint8Array(W * H)
  const inBoxes = boxes.map((bx) => {
    const x0 = Math.max(0, Math.floor(bx.x * dsf)), y0 = Math.max(0, Math.floor(bx.y * dsf))
    const x1 = Math.min(W, Math.ceil((bx.x + bx.w) * dsf)), y1 = Math.min(H, Math.ceil((bx.y + bx.h) * dsf))
    let bad = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = y * W + x; owned[p] = 1; n++; if (d(p) > tol) bad++ }
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
  return { boxes: inBoxes, outside: { gt32, n, blockMax }, coarse: cw * ch ? coarseBad / (cw * ch) : 0 }
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
