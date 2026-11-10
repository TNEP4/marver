/**
 * What every app page shares (spec 28 A2.5, A2.13, A2.14 #26): elements built with text only - main's strings never
 * reach a page as markup (`textContent`, never `innerHTML`), a logo only as a `data:` URL main checked - the page
 * API the preload exposes, the look (the app's theme from `prefers-color-scheme`, or a tab's own), and the words for
 * time. Bundled into each page's one IIFE (tsdown.config.ts); no imports from Electron or Node.
 */
import type { PageApi } from '../shared/channels.ts'
import { HUES, hueOf, initials } from '../shared/hue.ts'

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>
type Child = Node | string | null | undefined | false

/** An element: attributes (on* are listeners; false/null/undefined skipped), then children as text or nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue
    if (typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (k === 'text') el.textContent = String(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return el
}

/** Replaces an element's children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false))
}

// Phosphor regular paths (MIT (c) Phosphor Icons), as the shell's icons.tsx and the hi-fi kit draw them.
const PATHS = {
  house: 'M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z',
  warning: 'M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z',
  link: 'M165.66,90.34a8,8,0,0,1,0,11.32l-64,64a8,8,0,0,1-11.32-11.32l64-64A8,8,0,0,1,165.66,90.34ZM215.6,40.4a56,56,0,0,0-79.2,0L106.34,70.45a8,8,0,0,0,11.32,11.32l30.06-30a40,40,0,0,1,56.57,56.56l-30.07,30.06a8,8,0,0,0,11.31,11.32L215.6,119.6a56,56,0,0,0,0-79.2ZM138.34,174.22l-30.06,30.06a40,40,0,1,1-56.56-56.57l30.05-30.05a8,8,0,0,0-11.32-11.32L40.4,136.4a56,56,0,0,0,79.2,79.2l30.06-30.07a8,8,0,0,0-11.32-11.31Z',
  gear: 'M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z',
  copy: 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z',
  x: 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
  check: 'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z',
  // spec 32 E3: the menus' and Home's icons (Phosphor regular; the shell's icons.tsx and the Home design, HT:57-62)
  'arrow-square-out': 'M224,104a8,8,0,0,1-16,0V59.32l-66.33,66.34a8,8,0,0,1-11.32-11.32L196.68,48H152a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z',
  'folder-open': 'M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z',
  'check-square-offset': 'M224,48V208a16,16,0,0,1-16,16H136a8,8,0,0,1,0-16h72V48H48v96a8,8,0,0,1-16,0V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48ZM125.66,154.34a8,8,0,0,0-11.32,0L64,204.69,45.66,186.34a8,8,0,0,0-11.32,11.32l24,24a8,8,0,0,0,11.32,0l56-56A8,8,0,0,0,125.66,154.34Z',
  'arrow-clockwise': 'M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z',
  'arrow-right': 'M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z',
  'arrow-up': 'M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z',
  signpost: 'M246,106.65,212.33,69.3A16,16,0,0,0,200.44,64H136V32a8,8,0,0,0-16,0V64H40A16,16,0,0,0,24,80v64a16,16,0,0,0,16,16h80v64a8,8,0,0,0,16,0V160h64.44a16,16,0,0,0,11.89-5.3L246,117.35A8,8,0,0,0,246,106.65ZM200.44,144H40V80H200.44l28.8,32Z',
  'dots-vertical': 'M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128ZM128,72a12,12,0,1,0-12-12A12,12,0,0,0,128,72Zm0,112a12,12,0,1,0,12,12A12,12,0,0,0,128,184Z',
  sliders: 'M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Zm64-24A16,16,0,1,1,88,80,16,16,0,0,1,104,64ZM216,168H199a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16h97a32,32,0,0,0,62,0h17a8,8,0,0,0,0-16Zm-48,24a16,16,0,1,1,16-16A16,16,0,0,1,168,192Z',
  grid: 'M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48v48Zm-96,32H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Zm0,64H152V152h48v48Z',
  board: 'M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V64A16,16,0,0,0,216,48ZM104,192H40V64h64Zm56,0H120V64h40Zm56,0H176V64h40Z',
} as const
export type IconName = keyof typeof PATHS
/** Spec 32 E3: every icon name, a runtime list (a4-contracts pins it; `PATHS` stays private). */
export const ICON_NAMES = Object.keys(PATHS) as IconName[]

/** A decorative icon (aria-hidden), drawn from a fixed path: never from a string a page was sent. */
export function icon(name: IconName, size = 16, cls = ''): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 256 256')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  if (cls) svg.setAttribute('class', cls)
  const p = document.createElementNS(ns, 'path')
  p.setAttribute('d', PATHS[name])
  svg.append(p)
  return svg
}

/** `logo()`'s options form (spec 32 E4): only the strip (A8) and Home (D5) use it, and only it trims. */
export interface LogoOptions {
  /** radius 50% (the string form keeps 28%) */
  round?: boolean
  /** the image's share of the circle, on its white plate (.91 strip, .88 Home); 1 when absent */
  plate?: number
  tone?: 'grey' | 'dim'
}

/** The initials' size at the options form's sizes (K:148, H:54, 83, 90); any other size scales. */
const INITIALS: Record<number, number> = { 24: 10, 26: 10, 30: 11, 36: 13 }

/**
 * A canvas's logo: main's checked `data:` URL in an `<img alt="">`, else its initials on its hue (A2.4). Decorative.
 * The string form (`tone`) draws as it always has (tab pages call it so). The options form trims the image to its
 * mark (E4, `trimLogo`): a resolved trim draws at once; a pending one draws the empty plate with its `img` marked
 * `data-trim="<key>"`, and when the trim lands every such `img` in the document takes the trimmed `src` (and its
 * `.logo` the `bleed` class), so a repaint that rebuilt the node since still gets it.
 */
export function logo(v: { name: string; logo?: string; hue?: number }, size: number, tone?: 'grey' | 'dim'): HTMLElement
export function logo(v: { name: string; logo?: string; hue?: number }, size: number, o: LogoOptions): HTMLElement
export function logo(v: { name: string; logo?: string; hue?: number }, size: number, t?: 'grey' | 'dim' | LogoOptions): HTMLElement {
  const o = typeof t === 'object' && t !== null ? t : null
  const tone = o ? o.tone : t as 'grey' | 'dim' | undefined
  const el = h('i', { class: `logo${tone ? ` ${tone}` : ''}${o?.round ? ' round' : ''}`, 'aria-hidden': 'true' })
  el.style.width = el.style.height = `${size}px`
  el.style.borderRadius = o?.round ? '50%' : `${Math.round(size * 0.28)}px`
  if (typeof v.logo === 'string' && v.logo.startsWith('data:image/')) {
    if (!o) {
      el.append(h('img', { src: v.logo, alt: '', draggable: 'false' }))
      return el
    }
    el.classList.add('plate')
    el.style.setProperty('--plate', `${Math.round(Math.min(1, Math.max(0, o.plate ?? 1)) * 1000) / 10}%`)
    const src = v.logo
    const key = trimKey(src)
    const img = h('img', { alt: '', draggable: 'false', 'data-trim': key })
    el.append(img)
    const done = trimmed.get(src)
    if (done) {
      img.src = done.src
      el.classList.toggle('bleed', done.cover)
    } else if (!waiting.has(key)) {
      waiting.add(key)
      void trimLogo(src).then((r) => {
        waiting.delete(key)
        for (const i of document.querySelectorAll<HTMLImageElement>(`img[data-trim="${key}"]`)) {
          i.src = r.src
          i.parentElement?.classList.toggle('bleed', r.cover)
        }
      })
    }
  } else {
    const b = h('b', {}, initials(v.name))
    const i = typeof v.hue === 'number' && v.hue >= 0 && v.hue < HUES.length ? Math.floor(v.hue) : hueOf(v.name)
    b.style.background = HUES[i]
    b.style.fontSize = `${o ? INITIALS[size] ?? Math.round(size * 0.42) : Math.round(size * 0.44)}px`
    el.append(b)
  }
  return el
}

export interface Trim { src: string; cover: boolean }
const N = 128
/** the trims asked for, by data URL */
const trims = new Map<string, Promise<Trim>>()
/** the trims landed, by data URL: a repaint draws these at once */
const trimmed = new Map<string, Trim>()
/** the keys whose landing a pending `logo()` already waits on */
const waiting = new Set<string>()

/** The cache's key for a data URL: a short hash (FNV-1a, 32 bits) and the length, safe in an attribute selector. */
export function trimKey(src: string): string {
  let x = 0x811c9dc5
  for (let i = 0; i < src.length; i++) { x ^= src.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0 }
  return `t${x.toString(16).padStart(8, '0')}${src.length.toString(36)}`
}

/**
 * A logo trimmed to its visible mark (spec 32 E4, a port of the kit's trim, KT:50-82): drawn contained (its aspect
 * kept, centred) in a 128 box; a white ground is read from the pixel 1 px inside the drawn rect's own top-left corner,
 * at whole-pixel coordinates (a fractional offset would index past the pixel array); ink is alpha > 24 and, on a
 * white ground, not near-white; the ink's bbox squared and drawn at 96. `cover` (a full-bleed mark: fill the circle)
 * when the ink fills more than .86 of its bbox. Any throw (a canvas tainted by an SVG's foreignObject) or a load
 * error settles as the image itself, never cover, so no plate stays empty. Cached by data URL.
 */
export function trimLogo(src: string): Promise<Trim> {
  const known = trims.get(src)
  if (known) return known
  const p = new Promise<Trim>((resolve) => {
    const done = (r: Trim) => { trimmed.set(src, r); resolve(r) }
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = c.height = N
        const g = c.getContext('2d', { willReadFrequently: true })
        if (!g) { done({ src, cover: false }); return }
        const iw = img.naturalWidth, ih = img.naturalHeight
        let dx = 0, dy = 0, dw = N, dh = N
        if (iw > 0 && ih > 0) {
          const s = Math.min(N / iw, N / ih)
          dw = iw * s; dh = ih * s; dx = (N - dw) / 2; dy = (N - dh) / 2
        }
        g.drawImage(img, dx, dy, dw, dh)
        const d = g.getImageData(0, 0, N, N).data
        const at = (x: number, y: number): [number, number, number, number] => { const i = (y * N + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]] }
        const sx = clampPx(Math.min(Math.ceil(dx) + 1, Math.floor(dx + dw) - 1))
        const sy = clampPx(Math.min(Math.ceil(dy) + 1, Math.floor(dy + dh) - 1))
        const [cr, cg, cb, ca] = at(sx, sy)
        const whiteGround = ca > 240 && cr > 235 && cg > 235 && cb > 235
        let x0 = N, y0 = N, x1 = -1, y1 = -1, n = 0
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const [r, gg, b, a] = at(x, y)
            if (a > 24 && !(whiteGround && r > 235 && gg > 235 && b > 235)) {
              n++
              if (x < x0) x0 = x
              if (x > x1) x1 = x
              if (y < y0) y0 = y
              if (y > y1) y1 = y
            }
          }
        }
        if (x1 < 0) { done({ src, cover: false }); return }
        const w = x1 - x0 + 1, hh = y1 - y0 + 1, side = Math.max(w, hh)
        const out = document.createElement('canvas')
        out.width = out.height = 96
        const o = out.getContext('2d')
        if (!o) { done({ src, cover: false }); return }
        o.drawImage(c, x0 - (side - w) / 2, y0 - (side - hh) / 2, side, side, 0, 0, 96, 96)
        done({ src: out.toDataURL(), cover: n / (w * hh) > 0.86 })
      } catch {
        done({ src, cover: false })
      }
    }
    img.onerror = () => done({ src, cover: false })
    img.src = src
  })
  trims.set(src, p)
  return p
}
const clampPx = (v: number): number => Math.min(N - 1, Math.max(0, v))

/**
 * The Marver app's own mark (spec 32 E6): `app-mark.png` (pages/shared, 256 px, from build/Marver.icns) in a box of
 * `size`, radius `size * .225`, the image at `size * 1024 / 824` with margin `-size * 100 / 824` - the icon's
 * transparent macOS margin cropped, as the design draws it (HT:52-56). Decorative.
 */
export function appMark(size: number): HTMLElement {
  const el = h('i', { class: 'mv-mark', 'aria-hidden': 'true' })
  el.style.width = el.style.height = `${size}px`
  el.style.borderRadius = `${size * 0.225}px`
  const img = h('img', { src: 'app-mark.png', alt: '', draggable: 'false' })
  img.style.width = img.style.height = `${size * 1024 / 824}px`
  img.style.margin = `${-size * 100 / 824}px`
  el.append(img)
  return el
}

/** The preload's API for this page, or null on any other document. */
export function pageApi<K extends PageApi['kind']>(kind: K): Extract<PageApi, { kind: K }> | null {
  const api = (window as unknown as { marverPage?: PageApi }).marverPage
  return api && api.kind === kind ? api as Extract<PageApi, { kind: K }> : null
}

const scheme = matchMedia('(prefers-color-scheme: dark)')
let look: boolean | undefined

/** The look: a tab's own (`dark`), or with undefined the app's theme, followed live (`theme.json` mode drives it). */
export function setLook(dark?: boolean): void {
  look = dark
  document.documentElement.classList.toggle('dark', dark ?? scheme.matches)
}
scheme.addEventListener('change', () => setLook(look))

/** The page has drawn: show it (until then its view's own background shows, never a wrong ground). */
export function shown(): void {
  document.documentElement.classList.add('mv-ready')
}

/** `14:02`. */
export const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * "just now", "20 minutes ago", "2 hours ago", "yesterday", "3 days ago", else the date: "Oct 27" inside the current
 * year, with the year otherwise (spec 32 E5). The pages pass no locale (the Mac's own).
 */
export function ago(t: number, now = Date.now(), locale?: string): string {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`
  const hrs = Math.floor(m / 60)
  if (hrs < 24) return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`
  const d = Math.floor(hrs / 24)
  if (d === 1) return 'yesterday'
  if (d < 14) return `${d} days ago`
  return new Date(t).toLocaleDateString(locale ?? [], agoDate(t, now))
}

/** `ago()`'s date options past 13 days: the year only when it is not the current one. */
export function agoDate(t: number, now = Date.now()): Intl.DateTimeFormatOptions {
  return new Date(t).getFullYear() === new Date(now).getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }
}

/** `localhost:4806` from a tab's people link, or null. */
export function hostOf(link?: string): string | null {
  if (!link) return null
  try { return new URL(link).host || null } catch { return null }
}

/** A port from a tab's people link, or null. */
export function portOf(link?: string): number | null {
  if (!link) return null
  try { const p = Number(new URL(link).port); return Number.isInteger(p) && p > 0 ? p : null } catch { return null }
}

const queued = new WeakMap<HTMLElement, string[]>()
/**
 * A polite announcement in the page's live region; the same words twice are said twice. Words said within the same
 * 30 ms are said together, in order - one never replaces another.
 */
export function say(region: HTMLElement, words: string): void {
  const q = queued.get(region)
  if (q) { if (!q.includes(words)) q.push(words); return }
  const list = [words]
  queued.set(region, list)
  region.textContent = ''
  setTimeout(() => {
    queued.delete(region)
    region.textContent = list.length === 1 ? list[0] : list.map((w) => w.replace(/[.\s]+$/, '')).join('. ')
  }, 30)
}

/**
 * A command that is its own button: one click copies it (the shell's update pill does the same). It says "Copied" only
 * when `onCopy` answers true - main said it copied; a send that main may refuse (an old `rev`) answers false, and a
 * rejected invoke counts as false.
 */
export function cmdButton(text: string, label: string, onCopy: () => Promise<boolean> | boolean): HTMLButtonElement {
  const btn = h('button', { class: 'cmd', type: 'button', 'aria-label': label, title: label })
  const code = h('code', {}, text)
  const tail = h('span', { class: 'cmd-tail' }, icon('copy', 12))
  btn.append(code, tail)
  let timer: ReturnType<typeof setTimeout> | undefined
  btn.addEventListener('click', async () => {
    let ok = false
    try { ok = (await onCopy()) === true } catch { ok = false }
    if (!ok) return
    btn.classList.add('copied')
    fill(tail, h('span', { class: 'cmd-copied' }, 'Copied'))
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { btn.classList.remove('copied'); fill(tail, icon('copy', 12)) }, 1500)
  })
  return btn
}
