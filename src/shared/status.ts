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
import type { Level } from './context.ts'

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
  /** capability -> the levels in its shipped row's Available cell, and where */
  shipped: Map<string, { levels: Level[]; where: string }>
  /** capability -> its contract's state, and where */
  contracts: Map<string, { state: string; where: string }>
  /** capability -> its open plans */
  plans: Map<string, string[]>
}
export const NO_CONTEXT: ContextFacts = { present: false, unreadable: new Map(), shipped: new Map(), contracts: new Map(), plans: new Map() }

export interface BoardInput {
  name: string
  type: BoardType
  capability?: string
  status?: StatusWord
  reason?: string
  /** the scenes the board shows, with any `phase` their brief declares */
  scenes: { name: string; phase?: string }[]
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
}

const PHASE_WORDS: Record<string, Phase> = { spec: 1, specs: 1, lofi: 2, 'lo-fi': 2, hifi: 3, 'hi-fi': 3 }

/** The latest phase a board's scenes show: a scene named `<cap>-specs` (spec), `<cap>-lofi`
 *  (lo-fi) or `<cap>` itself (hi-fi), or a `phase` in a scene's brief. Never geometry. */
export function phaseOf(capability: string, scenes: BoardInput['scenes']): Phase | undefined {
  let best: Phase | undefined
  for (const s of scenes) {
    const p = (s.phase && PHASE_WORDS[s.phase.toLowerCase()])
      || (s.name === `${capability}-specs` || s.name === `${capability}-spec` ? 1
        : s.name === `${capability}-lofi` ? 2
          : s.name === capability ? 3 : undefined)
    if (p && (!best || p > best)) best = p
  }
  return best
}

/** A board's status, or null when its type carries none. */
export function resolveStatus(b: BoardInput, ctx: ContextFacts): StatusResult | null {
  if (!HAS_STATUS.includes(b.type)) return null
  const capability = b.capability ?? b.name
  const out = (status: Status, row: number, evidence: string[], extra: Partial<StatusResult> = {}): StatusResult => ({ status, row, capability, evidence, ...extra })

  // 1-3: a decision on the board
  if (b.status && (DECISIONS as readonly string[]).includes(b.status)) {
    const by = `design/boards/${b.name}.json: "status": "${b.status}"`
    return out(b.status as Status, DECISIONS.indexOf(b.status as (typeof DECISIONS)[number]) + 1, [by], b.status === 'blocked' && b.reason ? { reason: b.reason } : {})
  }

  if (!ctx.present) {
    // without context/ a project sets To do, Backlog and In progress by hand; Done needs a record
    if (b.status === 'in-progress') return out('in-progress', 5, [`design/boards/${b.name}.json: by hand`], fillOf(capability, b.scenes))
    if (b.status === 'todo') return out('todo', 8, [`design/boards/${b.name}.json: by hand`])
    return out('backlog', 9, [b.status === 'backlog' ? `design/boards/${b.name}.json: by hand` : 'no context/ - nothing records it'])
  }

  // 4: evidence that cannot be read is Unknown - never the last value seen
  const bad = ctx.unreadable.get('*') ?? ctx.unreadable.get(capability)
  if (bad) return out('unknown', 4, [bad])

  // 5: an open plan
  const plans = ctx.plans.get(capability)
  if (plans?.length) return out('in-progress', 5, plans.map((p) => `${p}: an open plan`), fillOf(capability, b.scenes))

  // 6-7: the shipped record
  const row = ctx.shipped.get(capability)
  if (row?.levels.includes('confirmed')) return out('done', 6, [`${row.where}: available, \`confirmed\``])
  if (row?.levels.includes('reported')) return out('done-reported', 7, [`${row.where}: available, \`reported\` only`])

  // 8: an accepted contract
  const c = ctx.contracts.get(capability)
  if (c?.state === 'current') return out('todo', 8, [`${c.where}: state current, nothing available yet`])

  // 9
  return out('backlog', 9, [c ? `${c.where}: state ${c.state}` : `no contract for ${capability}`])
}

const fillOf = (capability: string, scenes: BoardInput['scenes']): Partial<StatusResult> => {
  const p = phaseOf(capability, scenes)
  return p ? { fill: p } : {}
}

/** What a published canvas may show of a status (spec 20, Publishing status): rows 5-9 only, and
 *  never a reason, a record path or other evidence. */
export function publishableStatus(r: StatusResult | null): { status: Status; fill?: Phase } | null {
  if (!r || r.row < 5) return null
  return { status: r.status, ...(r.fill ? { fill: r.fill } : {}) }
}
