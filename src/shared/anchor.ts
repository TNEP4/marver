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

export interface Anchor {
  el: {
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
