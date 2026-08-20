/**
 * @marver mention parsing - pure, so the rendering is unit-testable without
 * pulling the whole comment UI (and its virtual:sh-config) into the test.
 */

/** Split a comment body into plain text and @marver mention segments (case-insensitive, word-bounded). */
export function parseMentions(body: string): { text: string; mention: boolean }[] {
  const out: { text: string; mention: boolean }[] = []
  let last = 0
  for (const m of body.matchAll(/@marver\b/gi)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: body.slice(last, i), mention: false })
    out.push({ text: m[0], mention: true })
    last = i + m[0].length
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false })
  return out.length ? out : [{ text: body, mention: false }]
}
