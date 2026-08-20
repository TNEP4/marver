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
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createActivity, type Activity } from './jam/activity.ts'

/** One per process - the dev server, the jam daemon, and the API all share it. */
export const workActivity: Activity = createActivity()

/** The longest a CLI mark may glow unrefreshed - a forgotten `done` self-heals. */
export const WORK_TTL_MAX = 30 * 60_000
export const WORK_TTL_DEFAULT = 10 * 60_000

const infoPath = (root: string) => join(root, 'design', '.local', 'dev.json')

/** Written once per boot (dev.ts), removed on close - the CLI's discovery + credential. */
export function writeDevInfo(root: string, port: number): string {
  const token = randomBytes(24).toString('base64url')
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(infoPath(root), JSON.stringify({ port, token, ts: Date.now() }, null, 2) + '\n')
  return token
}

export function removeDevInfo(root: string): void {
  try { rmSync(infoPath(root), { force: true }) } catch { /* best effort */ }
}

export function readDevInfo(root: string): { port: number; token: string } | null {
  try {
    const v = JSON.parse(readFileSync(infoPath(root), 'utf8'))
    return typeof v?.port === 'number' && typeof v?.token === 'string' ? { port: v.port, token: v.token } : null
  } catch { return null }
}
