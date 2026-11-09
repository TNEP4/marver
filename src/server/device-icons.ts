/**
 * Your own breakpoints' icons and labels (spec 31 F.1, F.2): `viewports.<name>.icon` and `.label` in design/config.ts,
 * resolved once when the config loads into the look the shell draws (`DeviceLook`, src/shared/devices.ts).
 *
 * An `icon` is a built-in glyph (`tablet`, `tablet-landscape`, ...) or a repo-relative `.svg` path. The SVG is read
 * inside the repo only - the logo's file checks (logo.ts `readInside`: a regular file, never a symlink, its real path
 * inside the repo's, read as checked) at 32 KB at most - then REBUILT from a strict allowlist: the elements svg, g,
 * path, circle, ellipse, rect, line, polyline, polygon; geometry and paint attributes only, each value in a plain
 * charset (no `url(`, no `;`, no `:`, no quotes) - so no `style`, `class`, `id`, `href`, event handler, `foreignObject`,
 * `<script>`, `<use>`, `<image>`, entity or external URL survives. Anything else is dropped with its subtree; a DOCTYPE,
 * a malformed document or one that draws nothing is refused. What is left ships as a base64 `data:` URI the shell
 * draws as a CSS `mask-image` in the toolbar's ink: an image, never DOM - nothing in it can run or restyle the page.
 * A bad icon falls back to the name's glyph with one warning saying why.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { DEVICE_LABEL_MAX, lookFromName, parseGlyph, type DeviceLook } from '../shared/devices.ts'
import { readInside } from './logo.ts'

/** The largest icon file read. */
export const DEVICE_ICON_MAX = 32 * 1024

const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'])
const DRAWN = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'])
/** paint and presentation, on any element */
const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'vector-effect', 'paint-order', 'shape-rendering']
const GEOMETRY: Record<string, string[]> = {
  svg: ['viewBox', 'width', 'height', 'preserveAspectRatio'],
  g: [],
  path: ['d', 'pathLength'],
  circle: ['cx', 'cy', 'r', 'pathLength'],
  ellipse: ['cx', 'cy', 'rx', 'ry', 'pathLength'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength'],
  line: ['x1', 'y1', 'x2', 'y2', 'pathLength'],
  polyline: ['points', 'pathLength'],
  polygon: ['points', 'pathLength'],
}
const ALLOWED: Record<string, Set<string>> = Object.fromEntries(Object.entries(GEOMETRY).map(([el, a]) => [el, new Set([...a, ...PAINT])]))

/** A value's charset: numbers, words, separators, `#` colours, `%` - no `:` (schemes), `;`, quotes, `<`, `&`, `/`,
 *  backslashes. Parentheses only for the functions a transform or a colour is written with. */
const PLAIN = /^[-+.,%#\s0-9A-Za-z()]*$/
const FUNCS: Record<string, RegExp> = {
  transform: /^(matrix|translate|scale|rotate|skewx|skewy)$/i,
  fill: /^(rgb|rgba|hsl|hsla)$/i,
  stroke: /^(rgb|rgba|hsl|hsla)$/i,
}
const VALUE_MAX = 24_000

function valueOk(attr: string, v: string): boolean {
  if (v.length > VALUE_MAX || !PLAIN.test(v)) return false
  if (!v.includes('(') && !v.includes(')')) return true
  const ok = FUNCS[attr]
  if (!ok) return false
  // every `(` opens one allowed function, and nothing nests
  for (const m of v.matchAll(/([A-Za-z]*)\s*\(/g)) if (!ok.test(m[1])) return false
  return !/\([^)]*\(/.test(v)
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
/** XML's five entities and character references; null for anything else (a DTD's entity, which is refused). */
function unescapeXml(s: string): string | null {
  let bad = false
  const out = s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);?/g, (_m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(n) || n > 0x10ffff) { bad = true; return '' }
      return String.fromCodePoint(n)
    }
    if (e in ENTITY) return ENTITY[e]
    bad = true
    return ''
  })
  return bad ? null : out
}

const NAME = /^[A-Za-z_][-A-Za-z0-9_.:]*/

/** A sanitized SVG's text, or why it is refused. Pure: no file, no DOM. */
export function sanitizeSvg(src: string): { svg: string } | { error: string } {
  const text = src.replace(/^﻿/, '')
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { error: 'it declares a DOCTYPE or entities' }
  let i = 0
  const out: string[] = []
  /** open elements: their name and whether they are kept (a dropped one drops its whole subtree) */
  const stack: { name: string; kept: boolean }[] = []
  let rootSeen = false, rootClosed = false, drawn = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break
    i = lt
    if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i + 2); if (e < 0) return { error: 'it is not well-formed' }; i = e + 2; continue }
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); if (e < 0) return { error: 'it is not well-formed' }; i = e + 3; continue }
    if (text.startsWith('<![CDATA[', i)) { const e = text.indexOf(']]>', i + 9); if (e < 0) return { error: 'it is not well-formed' }; i = e + 3; continue }
    if (text.startsWith('<!', i)) return { error: 'it declares a DOCTYPE or entities' }
    if (text.startsWith('</', i)) {
      const m = NAME.exec(text.slice(i + 2))
      const e = text.indexOf('>', i + 2)
      if (!m || e < 0) return { error: 'it is not well-formed' }
      const top = stack.pop()
      if (!top || top.name !== m[0] || text.slice(i + 2 + m[0].length, e).trim()) return { error: 'it is not well-formed' }
      if (top.kept) out.push(`</${top.name}>`)
      if (!stack.length) rootClosed = true
      i = e + 1
      continue
    }
    // an opening tag: its name, then its attributes, each name="value" or name='value'
    const m = NAME.exec(text.slice(i + 1))
    if (!m) return { error: 'it is not well-formed' }
    if (rootClosed) return { error: 'it has more than one root' }
    const name = m[0]
    let k = i + 1 + name.length
    const attrs: [string, string][] = []
    let selfClose = false
    for (;;) {
      const ws = /^\s*/.exec(text.slice(k))![0].length
      k += ws
      if (text.startsWith('/>', k)) { selfClose = true; k += 2; break }
      if (text[k] === '>') { k += 1; break }
      if (!ws) return { error: 'it is not well-formed' }
      const an = NAME.exec(text.slice(k))
      if (!an) return { error: 'it is not well-formed' }
      k += an[0].length
      const eq = /^\s*=\s*/.exec(text.slice(k))
      if (!eq) return { error: 'it is not well-formed' }
      k += eq[0].length
      const q = text[k]
      if (q !== '"' && q !== "'") return { error: 'it is not well-formed' }
      const end = text.indexOf(q, k + 1)
      if (end < 0) return { error: 'it is not well-formed' }
      const raw = text.slice(k + 1, end)
      if (raw.includes('<')) return { error: 'it is not well-formed' }
      attrs.push([an[0], raw])
      k = end + 1
    }
    if (!stack.length && rootSeen) return { error: 'it has more than one root' }
    if (!stack.length) {
      if (name !== 'svg') return { error: 'its root is not <svg>' }
      rootSeen = true
    }
    const parentKept = stack.length ? stack[stack.length - 1].kept : true
    // a nested <svg> is not kept: one viewport, the root's
    const kept = parentKept && ELEMENTS.has(name) && (name !== 'svg' || !stack.length)
    if (kept) {
      const allowed = ALLOWED[name]
      const keep: string[] = []
      const seen = new Set<string>()
      for (const [an, raw] of attrs) {
        if (!allowed.has(an) || seen.has(an)) continue
        seen.add(an)
        const v = unescapeXml(raw)
        if (v === null || !valueOk(an, v.trim())) continue
        keep.push(` ${an}="${v.trim()}"`)
      }
      if (name === 'svg') {
        // without a viewBox the picture keeps its own width and height as one, so it scales as a mask
        const vb = attrs.find(([a]) => a === 'viewBox')
        const w = Number(attrs.find(([a]) => a === 'width')?.[1]), h = Number(attrs.find(([a]) => a === 'height')?.[1])
        out.push(`<svg xmlns="http://www.w3.org/2000/svg"${!vb && w > 0 && h > 0 ? ` viewBox="0 0 ${w} ${h}"` : ''}${keep.join('')}${selfClose ? '/>' : '>'}`)
      } else out.push(`<${name}${keep.join('')}${selfClose ? '/>' : '>'}`)
      if (DRAWN.has(name)) drawn++
    }
    if (selfClose) { if (!stack.length) rootClosed = true }
    else stack.push({ name, kept })
    i = k
  }
  if (!rootSeen) return { error: 'it has no <svg>' }
  if (stack.length || !rootClosed) return { error: 'it is not well-formed' }
  if (!drawn) return { error: 'it draws nothing (paths and shapes only)' }
  return { svg: out.join('') }
}

/** The sanitized SVG as the data URI the shell masks with - base64, so nothing in it can close a CSS `url()`. */
export const svgDataUri = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`

/** A repo-relative `.svg` icon, read and sanitized: its data URI, or why not. */
export function readDeviceIcon(root: string, rel: string): { mask: string } | { error: string } {
  if (isAbsolute(rel)) return { error: 'it is not a repo-relative path' }
  let realRoot: string
  try { realRoot = realpathSync(root) } catch { return { error: 'the repo is unreadable' } }
  const r = readInside(realRoot, resolve(realRoot, rel), DEVICE_ICON_MAX, /\.svg$/i, 'not an .svg', 'over 32 KB')
  if (typeof r === 'string') return { error: r }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(r) } catch { return { error: 'not UTF-8 text' } }
  const s = sanitizeSvg(text)
  return 'error' in s ? s : { mask: svgDataUri(s.svg) }
}

/** Each device's look: its `label` (40 characters at most) and `icon`, else what its name suggests. `warn` hears
 *  each value that could not be used - the device then wears its name's glyph or label. */
export function resolveDevices(root: string, raw: unknown, names: readonly string[], warn: (m: string) => void = () => {}): Record<string, DeviceLook> {
  const out: Record<string, DeviceLook> = {}
  const src = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  for (const name of names) {
    const look = lookFromName(name)
    const vp = src[name] && typeof src[name] === 'object' ? src[name] as { label?: unknown; icon?: unknown } : {}
    if (vp.label !== undefined) {
      const l = typeof vp.label === 'string' ? vp.label.trim() : ''
      if (l && l.length <= DEVICE_LABEL_MAX) look.label = l
      else warn(`design/config.ts: viewports.${name}.label must be text of 1 to ${DEVICE_LABEL_MAX} characters - showing "${look.label}"`)
    }
    if (vp.icon !== undefined) {
      const g = typeof vp.icon === 'string' ? parseGlyph(vp.icon) : null
      if (g) { look.glyph = g.glyph; look.rotate = g.rotate }
      else if (typeof vp.icon === 'string' && /\.svg$/i.test(vp.icon)) {
        const r = readDeviceIcon(root, vp.icon)
        if ('mask' in r) { look.mask = r.mask; look.rotate = false }
        else warn(`design/config.ts: viewports.${name}.icon ${vp.icon} is ignored: ${r.error} - showing the ${look.glyph ?? 'devices'} glyph`)
      } else warn(`design/config.ts: viewports.${name}.icon must be a built-in glyph (mobile, tablet, laptop, monitor, tv, watch, desktop, ereader; -landscape turns it) or a repo-relative .svg - showing the ${look.glyph ?? 'devices'} glyph`)
    }
    out[name] = look
  }
  return out
}
