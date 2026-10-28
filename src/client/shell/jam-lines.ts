/**
 * What jam cards say in words (spec 27) - the status icon's tooltip, a lane tile's status line, a
 * capture's merged timeline. Pure, so it is tested without a page.
 */
import type { JamCard } from './jam-queue.ts'
import type { Bundle, CaptureRecord } from '../../server/jam/types.ts'

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** Who runs a working card, in words (spec 29b): your session, a copy of it, or a background agent - and,
 *  for your session, where the run stands. `name` is the agent's name ("Claude Code"). Null: today's words. */
export function runnerLine(c: JamCard, name: (agent: string) => string, now = Date.now()): { head: string; detail?: string } | null {
  const r = c.runner
  if (c.state !== 'working' || !r) return null
  const who = r.agent ? name(r.agent) : 'your session'
  if (r.kind === 'session') {
    if (r.state === 'offered') return { head: `Waiting for your ${who} session · ${clock(now - c.at)}`, detail: 'It takes the run when it is free' }
    if (r.state === 'waiting') return { head: 'Waiting for your session', detail: 'Open Claude Code, Codex or Cursor in this repo - it takes the run' }
    if (r.state === 'stalled') return { head: `No word from your ${who} session for a while`, detail: 'Give it back, run it in the background, or drop it' }
    if (r.state === 'stopping') return { head: `Stopping - waiting for your ${who} session to let go`, detail: 'Its frames stay reserved until it does' }
    return { head: `Your ${who} session is on it · ${clock(now - c.at)}` }
  }
  if (r.kind === 'fork') return { head: `A copy of your ${who} session is on it · ${clock(now - c.at)}`, detail: r.why ? `${r.why[0]!.toUpperCase()}${r.why.slice(1)} - a copy with your conversation, tools, MCP servers and skills took it` : 'With your conversation, tools, MCP servers and skills' }
  return { head: `Agent working · ${clock(now - c.at)} - ${who}`, ...(r.why ? { detail: r.why } : {}) }
}

/** What the icon's tooltip says: the state, then the detail - position, clock and agent, the reason
 *  a held card waits, why a card failed. */
export function statusLines(c: JamCard, agent: string | null, harness: Record<string, string>, now = Date.now()): { head: string; detail?: string } {
  const tags = c.events.length > 1 ? ` · ${c.events.length} tags` : ''
  if (c.state === 'queued' && c.waitsFor) {
    const w = c.waitsFor
    return { head: `Queued · waits for ${w.frame}${tags}`, detail: w.by === 'chat' ? 'Your agent in chat is working on it - this one starts when it is done'
      : w.by ? `"${w.by}" is working on it - this one starts when it is done` : 'Another run is working on it - this one starts when it is done' }
  }
  // waiting for more than its place (one runs alone, your session is full): why, never a place in line it does not have
  if (c.state === 'queued' && c.waiting === 'alone') return { head: `Queued · waits to run alone${tags}`, detail: `It ${c.exclusive ? 'changes a shared file' : 'names no frame'} and runs on its own - it starts once the other work is done` }
  if (c.state === 'queued' && c.waiting === 'behind') return { head: `Queued · waits - a run goes alone first${tags}`, detail: 'A request that runs on its own goes first - this one starts after it' }
  if (c.state === 'queued' && c.waiting === 'session') return { head: `Queued · waits - your session is full${tags}`, detail: 'Your session holds all the runs it can - this one goes to it when one of them ends' }
  if (c.state === 'queued') {
    const p = c.position ?? 1
    return { head: p <= 1 ? `Queued · next${tags}` : `Queued · ${ordinal(p)}${tags} - runs after ${p - 1} other${p - 1 === 1 ? '' : 's'}` }
  }
  if (c.state === 'working') return runnerLine(c, (a) => harness[a] ?? a, now) ?? { head: `Agent working · ${clock(now - c.at)}${agent ? ` - ${harness[agent] ?? agent}` : ''}` }
  if (c.state === 'asks') return { head: 'Asks you - see the question below' }
  if (c.state === 'failed') return { head: `Failed - ${c.note ?? 'the agent could not finish'}`, detail: 'Retry here, or tag @marver again' }
  return { head: c.state }
}

// ---- the lane --------------------------------------------------------------------------------------

/** A card as the lane reads it: the queue's card, with its last run's shots when the view has them. */
export type LaneCard = JamCard & { shots?: { frame: string; before?: string; after?: string }[] }

/** A tile's status line (spec 27 Part 1): "To confirm", "Queued · 2nd", "Queued · next", "Agent
 *  working · 0:41", "Asks you", "Ready to review", "Done · 2 frames", "Kept, not sent", "Failed ·
 *  Retry". A queue position counts every queued card, tags included - they share one queue. */
export function laneLine(c: LaneCard, now = Date.now()): string {
  switch (c.state) {
    // a draft the queue would not take (a conflicting comment under its id - an E capture, or a confirm): it says
    // so, never "To confirm" - E's never asked you to confirm anything
    case 'draft': return c.note ? 'Not queued' : 'To confirm'
    case 'confirming': return 'Confirming'
    // waiting on a frame another run holds, or for one that runs alone: why, never a place in line it does not have
    case 'queued': {
      if (c.waitsFor) return `Waits for ${c.waitsFor.frame.split('/').pop()}`
      if (c.waiting) return c.waiting === 'alone' ? 'Waits to run alone' : c.waiting === 'session' ? 'Waits · your session is full' : 'Waits · a run goes alone first'
      const p = c.position ?? 1; return p <= 1 ? 'Queued · next' : `Queued · ${ordinal(p)}`
    }
    case 'working': {
      // who runs it (spec 29b), in a few words: a tile has one short line
      const r = c.runner
      if (r?.kind === 'session') return r.state === 'offered' ? 'Waiting for your session' : r.state === 'waiting' ? 'Waiting for a session' : r.state === 'stalled' ? 'Stalled · choose' : r.state === 'stopping' ? 'Stopping' : `Your session · ${clock(now - c.at)}`
      if (r?.kind === 'fork') {
        // why a copy runs it, by the reason the canvas gave (daemon.ts, runs.ts): the one that matches, never a near one
        const w = r.why ?? ''
        const lead = w.endsWith('it let it go') ? 'Yours let it go' : w.startsWith('your session didn') ? 'Yours was busy'
          : w.startsWith('your session was idle') ? 'Yours was idle' : w.startsWith('the Jam session had ended') ? 'Jam session ended' : ''
        return lead ? `${lead} · a copy is on it · ${clock(now - c.at)}` : `A copy of your session · ${clock(now - c.at)}`
      }
      return `Agent working · ${clock(now - c.at)}`
    }
    case 'asks': return 'Asks you'
    case 'review': return 'Ready to review'
    case 'done': { const n = c.shots?.length ?? 0; return n ? `Done · ${n} frame${n === 1 ? '' : 's'}` : 'Done' }
    case 'kept': return 'Kept, not sent'
    case 'failed': return 'Failed · Retry'
    case 'dropped': return 'Dropped'
  }
}

// ---- the read-back ---------------------------------------------------------------------------------

/** One line of a capture's detail: its time in the capture, the kind of step, the words, the element's
 *  source (file:line) and point number when it has them. */
export interface TimelineLine { t: string; kind: string; text: string; source?: string; point?: number }

/** `<span> "Save 20%"` - an element as a line names it; a secret stays "•••". */
const el = (b: Bundle): string =>
  [b.tag ? `<${b.tag}>` : '', b.quote ? `"${b.quote}"` : b.ariaLabel ? `"${b.ariaLabel}"` : b.testId ? `#${b.testId}` : ''].filter(Boolean).join(' ') || 'an element'
/** The source without its column: file:line is what a reader follows. */
const src = (b: Bundle): string | undefined => (b.source ? b.source.replace(/:\d+:\d+$/, (m) => m.slice(0, m.lastIndexOf(':'))) : undefined)
/** A frame as a reader says it: its last segment, capitalised. */
const frameName = (f?: string): string => {
  const last = (f ?? '').split('/').pop() ?? ''
  return last ? last[0].toUpperCase() + last.slice(1).replace(/-/g, ' ') : 'the frame'
}

/** The read-back's merged timeline (spec 27 Part 3): words and notes interleaved with every pick,
 *  click, hover, field, screen and UI step at the moment it happened, timed from the capture's first
 *  step. With `edited`, your edit stands in for the words (one line at 0:00); every step stays. */
export function timelineLines(r: CaptureRecord, edited?: string): TimelineLine[] {
  const t0 = r.timeline[0]?.at ?? 0
  const at = (ms: number) => clock(ms - t0)
  // your edit stands in for the words and the notes - an empty one too (you deleted them)
  const ed = edited === undefined ? undefined : edited.trim()
  const out: TimelineLine[] = ed !== undefined ? [{ t: at(t0), kind: 'words', text: ed ? `"${ed}"` : '(no words - your edit removed them)' }] : []
  let pictures = 0
  for (const s of r.timeline) {
    const t = at(s.at)
    const from = (b: Bundle) => (src(b) ? { source: src(b) } : {})
    switch (s.event) {
      case 'words': if (ed === undefined) out.push({ t, kind: 'words', text: `"${s.text}"` }); break
      case 'note': if (ed === undefined) out.push({ t, kind: 'note', text: `"${s.text}"` }); break
      case 'pick': case 'click':
        out.push({ t, kind: s.event, text: `${el(s.bundle)}${s.mode !== 'canvas' ? ` · ${s.mode}` : ''}`, ...from(s.bundle), ...(s.point != null ? { point: s.point } : {}) }); break
      case 'hover': out.push({ t, kind: 'hover', text: `held over ${el(s.bundle)}`, ...from(s.bundle) }); break
      case 'field': out.push({ t, kind: 'field', text: `${el(s.bundle)} → ${s.value}`, ...from(s.bundle) }); break
      case 'screen': out.push({ t, kind: 'screen', text: `moved to ${s.to}` }); break
      case 'scroll': out.push({ t, kind: 'scroll', text: `scrolled to ${Math.round(s.y)}` }); break
      case 'view': {
        const v = s.view
        const where = v.board ? (v.frames?.length ? `${v.board} / ${v.frames.map(frameName).join(', ')}` : v.board) : v.frames?.map(frameName).join(', ')
        const size = v.viewport ? `${v.viewport}${v.width ? ` ${v.width}×${v.height}` : ''}` : ''
        out.push({ t, kind: 'view', text: [where, size, v.theme].filter(Boolean).join(' · ') || 'the canvas' }); break
      }
      case 'select': out.push({ t, kind: 'select', text: s.frames.map(frameName).join(', ') || 'nothing' }); break
      case 'device': out.push({ t, kind: 'device', text: `${frameName(s.frame)} · ${s.viewport}${s.width ? ` ${s.width}` : ''}` }); break
      case 'theme': out.push({ t, kind: 'theme', text: s.theme }); break
      case 'copied': out.push({ t, kind: 'copied', text: `${s.what} of ${frameName(s.frame)}` }); break
      case 'interact': out.push({ t, kind: 'interact', text: s.on ? 'on' : 'off' }); break
      case 'picture':
        pictures++
        out.push({ t, kind: 'picture', text: `${frameName(s.frame).toLowerCase()}${s.why === 'end' ? ' at E' : s.why === 'pick' ? ' at a pick' : ''}`, point: pictures }); break
      case 'missing': out.push({ t, kind: 'missing', text: s.what }); break
    }
  }
  return out
}

/** A line as plain text, the spec's format: `[0:05] (pick 1) <span> "Save 20%" · file.tsx:48`,
 *  `[0:04] "this badge"`, `[0:13] (interact on)`. */
export function lineText(l: TimelineLine): string {
  if (l.kind === 'words') return `[${l.t}] ${l.text}`
  if (l.kind === 'interact') return `[${l.t}] (interact ${l.text})`
  if (l.kind === 'copied') return `[${l.t}] (copied) ${l.text}`
  const head = l.point != null ? `${l.kind} ${l.point}` : l.kind
  return `[${l.t}] (${head}) ${l.text}${l.source ? ` · ${l.source}` : ''}`
}
