/**
 * One anchor format (spec 26, Part 6). A person's click, `comments new`, `comments move` and a Live
 * Jam re-pin all write the element bundle the frame builds (inspect.js `elBundle`): tag, role,
 * label, test id, quote and CSS path, plus `pos` when a person clicked a point on it. What an agent
 * names is a TARGET - words the element shows, or a selector / test id for one without words - and
 * the dev server turns it into that bundle by finding the element in the rendered frame.
 */

export interface AnchorTarget { on?: string; at?: string; nth?: number }

export interface Anchor {
  el: {
    semantics: { tag?: string; role?: string; ariaLabel?: string; testId?: string; quote?: string }
    cssPath?: string
    source?: string
    hue?: number
    /** which of several look-alikes (1-based), when the path goes stale */
    nth?: number
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

/** `--at` takes a data-testid or a CSS selector. One plain token (`cart-icon`, `svg`) can be
 *  either: the test id is tried first. */
export const testIdLike = (s: string) => /^[\w-]+$/.test(s)

/** Read a target from untrusted input - CLI flags, a Live Jam block: exactly one of `on` / `at`, an
 *  optional whole `nth` from 1. A string is the reason it is not one. */
export function readTarget(raw: { on?: unknown; at?: unknown; nth?: unknown }): AnchorTarget | string {
  const clean = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '')
  const on = clean(raw.on), at = clean(raw.at)
  if (!on === !at) return 'name the element with --on "<words it shows>" or --at "<css selector or data-testid>" (one of them)'
  const nth = raw.nth === undefined ? undefined : Number(raw.nth)
  if (nth !== undefined && !(Number.isInteger(nth) && nth >= 1)) return '--nth takes a whole number from 1'
  return { ...(on ? { on: on.slice(0, 120) } : { at: at.slice(0, 200) }), ...(nth ? { nth } : {}) }
}

/** The anchor written when the frame cannot be checked (dev off, no Chrome, a frame that throws):
 *  the target alone, which the canvas resolves by its words or by its selector (a plain token: its
 *  test id, else the tag). One that does not resolve shows as an orphan; `comments move` fixes it. */
export function uncheckedAnchor(t: AnchorTarget): Anchor {
  const nth = t.nth ? { nth: t.nth } : {}
  if (t.on) return { el: { semantics: { quote: t.on }, ...nth } }
  const at = t.at ?? ''
  return { el: { semantics: {}, cssPath: testIdLike(at) ? `[data-testid="${at}"], ${at}` : at, ...nth } }
}
