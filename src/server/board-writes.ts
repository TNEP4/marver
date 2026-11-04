/**
 * Who may have written a board file (spec 30 #18). Every shell request that can write a board names its page and the
 * commands folded into it (`x-mv-page`, `x-mv-cmds`); the server keeps, per board, the hashes it wrote in the last 10 s
 * with them. The watcher reads the file after a debounce, so a matching hash proves matching bytes, not the writer - an
 * editor can write the same bytes back. `sh:board` therefore carries a match as a candidate, never as proof: one match
 * is `candidate`, two or more `ambiguous`, none `unknown` (an agent, the CLI, an editor, a write the server did not see).
 */
import { decodeCmds, ID12, RELOAD_BOUNDS, WRITE_MATCH_MS, WRITER_HEADERS, type BoardWriter, type Candidates } from '../shared/perf-records.ts'

export interface Writer { page: string; cmds: Candidates }
interface Write extends Writer { board: string; sha: string; at: number }

/** by project root: the middleware and the watcher share a process, not an object */
const written = new Map<string, Write[]>()

/** The page and commands a request names; null when it names no page (the CLI, an agent): nothing to remember. */
export function writerFrom(headers: Record<string, unknown>): Writer | null {
  const page = headers[WRITER_HEADERS.page]
  if (typeof page !== 'string' || !ID12.test(page)) return null
  return { page, cmds: decodeCmds(headers[WRITER_HEADERS.cmds] ?? '') ?? { ids: [], n: 0 } }
}

const fresh = (root: string, now: number): Write[] => {
  const kept = (written.get(root) ?? []).filter((w) => now - w.at < WRITE_MATCH_MS)
  if (kept.length) written.set(root, kept); else written.delete(root)
  return kept
}

/** A board write this server made, once it landed. */
export function noteWrite(root: string, board: string, sha: string, who: Writer, now = Date.now()): void {
  written.set(root, [...fresh(root, now), { ...who, board, sha, at: now }])
}

/** What the writes of the last 10 s say about these bytes of this board. */
export function writerOf(root: string, board: string, sha: string, now = Date.now()): BoardWriter {
  const match = fresh(root, now).filter((w) => w.board === board && w.sha === sha)
  if (!match.length) return { writer: 'unknown' }
  return {
    writer: match.length === 1 ? 'candidate' : 'ambiguous',
    candidates: match.slice(-RELOAD_BOUNDS.candidates).map((w) => ({ page: w.page, cmds: w.cmds.ids, n: w.cmds.n })),
  }
}
