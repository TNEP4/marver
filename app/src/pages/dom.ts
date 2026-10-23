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
} as const
export type IconName = keyof typeof PATHS

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

/** A canvas's logo: main's checked `data:` URL in an `<img alt="">`, else its initials on its hue (A2.4). Decorative. */
export function logo(v: { name: string; logo?: string; hue?: number }, size: number, tone?: 'grey' | 'dim'): HTMLElement {
  const el = h('i', { class: `logo${tone ? ` ${tone}` : ''}`, 'aria-hidden': 'true' })
  el.style.width = el.style.height = `${size}px`
  el.style.borderRadius = `${Math.round(size * 0.28)}px`
  if (typeof v.logo === 'string' && v.logo.startsWith('data:image/')) {
    el.append(h('img', { src: v.logo, alt: '', draggable: 'false' }))
  } else {
    const b = h('b', {}, initials(v.name))
    const i = typeof v.hue === 'number' && v.hue >= 0 && v.hue < HUES.length ? Math.floor(v.hue) : hueOf(v.name)
    b.style.background = HUES[i]
    b.style.fontSize = `${Math.round(size * 0.44)}px`
    el.append(b)
  }
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

/** "just now", "20 minutes ago", "2 hours ago", "yesterday", "3 days ago", else the date. */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`
  const hrs = Math.floor(m / 60)
  if (hrs < 24) return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`
  const d = Math.floor(hrs / 24)
  if (d === 1) return 'yesterday'
  if (d < 14) return `${d} days ago`
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
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
