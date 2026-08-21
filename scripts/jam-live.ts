/**
 * Live Jam agent check - the REAL daemon loop spawning the REAL agent CLI, end to end.
 *
 *   node scripts/jam-live.ts <claude|codex|cursor|droid|opencode|grok|pi>
 *
 * Builds a throwaway workspace, plants an owner-ledgered @marver mention asking for one
 * file edit, runs the daemon until it replies, then verifies: the edit landed, the reply
 * posted with the right harness, and prints what the agent said. Needs the CLI installed
 * AND logged in - this spends real tokens, which is the point: it proves the whole path
 * (spawn, jail, stream parse, reply) against the live tool, not a fixture.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { createJam } from '../src/server/jam/daemon.ts'
import { adapters } from '../src/server/jam/adapter/index.ts'
import { record } from '../src/server/jam/ledger.ts'
import type { JamConfig } from '../src/server/config.ts'

const which = process.argv[2] as keyof typeof adapters
if (!which || !adapters[which]) {
  console.error(`usage: node scripts/jam-live.ts <${Object.keys(adapters).join('|')}>`)
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'mv-jam-live-'))
const dir = join(root, 'design', 'comments')
mkdirSync(join(root, 'design', '.local'), { recursive: true })
writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Live check', email: 'live@local' }))
writeFileSync(join(root, 'headline.txt'), 'Welcome to the demo\n')

const cfg: JamConfig = { agent: which, concurrency: 1, subagents: false, proactive: false }
const jam = createJam(root, cfg, adapters[which], (m) => console.log(' ', m.trim()))

const id = randomUUID()
const ev: CommentEvent = {
  id, ts: Date.now(), type: 'create', commentId: id, frame: 'demo/hero', nodeKey: 'demo/hero',
  author: { email: 'live@local', name: 'Live check' },
  body: 'Hey @marver: edit the file headline.txt in the workspace root so it says exactly "Design is live" (replace its content), then reply confirming.',
}
appendEvents(dir, 'home', [ev])
record(root, 'home', id)

console.log(`jam-live: spawning ${which} in ${root} (this runs the real CLI and spends tokens)`)
await jam.tick()
jam.stop()

const replies = replay(readLog(dir, 'home')).flatMap((t) => t.replies.filter((r) => r.agent))
const edited = readFileSync(join(root, 'headline.txt'), 'utf8').includes('Design is live')
for (const r of replies) console.log(`  reply [${r.agentMeta?.harness}${r.agentMeta?.model ? '/' + r.agentMeta.model : ''}] ${(r.body ?? '').slice(0, 160)}`)
const ok = edited && replies.length >= 1 && replies.every((r) => r.agentMeta?.harness === which)

if (ok) {
  console.log(`JAM-LIVE PASS (${which})`)
  rmSync(root, { recursive: true, force: true })
} else {
  console.log(`JAM-LIVE FAIL (${which}): edit=${edited} replies=${replies.length}`)
  const logs = join(root, 'design', '.local', 'jam-logs')
  try { for (const f of readdirSync(logs)) console.log(`  raw agent output: ${join(logs, f)}`) } catch { /* none written */ }
  console.log(`  workspace kept for inspection: ${root}`)
  process.exit(1)
}
