/**
 * `marver draw describe` (spec 38): a drawing as text an agent can act on - ids, types, labels, boxes, arrows `A → B`,
 * who drew what and when, what changed since a rev, and the agent's changes the person's won over. Freehand strokes are
 * summarised (a box and a length): their points mean nothing as text - `marver shot` shows them.
 */
import { isDrawAnchor } from '../../shared/anchor.ts'
import type { Thread } from '../comments.ts'
import type { DrawElement } from '../../shared/draw-protocol.ts'
import type { DrawDoc } from './file.ts'
import type { LogEntry } from './service.ts'
import type { Lost } from './merge.ts'
import { ordered } from './file.ts'

const r = (n: unknown) => Math.round(Number(n) || 0)
const age = (at: number | undefined, now: number) => {
  if (!at) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

export function describeDrawing(id: string, doc: DrawDoc, log: LogEntry[], since: number | undefined, lost: Lost[], now = Date.now(), threads: Thread[] = []): string {
  const els = ordered(doc.elements.values())
  const byId = new Map(els.map((e) => [e.id, e]))
  const label = (e: DrawElement | undefined): string => {
    if (!e) return '?'
    if (e.type === 'text') return JSON.stringify(String(e.text ?? '').slice(0, 60))
    const bound = ((e.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === 'text')
    const t = bound && byId.get(bound.id)
    return t ? `${e.type} ${JSON.stringify(String(t.text ?? '').slice(0, 60))}` : e.type
  }
  const on = (id: string) => threads.filter((t) => isDrawAnchor(t.anchor) && 'id' in t.anchor.el.draw && t.anchor.el.draw.id === id).map((t) => t.id)
  const lines: string[] = []
  lines.push(`${id} - ${doc.header.title ?? id.split('/').pop()} · rev ${doc.header.rev} · ${els.length} element${els.length === 1 ? '' : 's'} · frame ${doc.header.size?.w ?? 960}x${doc.header.size?.h ?? 640}`)
  if (lost.length) {
    lines.push('')
    lines.push(`${lost.length} change${lost.length === 1 ? '' : 's'} of yours lost to the person's edit (they win a conflict): ${lost.map((l) => `${l.id} (rev ${l.rev})`).join(', ')} - re-read and try again`)
  }
  lines.push('')
  lines.push('Elements (id · what · box x,y w×h · by):')
  for (const e of els) {
    if (e.type === 'text' && e.containerId && !on(e.id).length) continue          // shown as its container's label
    const mv = e.customData?.mv
    const who = mv?.by ? ` · ${mv.by}${mv.at ? ` ${age(mv.at, now)}` : ''}` : ''
    let what = label(e)
    if (e.type === 'arrow' || e.type === 'line') {
      const s = (e.startBinding as { elementId?: string } | null)?.elementId, t = (e.endBinding as { elementId?: string } | null)?.elementId
      if (s || t) what = `${e.type} ${s ? label(byId.get(s)) : '·'} → ${t ? label(byId.get(t)) : '·'}`
    }
    if (e.type === 'freedraw') what = `freehand stroke, ${Array.isArray(e.points) ? e.points.length : 0} points`
    if (e.groupIds && (e.groupIds as string[]).length) what += ` [group ${(e.groupIds as string[])[0]}]`
    if (e.frameId) what += ` [in frame ${e.frameId}]`
    if (e.link) what += ` [link ${e.link}]`
    lines.push(`- ${e.id} · ${what} · ${r(e.x)},${r(e.y)} ${r(e.width)}×${r(e.height)}${who}${on(e.id).length ? ` · open threads: ${on(e.id).join(', ')}` : ''}`)
  }
  if (since !== undefined) {
    const after = log.filter((l) => l.rev > since)
    const orphaned = new Set(after.filter((l) => l.by !== 'owner').flatMap((l) => l.ops.filter((o) => !o.el && !doc.elements.has(o.id)).flatMap((o) => on(o.id))))
    if (orphaned.size) lines.push(`Threads orphaned by agent changes since rev ${since}: ${[...orphaned].join(', ')}`)
    lines.push('')
    if (!after.length) lines.push(`No changes since rev ${since}.`)
    else {
      lines.push(`Changes since rev ${since}:`)
      for (const l of after) {
        const adds = l.ops.filter((o) => o.el).map((o) => o.id), dels = l.ops.filter((o) => !o.el).map((o) => o.id)
        lines.push(`- rev ${l.rev} · ${l.by} · ${age(l.at, now)} · ${adds.length ? `changed ${adds.slice(0, 12).join(', ')}${adds.length > 12 ? ` (+${adds.length - 12})` : ''}` : ''}${adds.length && dels.length ? '; ' : ''}${dels.length ? `deleted ${dels.join(', ')}` : ''}${l.header ? ' (header)' : ''}`)
      }
    }
  }
  lines.push('')
  lines.push(`Edit: npx marver draw add|set|move|rm ${id} … (applied to the current state), or edit the file itself (merged; the person wins a conflict). Then: npx marver shot ${id}`)
  return lines.join('\n')
}
