/**
 * `marver marks` (spec 26): what the human has not reviewed yet - the frames waiting on them (a
 * Marver thread whose last word is Marver's, the ones that ask first) and the frames new since they
 * looked. A read-only view of design/.local, a fresh scan of the frames and the comment logs:
 * running it writes nothing, so it never starts the clock, and it works with dev off.
 */
import { join } from 'node:path'
import { scanFrames } from '../server/manifest.ts'
import { projectMarks } from '../server/marks.ts'
import { listBoards, readLog, replay } from '../server/comments.ts'
import { asksOf, isNew } from '../shared/marks.ts'

export function marksCommand(root: string, opts: { json?: boolean }): void {
  const manifest = scanFrames(root)
  const m = projectMarks(root, manifest)
  const dir = join(root, 'design', 'comments')
  const waiting = listBoards(dir).flatMap((b) => replay(readLog(dir, b)).flatMap((t) => {
    if (t.resolved || !t.frame || !(t.agent || t.replies.some((r) => r.agent))) return []
    const last = t.replies.length ? t.replies[t.replies.length - 1] : t
    if (!last.agent) return []
    return [{ frame: t.frame, thread: t.id, board: b, asks: asksOf(last, last === t), body: (last.body ?? '').replace(/\s+/g, ' ').trim() }]
  })).sort((a, b) => Number(b.asks) - Number(a.asks))
  const fresh = m ? manifest.frames.map((f) => f.id).filter((id) => isNew(m, id)) : []
  if (opts.json) { console.log(JSON.stringify({ started: !!m, waiting, new: fresh }, null, 2)); return }
  if (!m) console.log('  (marks start with the next `marver dev` - nothing is new until then)')
  const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length))
  const w = Math.max(0, ...waiting.map((x) => x.frame.length)) + 2
  if (waiting.length) waiting.forEach((x, i) =>
    console.log(`${pad(i ? '' : `waiting on you (${waiting.length})`, 21)}${pad(x.frame, w)}${pad(x.asks ? 'asks' : '', 6)}"${x.body.length > 60 ? x.body.slice(0, 57) + '...' : x.body}"`))
  else console.log(`${pad('waiting on you', 21)}nothing`)
  const shown = fresh.slice(0, 6).join(', ') + (fresh.length > 6 ? `, ... (+${fresh.length - 6})` : '')
  console.log(`${pad(fresh.length ? `new (${fresh.length})` : 'new', 21)}${fresh.length ? shown : 'nothing'}`)
}
