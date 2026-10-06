/**
 * Status (spec 20) - one resolver, shared by the dev server and the build: files in, a status and
 * its evidence out, pure. Feature and project boards wear it; read top to bottom, the first row
 * that matches wins:
 *
 *   1-3  the board says archived, paused or blocked (with its reason)   - a decision, by hand
 *   4    the evidence it needs cannot be read                           - Unknown, never a stale Done
 *   5    an open plan names the capability                              - In progress, filling by phase
 *   6    the shipped record shows it available, `confirmed`             - Done
 *   7    ... `reported` only                                            - Done, reported
 *   8    an accepted contract (`state: current`), no availability       - To do
 *   9    anything else                                                  - Backlog
 *
 * Without `context/`, a board may also say in-progress, todo or backlog by hand. Done is never
 * set by hand: `"status": "done"` is ignored here and reported by `marver context check`.
 */
import { DECISIONS, HAS_STATUS, type BoardType, type StatusWord } from './board-types.ts'
import { strictest, type Audience, type Level } from './context.ts'

export type Status = 'archived' | 'paused' | 'blocked' | 'unknown' | 'in-progress' | 'done' | 'done-reported' | 'todo' | 'backlog'
export const STATUS_LABEL: Record<Status, string> = {
  archived: 'Archived', paused: 'Paused', blocked: 'Blocked', unknown: 'Unknown', 'in-progress': 'In progress',
  done: 'Done', 'done-reported': 'Done, reported', todo: 'To do', backlog: 'Backlog',
}

/** A phase, as the fill reads it: 1 spec, 2 lo-fi, 3 hi-fi. */
export type Phase = 1 | 2 | 3
export const PHASE_LABEL: Record<Phase, string> = { 1: 'spec', 2: 'lo-fi', 3: 'hi-fi' }

/** What the resolver knows about `context/` - read once per pass by the caller. */
export interface ContextFacts {
  /** a `context/` directory exists */
  present: boolean
  /** evidence that could not be read: `'*'` for the whole record (shipped.md unreadable), else per capability */
  unreadable: Map<string, string>
  /** capability -> the levels its shipped row's availability grants, where, and the record's audience */
  shipped: Map<string, { levels: Level[]; where: string; audience: Audience }>
  /** capability -> its contract's state, where, and its audience */
  contracts: Map<string, { state: string; where: string; audience: Audience }>
  /** capability -> its open plans, each with its audience */
  plans: Map<string, { where: string; audience: Audience }[]>
}
export const NO_CONTEXT: ContextFacts = { present: false, unreadable: new Map(), shipped: new Map(), contracts: new Map(), plans: new Map() }

export interface BoardInput {
  name: string
  type: BoardType
  capability?: string
  status?: StatusWord
  reason?: string
  /** the scenes the board shows, with any `phase` their brief declares and that brief's audience */
  scenes: { name: string; phase?: string; audience?: Audience }[]
}

export interface StatusResult {
  status: Status
  /** the table row that decided it */
  row: number
  /** In progress: the latest phase present */
  fill?: Phase
  /** Blocked: why */
  reason?: string
  /** the capability the evidence was read for */
  capability: string
  /** one line per piece of evidence, for the tooltip */
  evidence: string[]
  /** the strictest audience of the evidence the status was drawn from - a published canvas shows a
   *  status only when this is `publishable` (spec 20, Publishing status) */
  audience: Audience
}

const PHASE_WORDS: Record<string, Phase> = { spec: 1, specs: 1, lofi: 2, 'lo-fi': 2, hifi: 3, 'hi-fi': 3 }

/** The latest phase a board's scenes show: a scene named `<cap>-specs` (spec), `<cap>-lofi`
 *  (lo-fi) or `<cap>` itself (hi-fi), or a `phase` in a scene's brief. Never geometry. */
export function phaseOf(capability: string, scenes: BoardInput['scenes']): Phase | undefined {
  return phaseSource(capability, scenes)?.phase
}
/** The deciding phase and where it came from - a brief's phase carries that brief's audience. */
function phaseSource(capability: string, scenes: BoardInput['scenes']): { phase: Phase; scene: string; fromBrief: boolean; audience: Audience } | undefined {
  let best: { phase: Phase; scene: string; fromBrief: boolean; audience: Audience } | undefined
  for (const s of scenes) {
    const declared = s.phase ? PHASE_WORDS[s.phase.toLowerCase()] : undefined
    const named = s.name === `${capability}-specs` || s.name === `${capability}-spec` ? 1 : s.name === `${capability}-lofi` ? 2 : s.name === capability ? 3 : undefined
    const p = (declared ?? named) as Phase | undefined
    if (p && (!best || p > best.phase)) best = { phase: p, scene: s.name, fromBrief: !!declared, audience: declared ? (s.audience ?? 'team') : 'publishable' }
  }
  return best
}

/** A board's status, or null when its type carries none. */
export function resolveStatus(b: BoardInput, ctx: ContextFacts): StatusResult | null {
  if (!HAS_STATUS.includes(b.type)) return null
  const capability = b.capability ?? b.name
  const out = (status: Status, row: number, evidence: string[], audience: Audience, extra: Partial<StatusResult> = {}): StatusResult => ({ status, row, capability, evidence, audience, ...extra })

  // 1-3: a decision on the board
  if (b.status && (DECISIONS as readonly string[]).includes(b.status)) {
    const by = `design/boards/${b.name}.json: "status": "${b.status}"`
    return out(b.status as Status, DECISIONS.indexOf(b.status as (typeof DECISIONS)[number]) + 1, [by], 'team', b.status === 'blocked' && b.reason ? { reason: b.reason } : {})
  }

  if (!ctx.present) {
    // without context/ a project sets To do, Backlog and In progress by hand; Done needs a record
    // the board's own word, and a board ships as written - publishable
    if (b.status === 'in-progress') {
      const f = fillOf(capability, b.scenes)
      return out('in-progress', 5, [`design/boards/${b.name}.json: by hand`, ...f.evidence], strictest('publishable', ...f.audience), f.fill)
    }
    if (b.status === 'todo') return out('todo', 8, [`design/boards/${b.name}.json: by hand`], 'publishable')
    return out('backlog', 9, [b.status === 'backlog' ? `design/boards/${b.name}.json: by hand` : 'no context/ - nothing records it'], 'publishable')
  }

  // 4: evidence that cannot be read is Unknown - never the last value seen
  const bad = ctx.unreadable.get('*') ?? ctx.unreadable.get(capability)
  if (bad) return out('unknown', 4, [bad], 'team')

  const row = ctx.shipped.get(capability)
  const live = row?.levels.includes('confirmed') ? 'confirmed' : row?.levels.includes('reported') ? 'reported' : null

  // 5: an open plan - work on a shipped capability is version two being built, and says so
  const plans = ctx.plans.get(capability)
  if (plans?.length) {
    const f = fillOf(capability, b.scenes)
    const ev = [...plans.map((p) => `${p.where}: an open plan`), ...f.evidence]
    if (live && row) ev.push(`${row.where}: available, \`${live}\` - this is the next version`)
    return out('in-progress', 5, ev, strictest(...plans.map((p) => p.audience), ...f.audience, ...(live && row ? [row.audience] : [])), f.fill)
  }

  // 6-7: the shipped record
  if (live === 'confirmed') return out('done', 6, [`${row!.where}: available, \`confirmed\``], row!.audience)
  if (live === 'reported') return out('done-reported', 7, [`${row!.where}: available, \`reported\` only`], row!.audience)

  // 8: an accepted contract
  const c = ctx.contracts.get(capability)
  if (c?.state === 'current') return out('todo', 8, [`${c.where}: state current, nothing available yet`], strictest(c.audience, ...(row ? [row.audience] : [])))

  // 9: nothing records it - which says nothing private
  return out('backlog', 9, [c ? `${c.where}: state ${c.state}` : `no contract for ${capability}`], c ? c.audience : 'publishable')
}

/** The fill, the line that says where it came from, and the audience of that source. */
const fillOf = (capability: string, scenes: BoardInput['scenes']): { fill: Partial<StatusResult>; evidence: string[]; audience: Audience[] } => {
  const src = phaseSource(capability, scenes)
  if (!src) return { fill: {}, evidence: [], audience: [] }
  const where = src.fromBrief ? `design/scenes/${src.scene}/_brief.md: phase ${PHASE_LABEL[src.phase]}` : `design/scenes/${src.scene}: the ${PHASE_LABEL[src.phase]} scene`
  return { fill: { fill: src.phase }, evidence: [where], audience: [src.audience] }
}

/** What a published canvas may show of a status (spec 20, Publishing status): rows 5-9 only, drawn
 *  from `publishable` evidence only, and never a reason, a record path or other evidence. */
export function publishableStatus(r: { status: Status; row?: number; fill?: Phase; audience?: Audience } | null | undefined): { status: Status; fill?: Phase } | null {
  if (!r || !PUBLISHABLE.has(r.status) || r.audience !== 'publishable') return null
  return { status: r.status, ...(r.fill ? { fill: r.fill } : {}) }
}
/** The statuses rows 5-9 produce - the only ones a published canvas may show. */
export const PUBLISHABLE: ReadonlySet<Status> = new Set(['in-progress', 'done', 'done-reported', 'todo', 'backlog'])
