/**
 * Your own breakpoints (spec 31 Part F): what a device shows as - its glyph and its label. Pure, shared by the
 * server (which resolves design/config.ts's `viewports.<name>.icon` and `.label` once, at load) and the shell (which
 * falls back to the same rules for a device name it has no resolved look for, e.g. a Jam step recorded earlier).
 */

/** The built-in device glyphs, as `viewports.<name>.icon` may name them (a `-landscape` suffix rotates one). */
export const DEVICE_GLYPHS = ['mobile', 'tablet', 'laptop', 'monitor', 'tv', 'watch', 'desktop', 'ereader'] as const
export type DeviceGlyph = typeof DEVICE_GLYPHS[number]

/** How a device shows: its label, and a built-in glyph (null: the generic devices glyph) turned a quarter for a
 *  landscape device - or `mask`, a sanitized SVG as a `data:image/svg+xml;base64,` URI drawn as a CSS mask in the
 *  ink (never inline DOM). */
export interface DeviceLook { label: string; glyph: DeviceGlyph | null; rotate: boolean; mask?: string }

/** The longest label a device carries. */
export const DEVICE_LABEL_MAX = 40

const words = (name: string): string[] => name.split(/[^A-Za-z0-9]+/).filter(Boolean)
const tokens = (name: string): string[] => words(name).map((w) => w.toLowerCase())

/** A `-landscape` device: the name says so (a word of its own). */
export const isLandscape = (name: string): boolean => tokens(name).includes('landscape')

/** The glyph a device's NAME suggests, or null (the generic devices glyph). Class words first (`pixel-tablet` is a
 *  tablet), then the brands. */
export function glyphFromName(name: string): DeviceGlyph | null {
  const t = tokens(name)
  const has = (...w: string[]) => t.some((x) => w.includes(x))
  const starts = (p: string) => t.some((x) => x.startsWith(p))
  // the class words: what a device IS beats whose it is
  if (has('tablet')) return 'tablet'
  if (has('laptop')) return 'laptop'
  if (has('phone', 'mobile', 'smartphone')) return 'mobile'
  if (has('monitor', 'desktop')) return 'monitor'
  if (has('tv')) return 'tv'
  if (has('watch')) return 'watch'
  if (has('ereader')) return 'ereader'
  // the brands and the models
  if (starts('iphone') || has('android', 'pixel')) return 'mobile'
  if (starts('ipad') || has('boox', 'kindle')) return 'tablet'
  if (starts('macbook')) return 'laptop'
  if (has('imac', 'studio')) return 'monitor'
  return null
}

/** Brand casing, by word: "ipad" -> "iPad", "tv" -> "TV". */
const BRAND: Record<string, string> = {
  iphone: 'iPhone', ipad: 'iPad', imac: 'iMac', ipod: 'iPod', macbook: 'MacBook', mac: 'Mac', ios: 'iOS', ipados: 'iPadOS',
  macos: 'macOS', watchos: 'watchOS', tvos: 'tvOS', visionos: 'visionOS', tv: 'TV', appletv: 'Apple TV', android: 'Android', pixel: 'Pixel',
  galaxy: 'Galaxy', samsung: 'Samsung', kindle: 'Kindle', boox: 'Boox', kobo: 'Kobo', remarkable: 'reMarkable', surface: 'Surface',
  chromebook: 'Chromebook', apple: 'Apple', google: 'Google', oneplus: 'OnePlus', xl: 'XL', hd: 'HD', uhd: 'UHD', fhd: 'FHD',
  qhd: 'QHD', '4k': '4K', '5k': '5K', '6k': '6K', '8k': '8K', xdr: 'XDR', oled: 'OLED', se: 'SE', xr: 'XR', xs: 'XS', ui: 'UI',
}
/** A model's suffix words, capitalised after a brand: "iphone-15-pro-max" -> "iPhone 15 Pro Max". */
const MODEL = new Set(['pro', 'max', 'plus', 'mini', 'air', 'ultra', 'fold', 'flip', 'lite', 'studio', 'display', 'note'])
/** Brands that start a model name, so the words after them are its model words. */
const BRANDED = new Set(['iphone', 'ipad', 'imac', 'ipod', 'macbook', 'mac', 'pixel', 'galaxy', 'kindle', 'boox', 'kobo', 'remarkable', 'surface', 'chromebook', 'apple', 'google', 'samsung', 'oneplus', 'studio'])

/** A device's label from its NAME: the words humanized, brand casing kept ("ipad-landscape" -> "iPad landscape",
 *  "boox-full" -> "Boox full", "iphone-15-pro" -> "iPhone 15 Pro"). The first word starts capitalised, the rest stay
 *  as written; a word already carrying capitals keeps them ("myDevice" stays "myDevice"). */
export function labelFromName(name: string): string {
  const ws = words(name)
  if (!ws.length) return name
  let branded = false
  return ws.map((w, i) => {
    const low = w.toLowerCase()
    // a brand word with a model number glued on: "iphone15" -> "iPhone15", "ipad13" -> "iPad13"
    const glued = /^([a-z]+)(\d+)$/.exec(low)
    const brand = BRAND[low] ?? (glued && BRANDED.has(glued[1]) && BRAND[glued[1]] ? BRAND[glued[1]] + glued[2] : undefined)
    const isBrand = BRANDED.has(low) || (!!glued && BRANDED.has(glued[1]))
    const out = brand ?? (/[A-Z]/.test(w) ? w
      : branded && MODEL.has(low) ? low[0].toUpperCase() + low.slice(1)
      : i === 0 ? low[0].toUpperCase() + low.slice(1)
      : low)
    if (isBrand) branded = true
    return out
  }).join(' ')
}

/** A built-in glyph as `viewports.<name>.icon` names it, with its rotation - or null when the value is no glyph. */
export function parseGlyph(v: string): { glyph: DeviceGlyph; rotate: boolean } | null {
  const m = /^([a-z]+)(-landscape)?$/.exec(v)
  return m && (DEVICE_GLYPHS as readonly string[]).includes(m[1]) ? { glyph: m[1] as DeviceGlyph, rotate: !!m[2] } : null
}

/** A device's look from its name alone - the shell's fallback, and the server's for a device with no `icon`/`label`. */
export const lookFromName = (name: string): DeviceLook => ({ label: labelFromName(name), glyph: glyphFromName(name), rotate: isLandscape(name) })
