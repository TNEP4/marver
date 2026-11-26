/**
 * One anchor format (spec 26, Part 6). A person's click, `comments new`, `comments move` and a Live
 * Jam re-pin all write the element bundle the frame builds (inspect.js `elBundle`): tag, role,
 * label, test id, quote and CSS path, plus `pos` when a person clicked a point on it. What an agent
 * names is a TARGET - words the element shows, or a selector / test id for one without words - and
 * the dev server turns it into that bundle by finding the element in the rendered frame.
 */

export interface AnchorTarget { on?: string; at?: string; nth?: number }
/** Where to look for a target only another viewport or theme shows (`--viewport`, `--theme`). */
export interface AnchorLook { viewport?: string; theme?: string }

export const DRAW_ELEMENT_TYPES = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'] as const
export type DrawTarget = ({ id: string; type: typeof DRAW_ELEMENT_TYPES[number]; label?: string } | { at: { x: number; y: number } }) & { rev?: number; epoch?: string }

/** Drawing ids are opaque, not CSS selectors or CLI tokens. */
export const validElementId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(id)

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Discriminator only: callers accepting untrusted input must also validate it. */
export function isDrawAnchor(a: unknown): a is Anchor & { el: { draw: DrawTarget } } {
  return object(a) && object(a.el) && 'draw' in a.el
}

/** Spec 39 B3. Refuse, never truncate or rewrite an anchor already assigned an event id. */
export function validDrawAnchor(a: unknown): boolean {
  if (!isDrawAnchor(a)) return false
  const el = a.el, d = el.draw
  if (!object(d) || 'cssPath' in el || 'source' in el || 'cssPath' in a || 'source' in a) return false
  const short = (v: unknown, n: number) => typeof v === 'string' && v.length <= n
  if (d.rev !== undefined && !(Number.isInteger(d.rev) && d.rev >= 0)) return false
  if (d.epoch !== undefined && !short(d.epoch, 32)) return false
  if ('at' in d) {
    if (Object.keys(d).some((k) => !['at', 'rev', 'epoch'].includes(k)) || !object(d.at)) return false
    if (![d.at.x, d.at.y].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6)) return false
  } else {
    if (Object.keys(d).some((k) => !['id', 'type', 'label', 'rev', 'epoch'].includes(k))) return false
    if (!validElementId(d.id) || !DRAW_ELEMENT_TYPES.includes(d.type) || (d.label !== undefined && !short(d.label, 200))) return false
  }
  if (el.semantics !== undefined && (!object(el.semantics) || (el.semantics.quote !== undefined && !short(el.semantics.quote, 200)))) return false
  if (el.hue !== undefined && (typeof el.hue !== 'number' || !Number.isFinite(el.hue))) return false
  if (a.pos !== undefined && (!object(a.pos) || ![a.pos.fx, a.pos.fy].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))) return false
  try { return new TextEncoder().encode(JSON.stringify(a)).length <= 2048 } catch { return false }
}

export interface Anchor {
  el: {
    draw?: DrawTarget
    semantics: { tag?: string; role?: string; ariaLabel?: string; testId?: string; quote?: string }
    cssPath?: string
    source?: string
    hue?: number
    /** which of several look-alikes (1-based), when the path goes stale */
    nth?: number
    /** an unchecked `--at` target, resolved as the check resolves it: its test id, else selector */
    at?: string
  }
  /** where a person clicked, as a fraction of the element - an agent's anchor has none */
  pos?: { fx: number; fy: number }
  rect?: { x: number; y: number; w: number; h: number }
}

/** What the dev server's check says (server/anchor-check.ts). Refused only on evidence - a frame
 *  that rendered with no match, or several; anything that stops the check is `unchecked`. */
export type AnchorCheck =
  | { ok: true; anchor: Anchor; holders: string[]; viewport: string; theme: string }
  | { ok: false; refused: 'none'; visible: string[]; viewport: string; theme: string }
  | { ok: false; refused: 'several'; matches: string[]; viewport: string; theme: string }
  | { ok: false; unchecked: string }

/** Read a target from untrusted input - CLI flags, a Live Jam block: exactly one of `on` / `at`, an
 *  optional whole `nth` from 1. A string is the reason it is not one. */
export function readTarget(raw: { on?: unknown; at?: unknown; nth?: unknown }): AnchorTarget | string {
  const clean = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '')
  const on = clean(raw.on), at = clean(raw.at)
  if (!on === !at) return 'name the element with --on "<words it shows>" or --at "<css selector or data-testid>" (one of them)'
  // never cut short: a shortened target could match an element that shows only its beginning
  if ((on || at).length > MAX_TARGET) return `--on / --at take at most ${MAX_TARGET} characters - name fewer words`
  const nth = raw.nth === undefined ? undefined : Number(raw.nth)
  if (nth !== undefined && !(Number.isInteger(nth) && nth >= 1)) return '--nth takes a whole number from 1'
  return { ...(on ? { on } : { at }), ...(nth ? { nth } : {}) }
}
const MAX_TARGET = 200

/** The anchor written when the frame cannot be checked (dev off, no Chrome, a frame that throws):
 *  the target alone, which the canvas resolves exactly as the check would - by its words, or by
 *  `at` (its test id, else its selector). One that does not resolve shows as an orphan;
 *  `comments move` fixes it. */
export function uncheckedAnchor(t: AnchorTarget): Anchor {
  const nth = t.nth ? { nth: t.nth } : {}
  return t.on ? { el: { semantics: { quote: t.on }, ...nth } } : { el: { semantics: {}, at: t.at, ...nth } }
}
