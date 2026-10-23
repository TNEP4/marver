/**
 * What a canvas's logo is, by its bytes (spec 28 A2.4, A2.9, A2.14 #24): the one sniff both sides run - the server's
 * `findLogo` before it serves or publishes a file, and the Mac app on every logo it fetches - so a file's name never
 * decides its type, and nothing that is not one of three image types is ever shown or served as a logo.
 *
 * - PNG: its 8-byte signature;
 * - ICO: the header `00 00 01 00`;
 * - SVG: UTF-8 text whose root element is `<svg`, after an optional byte-order mark, an optional XML declaration,
 *   comments, and at most one `<!DOCTYPE svg ...>` without an internal subset (Illustrator and Inkscape write one;
 *   a `[` - an internal subset, where entities live - fails it).
 *
 * Pure and dependency-free: the app's main bundle takes it as it is.
 */

export type LogoType = 'png' | 'ico' | 'svg'

/** The most a logo may weigh, on either side: a file past it is never read whole, a fetch past it is aborted. */
export const LOGO_MAX = 256 * 1024

/** The type each sniffed logo is served with. */
export const LOGO_MIME: Record<LogoType, string> = { png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml' }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The logo type these bytes are, or null when they are none of the three. */
export function sniffLogo(b: Uint8Array): LogoType | null {
  if (b.length >= PNG.length && PNG.every((x, i) => b[i] === x)) return 'png'
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico'
  return svgRoot(b) ? 'svg' : null
}

/** Is this UTF-8 text an SVG document: its root element `<svg`, with only the prolog A2.14 #24 allows before it? */
function svgRoot(b: Uint8Array): boolean {
  let s: string
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { return false }
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0
  const space = () => { while (i < s.length && /\s/.test(s[i])) i++ }
  space()
  if (s.startsWith('<?xml', i) && /[\s?]/.test(s[i + 5] ?? '')) {
    const end = s.indexOf('?>', i)
    if (end < 0) return false
    i = end + 2
  }
  let doctype = false
  for (;;) {
    space()
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      if (end < 0) return false
      i = end + 3
      continue
    }
    if (s.startsWith('<!DOCTYPE', i)) {
      if (doctype) return false
      doctype = true
      const end = doctypeEnd(s, i + 9)
      if (end < 0) return false
      i = end
      continue
    }
    break
  }
  return s.startsWith('<svg', i) && /[\s>/]/.test(s[i + 4] ?? '')
}

/** Just past the `>` that closes a `<!DOCTYPE svg ...>` whose body starts at `i`, or -1: another root name, an
 *  internal subset (`[` outside quotes) or no end. Quoted public and system ids may hold anything but their quote. */
function doctypeEnd(s: string, i: number): number {
  if (!/\s/.test(s[i] ?? '')) return -1
  while (i < s.length && /\s/.test(s[i])) i++
  if (!s.startsWith('svg', i) || !/[\s>]/.test(s[i + 3] ?? '')) return -1
  i += 3
  while (i < s.length) {
    const c = s[i]
    if (c === '>') return i + 1
    if (c === '[') return -1
    if (c === '"' || c === "'") {
      const close = s.indexOf(c, i + 1)
      if (close < 0) return -1
      i = close + 1
      continue
    }
    i++
  }
  return -1
}
