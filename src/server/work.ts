/**
 * The working-state rail for CHAT-driven agents (the jam daemon has its own in-process
 * path into the same set). A coding agent that just accepted a request creates the frame
 * files first, then `npx marver work start <frame...>` - the canvas shows the live
 * working shimmer before a single component exists. `marver work done` clears it.
 *
 * Transport: the dev server writes design/.local/dev.json ({port, token}) at boot; the
 * CLI reads it to find the server and authenticate. The token makes the endpoint
 * unreachable from a drive-by browser page (which cannot read local files), while any
 * process that can read the repo - the owner's own tools - is trusted by definition.
 * Presence itself NEVER touches disk (activity.ts).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createActivity, type Activity } from './jam/activity.ts'
import { pidRuns } from './exclusive.ts'
import { listBoardFiles } from './boards.ts'

/** One per process - the dev server, the jam daemon, and the API all share it. */
export const workActivity: Activity = createActivity()

/**
 * Since when `marver work` has held frames (spec 32 F2): the start of the CLI's work, kept at the activity source and
 * never in the live hub - a hub skips changes while no client is connected and is made again per server. Told of every
 * change of every source (the callback's frames are their union), it never reads emptiness from the callback: an
 * expired lease leaves the map only at the next sweep, and `mark()` sets before it emits, so an expired lease and a new
 * mark give two non-empty callbacks with none empty between. At each change it reads the unexpired 'cli' leases: none,
 * and `since` is cleared; some, with `since` unset or every lease it knew expired (`until <= now`, swept or not), and
 * `since` is now; then `until` is the latest expiry read. Jam's own marks are not timed here: a leftover Jam lease must
 * never give new CLI work an old duration. A read once `until` has passed answers nothing. Erasable TypeScript.
 */
export interface WorkClock { since(): number | undefined }
export function createWorkClock(a: Pick<Activity, 'leases' | 'onChange'>, now: () => number = Date.now): WorkClock & { stop(): void } {
  let since: number | undefined
  let until = 0
  const read = () => {
    const leases = a.leases('cli')
    const t = now()
    if (!leases.length) { since = undefined; until = 0; return }
    if (since === undefined || until <= t) since = t
    until = Math.max(...leases.map(([, u]) => u))
  }
  const stop = a.onChange(read)
  read()
  return { since: () => (since !== undefined && until > now() ? since : undefined), stop }
}
/** The process's clock over `workActivity`, subscribed once at module load: a Vite restart, a hub made again or a client
 *  that reconnects keeps it; a new `marver dev` process starts again. */
export const workClock: WorkClock = createWorkClock(workActivity)

/** The order of what the shell is told about activity: each broadcast takes the next number, and the
 *  snapshot a page asks for carries the latest - so a slow snapshot never undoes a newer broadcast.
 *  Time-based, so a restarted server never counts backwards past a page that outlived it. */
export const activityClock = { seq: 0 }
export const nextActivitySeq = (): number => (activityClock.seq = Math.max(activityClock.seq + 1, Date.now()))

/** The longest a CLI mark may glow unrefreshed - a forgotten `done` self-heals. */
export const WORK_TTL_MAX = 30 * 60_000
export const WORK_TTL_DEFAULT = 10 * 60_000

const infoPath = (root: string) => join(root, 'design', '.local', 'dev.json')

/** The instance each root's dev.json was last written with by THIS process - what `removeDevInfo`
 *  compares by default, so a server that stops never deletes the file of the canvas that still runs. */
const written = new Map<string, string>()

/** Written once per boot (dev.ts), removed on close - the CLI's discovery + credential. It names its
 *  server (`pid`, `instance`): a file whose pid is gone is ignored, and only its own server removes it. */
export function writeDevInfo(root: string, port: number, instance: string = randomUUID()): string {
  const token = randomBytes(24).toString('base64url')
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(infoPath(root), JSON.stringify({ port, token, pid: process.pid, instance, ts: Date.now() }, null, 2) + '\n')
  written.set(root, instance)
  return token
}

/** Remove dev.json if it is still this server's (`instance`, by default the one this process wrote). */
export function removeDevInfo(root: string, instance: string | undefined = written.get(root)): void {
  try {
    const v = JSON.parse(readFileSync(infoPath(root), 'utf8'))
    if (!instance || v?.instance !== instance) return
    rmSync(infoPath(root), { force: true })
    if (written.get(root) === instance) written.delete(root)
  } catch { /* gone or unreadable - not ours to touch */ }
}

/** The running server's dev.json: its port and token, and its pid (a file from before 0.26 has none). */
export function readDevInfo(root: string): { port: number; token: string; pid?: number } | null {
  try {
    const v = JSON.parse(readFileSync(infoPath(root), 'utf8'))
    // a server that died without cleaning up (kill -9, a crash) left its file behind: not a canvas
    if (v?.pid !== undefined && !pidRuns(v.pid)) return null
    return typeof v?.port === 'number' && typeof v?.token === 'string' ? { port: v.port, token: v.token, ...(typeof v.pid === 'number' ? { pid: v.pid } : {}) } : null
  } catch { return null }
}

/** Which boards show which frames, per root - read once from design/boards/ and kept until a board
 *  file changes (`boardsChanged`), so the working set can change every heartbeat at no cost. */
interface BoardsIndex { byFrame: Map<string, Set<string>>; auto: string[] }
const indexes = new Map<string, BoardsIndex>()
const boardListeners = new Set<(root: string) => void>()
function indexOf(root: string): BoardsIndex {
  let ix = indexes.get(root)
  if (ix) return ix
  ix = { byFrame: new Map(), auto: [] }
  try {
    for (const b of listBoardFiles(join(root, 'design', 'boards')).boards) {
      const j = b.json as { auto?: unknown; nodes?: unknown } | null
      if (j?.auto === true) ix.auto.push(b.name)
      if (!Array.isArray(j?.nodes)) continue
      for (const n of j.nodes) {
        const f = n && typeof n === 'object' ? (n as { frame?: unknown }).frame : undefined
        if (typeof f !== 'string') continue
        let set = ix.byFrame.get(f)
        if (!set) ix.byFrame.set(f, (set = new Set()))
        set.add(b.name)
      }
    }
  } catch { /* a missing or unreadable boards dir lights no board */ }
  indexes.set(root, ix)
  return ix
}
/** A board file changed (the dev server's boards watcher): forget the index, tell who is listening. */
export function boardsChanged(root: string): void {
  indexes.delete(root)
  for (const l of boardListeners) l(root)
}
export function onBoardsChanged(fn: (root: string) => void): () => void {
  boardListeners.add(fn)
  return () => { boardListeners.delete(fn) }
}

/** The boards that pin any of these frames, by name - never the auto boards, which hold every frame (spec 32 F2: the
 *  board a `marver work` hold is named by, its first). */
export function pinningBoards(root: string, frames: readonly string[]): string[] {
  if (!frames.length) return []
  const ix = indexOf(root)
  const out = new Set<string>()
  for (const f of frames) for (const b of ix.byFrame.get(f) ?? []) if (!ix.auto.includes(b)) out.add(b)
  return [...out].sort()
}

/** The boards that show any of these frames - what the sidebar lights while an agent works (the
 *  board's type icon shimmers): every board pinning one, and every auto board, which holds every
 *  frame. Sorted, so an unchanged answer compares equal. */
export function boardsShowing(root: string, frames: string[]): string[] {
  if (!frames.length) return []
  const ix = indexOf(root)
  const out = new Set<string>(ix.auto)
  for (const f of frames) for (const b of ix.byFrame.get(f) ?? []) out.add(b)
  return [...out].sort()
}
