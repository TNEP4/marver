/**
 * What the strip's live region says of marks (spec 28 A4.6 #19, A2.13): "<name> needs you" when a local tab's `needs`
 * rises, at most once per tab per `every`, never for the first marks the strip sees of a tab - so never for a
 * workspace's first snapshot. A tab with no marks is forgotten: its marks coming back are first marks again. Its first
 * marks can be main's stop (a canvas without live, or one killed before its first snapshot); once that stop is
 * acknowledged at its new instance's ready the tab has none, and the snapshot that follows is the workspace's first.
 * Pure, so the unit suite holds it (the strip runs under the pw project only).
 */
import type { TabView } from '../../src/shared/channels.ts'

/** each tab's needs as last seen, and when its rise was last said */
export interface NeedsSeen { last: Map<string, number>; saidAt: Map<string, number> }

export const needsSeen = (): NeedsSeen => ({ last: new Map(), saidAt: new Map() })

/** The tabs whose rise is said now. `baseline` (what was found at launch) says nothing and only remembers. */
export function needsRisen(seen: NeedsSeen, shown: TabView[], now: number, baseline: boolean, every: number): TabView[] {
  const say: TabView[] = []
  for (const t of shown) {
    if (t.kind !== 'local') continue
    if (!t.marks) { seen.last.delete(t.id); continue }
    const before = seen.last.get(t.id)
    seen.last.set(t.id, t.marks.needs)
    if (baseline || before === undefined || t.marks.needs <= before) continue
    if (now - (seen.saidAt.get(t.id) ?? -Infinity) < every) continue
    seen.saidAt.set(t.id, now)
    say.push(t)
  }
  return say
}
