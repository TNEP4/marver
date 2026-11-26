/**
 * Excalidraw 0.18.1's colour palette (its colors.ts): each hue's five shades, light to dark - the shades row of the colour
 * picker, and what counts as a "custom" colour for Most used (anything not in here). Shared by the draw host (which
 * counts the drawing's colours) and the shell's picker (spec 38).
 */
export const COLOR_SHADES: Record<string, readonly string[]> = {
  gray: ['#f8f9fa', '#e9ecef', '#ced4da', '#868e96', '#343a40'],
  bronze: ['#f8f1ee', '#eaddd7', '#d2bab0', '#a18072', '#846358'],
  red: ['#fff5f5', '#ffc9c9', '#ff8787', '#fa5252', '#e03131'],
  pink: ['#fff0f6', '#fcc2d7', '#f783ac', '#e64980', '#c2255c'],
  grape: ['#f8f0fc', '#eebefa', '#da77f2', '#be4bdb', '#9c36b5'],
  violet: ['#f3f0ff', '#d0bfff', '#9775fa', '#7950f2', '#6741d9'],
  blue: ['#e7f5ff', '#a5d8ff', '#4dabf7', '#228be6', '#1971c2'],
  cyan: ['#e3fafc', '#99e9f2', '#3bc9db', '#15aabf', '#0c8599'],
  teal: ['#e6fcf5', '#96f2d7', '#38d9a9', '#12b886', '#099268'],
  green: ['#ebfbee', '#b2f2bb', '#69db7c', '#40c057', '#2f9e44'],
  yellow: ['#fff9db', '#ffec99', '#ffd43b', '#fab005', '#f08c00'],
  orange: ['#fff4e6', '#ffd8a8', '#ffa94d', '#fd7e14', '#e8590c'],
}

/** Every colour of the palette (black, white, transparent and all shades) - lower case. */
export const PALETTE_COLORS: ReadonlySet<string> = new Set(['transparent', '#1e1e1e', '#ffffff', ...Object.values(COLOR_SHADES).flat()])

/** The five shades of the hue a colour belongs to, or null (black, white, transparent, a custom colour). */
export function shadesOf(color: string | null | undefined): readonly string[] | null {
  const c = (color ?? '').toLowerCase()
  for (const s of Object.values(COLOR_SHADES)) if (s.includes(c)) return s
  return null
}

/** The drawing's own custom colours (not in the palette), most used first, at most `max` - Excalidraw's Most used. */
export function mostUsedCustom(colors: Iterable<string | null | undefined>, max = 5): string[] {
  const n = new Map<string, number>()
  for (const raw of colors) {
    const c = (raw ?? '').toLowerCase()
    if (!c || PALETTE_COLORS.has(c)) continue
    n.set(c, (n.get(c) ?? 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, max).map(([c]) => c)
}
