/**
 * Live Jam shared types (SPEC-live-jam §3, §5). No node imports beyond types - kept small
 * so the adapter, packet, journal, watch, and daemon modules share one vocabulary.
 */
import type { CommentEvent } from '../../shared/events.ts'

/** One agent CLI the daemon can spawn. M1 ships `claude`; M5 adds `codex`. */
export interface JamAdapter {
  name: 'claude' | 'codex'
  supportsSubagents: boolean
  /** argv for a goal-phrased, workspace-jailed run over `goal`. Never full-access, never prompts. */
  spawnArgs(goal: string): { cmd: string; args: string[] }
  /** Parse the agent's stdout + exit code into the reply text and best-effort model id. */
  parse(stdout: string, code: number): { reply: string; model?: string; ok: boolean }
}

/** A durable unit of work: the owner mentions batched into one orchestrated job. M1 forms
 *  single-member batches; M4 promotes to real multi-member batches (frozen at spawn). */
export interface Batch {
  batchId: string
  board: string              // the board the members live on; resume reads ONLY this board
  memberEventIds: string[]   // frozen at spawn
  state: 'pending' | 'claimed' | 'done' | 'failed'
  leaseUntil: number
  attempts: number
  pgid?: number              // spawned process group, for fencing an orphan on resume
}

/** The on-disk journal (design/.local/jam-jobs.json). `seen` is the dedup source of truth
 *  (an event id enters it the moment it is batched); terminal batches are pruned, their ids
 *  stay in `seen`. `baselined` guards the activation baseline (never replay pre-existing logs). */
export interface Journal {
  version: 1
  baselined: boolean
  seen: string[]
  batches: Batch[]
}

/** What the daemon hands one member to the agent - untrusted user data, framed as such (§5). */
export interface PacketMember {
  eventId: string
  threadId: string
  board: string
  frame?: string
  nodeKey?: string
  comment: { bodyRaw: string; author?: { name?: string; email?: string } }
  nearby: { bodyRaw: string; author?: string }[]
  anchor?: unknown
}

export interface JobPacket {
  v: 1
  kind: 'marver.jam.job'
  batchId: string
  members: PacketMember[]
}

/** The triggering event plus the board it lives on. */
export interface Pending { board: string; event: CommentEvent }
