/**
 * The outbox (spec 36 §3): every write a published canvas has not stored yet, kept in this browser until it is.
 *
 * One localStorage key per entry, never one shared array: two tabs of the same canvas each add and remove their own
 * keys, so neither can write over the other's words. Storage that refuses a write (a full quota, a private window)
 * keeps the entry in this page's memory, and `volatile()` says so - the page then guards its leaving like any unsent
 * words. An entry leaves only when the server stored it, or when the person discards it.
 */
import type { CommentEvent } from '../../shared/events.ts'
import { scoped } from './api.ts'

/** A write the server has not stored: its events exactly as they are posted, the log they go to, the account that
 *  wrote them (sent only while it is the one signed in), and - when the server said no for good - why. */
export interface Pending { key: string; board: string; events: CommentEvent[]; account: string; at: number; refused?: string }

const PREFIX = 'mv-ob:'
const memory = new Map<string, Pending>()   // this page's entries storage would not take
const slot = (key: string) => scoped(PREFIX + key)
const valid = (p: any): p is Pending =>
  !!p && typeof p.key === 'string' && typeof p.board === 'string' && Array.isArray(p.events) && typeof p.account === 'string'

/** Every entry, oldest first: what storage holds (any tab's) and what only this page holds. */
export function list(): Pending[] {
  const out = new Map(memory)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      // this canvas's keys only: scoped() appends a workspace in dev (an entry key is a uuid, no colon)
      if (!k?.startsWith(PREFIX) || k !== slot(k.slice(PREFIX.length).split(':')[0])) continue
      try { const p = JSON.parse(localStorage.getItem(k) ?? ''); if (valid(p) && !out.has(p.key)) out.set(p.key, p) } catch { /* a torn entry */ }
    }
  } catch { /* memory answered */ }
  return [...out.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
}

/** Keep an entry (new, or changed). True when it is on disk; false when only this page holds it. */
export function put(p: Pending): boolean {
  try { localStorage.setItem(slot(p.key), JSON.stringify(p)); memory.delete(p.key); return true }
  catch { memory.set(p.key, p); return false }
}

export function drop(key: string) {
  memory.delete(key)
  try { localStorage.removeItem(slot(key)) } catch { /* nothing kept there */ }
}

/** Does this page hold an entry storage would not take? Then leaving would lose it. */
export const volatile = () => memory.size > 0

/** A storage event for the outbox (another tab added, sent or discarded an entry). */
export const isOutboxKey = (k: string | null) => !!k && k.startsWith(PREFIX)
