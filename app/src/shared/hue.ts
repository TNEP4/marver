/**
 * The initials a canvas without a logo wears, on one of eight hues (spec 28 A2.4): the first letters of up to two
 * words of its name, the hue picked by its workspace id (main, `TabView.hue`) or, when the page has none, by its
 * name. The hues leave out the marks' orange and blue and the session's teal. Pure; main and the pages share it.
 */
export const HUES = ['#7c5cff', '#d9467a', '#5f6b7a', '#a8742a', '#4f8a3a', '#9b4dca', '#c2553b', '#3f7f99'] as const

export function hueOf(key: string): number {
  let h = 7
  for (const c of key) h = (h * 31 + c.codePointAt(0)!) >>> 0
  return h % HUES.length
}

/** The first letter or digit of up to two words; '?' when the name has none. */
export function initials(name: string): string {
  const firsts = name.split(/[\s._:/-]+/u).map((w) => /[\p{L}\p{N}]/u.exec(w)?.[0]).filter((c): c is string => !!c)
  return firsts.slice(0, 2).map((c) => c.toLocaleUpperCase()).join('') || '?'
}
