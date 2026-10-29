/**
 * `mv:open`'s item and `mv:opened`'s answer, checked (spec 28 A4.6 #29): pure, no Electron, so main's bridge checks
 * what it sends and the canvas preload checks what it hears with one rule. Unknown fields are stripped; a known one
 * of the wrong type or past its bound refuses the whole.
 *
 * The item: `kind` a `LiveKind`, `id` the live id pattern (never parsed), `board` within `BOUNDS.board`, every other
 * ref (`thread`, `msg`, `batch`, each card) at most `LIVE_BOUNDS.ref`, none with a control character, at most
 * `LIVE_BOUNDS.cards` cards, `gen` and `occ` whole numbers.
 */
import { BOUNDS, LIVE_BOUNDS, LIVE_KINDS, OPEN_RESULTS, type LiveKind, type OpenItem, type Opened, type OpenResult } from '../../../src/shared/app-api.ts'

const CONTROL = /[\u0000-\u001f\u007f]/
const ref = (v: unknown, max: number = LIVE_BOUNDS.ref): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v)
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function checkOpenItem(p: unknown): OpenItem | null {
  if (!obj(p)) return null
  if (typeof p.kind !== 'string' || !(LIVE_KINDS as readonly string[]).includes(p.kind)) return null
  if (typeof p.id !== 'string' || !LIVE_BOUNDS.id.test(p.id)) return null
  if (!ref(p.board, BOUNDS.board)) return null
  const out: OpenItem = { id: p.id, kind: p.kind as LiveKind, board: p.board }
  for (const k of ['thread', 'msg', 'batch'] as const) {
    if (p[k] === undefined) continue
    if (!ref(p[k])) return null
    out[k] = p[k]
  }
  if (p.cards !== undefined) {
    if (!Array.isArray(p.cards) || p.cards.length > LIVE_BOUNDS.cards || !p.cards.every((c) => ref(c))) return null
    out.cards = [...p.cards] as string[]
  }
  for (const k of ['gen', 'occ'] as const) {
    if (p[k] === undefined) continue
    if (!whole(p[k])) return null
    out[k] = p[k]
  }
  return out
}

export function checkOpened(p: unknown): Opened | null {
  if (!obj(p) || typeof p.id !== 'string' || !LIVE_BOUNDS.id.test(p.id)) return null
  if (typeof p.result !== 'string' || !(OPEN_RESULTS as readonly string[]).includes(p.result)) return null
  return { id: p.id, result: p.result as OpenResult }
}
