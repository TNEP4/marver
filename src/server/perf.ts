/**
 * The reload log (spec 26 Part 1): one JSON line per event in design/.local/perf/reloads.jsonl -
 * the server's view (an edit and the frames it reached, a full reload sent or dropped) and the
 * page's (each document that actually booted, and how long it took). Local, never committed.
 * `npx marver perf` reads it back.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkRealDirs } from './boards.ts'

const MAX = 2_000_000   // past this the oldest half goes: the log answers "what happened lately"

export const reloadLog = (root: string) => join(root, 'design', '.local', 'perf', 'reloads.jsonl')

export function logReload(root: string, entry: Record<string, unknown>): void {
  try {
    if (checkRealDirs(root, [[join(root, 'design'), 'design'], [join(root, 'design', '.local'), 'design/.local']])) return
    const file = reloadLog(root)
    mkdirSync(join(file, '..'), { recursive: true })
    if (existsSync(file) && statSync(file).size > MAX) {
      const lines = readFileSync(file, 'utf8').split('\n')
      writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'))
    }
    appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n')
  } catch { /* the log never stands in the way of the canvas */ }
}

export function readReloads(root: string, since = 0): Record<string, any>[] {
  try {
    return readFileSync(reloadLog(root), 'utf8').split('\n').flatMap((l) => {
      try { const e = JSON.parse(l); return typeof e?.ts === 'number' && e.ts >= since ? [e] : [] } catch { return [] }
    })
  } catch { return [] }
}
