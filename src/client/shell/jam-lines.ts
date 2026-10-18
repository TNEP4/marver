/**
 * What a jam card's status icon says (spec 27) - pure, so it is tested without a page.
 */
import type { JamCard } from './jam-queue.ts'

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** What the icon's tooltip says: the state, then the detail - position, clock and agent, the reason
 *  a held card waits, why a card failed. */
export function statusLines(c: JamCard, agent: string | null, harness: Record<string, string>, now = Date.now()): { head: string; detail?: string } {
  const tags = c.events.length > 1 ? ` · ${c.events.length} tags` : ''
  if (c.state === 'queued') {
    const p = c.position ?? 1
    return { head: p <= 1 ? `Queued · next${tags}` : `Queued · ${ordinal(p)}${tags} - runs after ${p - 1} other${p - 1 === 1 ? '' : 's'}`, ...(c.waiting ? { detail: c.waiting } : {}) }
  }
  if (c.state === 'working') return { head: `Agent working · ${clock(now - c.at)}${agent ? ` - ${harness[agent] ?? agent}` : ''}` }
  if (c.state === 'asks') return { head: 'Asks you - see the question below' }
  if (c.state === 'failed') return { head: `Failed - ${c.note ?? 'the agent could not finish'}`, detail: 'Retry here, or tag @marver again' }
  return { head: c.state }
}

