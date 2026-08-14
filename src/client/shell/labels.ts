/** Pure display-label helpers. Standalone (no virtual-module imports) so they are unit-testable
 *  and cheap to import anywhere. Re-exported from store.ts for existing call sites. */

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** D5: derive a display label from a kebab slug - drop the dashes, Title Case each word.
 *  For board/scene NAMES only (device/theme names are single words, cap is right there).
 *  Acronyms ("tms" -> "Tms") await the board `title` override (C3); an explicit title,
 *  once present, is shown verbatim and never passes through here. */
export const humanize = (s: string): string => s.replace(/-/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase())
