/**
 * Jam with your session, live (spec 29b) - a REAL Codex session pulls a Jam run at the end of its turn.
 *
 *   node scripts/jam-codex-live.ts
 *
 * Builds a throwaway workspace whose `node_modules/.bin/marver` runs this checkout, writes its Codex
 * connector the way `marver dev` does, starts the daemon and a Jam session, then starts a Codex turn that
 * works for a while. While it is busy, an owner @marver tag lands on a frame and is offered to it; its
 * Stop hook must turn the end of the turn into "run marver jam next", and Codex must take the run, edit
 * the frame and hand it back with `marver jam done` - posted as the session's.
 *
 * Spends real tokens. Never binds a port: the daemon runs in this process and the session talks to
 * it through files.
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { startJam } from '../src/server/jam/daemon.ts'
import { record } from '../src/server/jam/ledger.ts'
import { ensureConnectors } from '../src/server/jam/connectors.ts'
import { listConns } from '../src/server/jam/conn.ts'
import { jamLive } from '../src/server/jam/live.ts'
import type { JamConfig } from '../src/server/config.ts'

const repo = realpathSync(join(import.meta.dirname, '..'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-session-')))
const say = (m: string) => console.log(`[session-live] ${m}`)

// the workspace: a frame, a profile, and a marver that is this checkout
mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
mkdirSync(join(root, 'design', '.local'), { recursive: true })
writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Live check', email: 'live@local' }))
const frame = join(root, 'design', 'scenes', 'demo', 'hero.tsx')
writeFileSync(frame, 'export default function Hero() {\n  return <h1>Welcome to the demo</h1>\n}\n')
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'jam-session-live', private: true, type: 'module' }))
mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
const bin = join(root, 'node_modules', '.bin', 'marver')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'src', 'cli', 'index.ts')}" "$@"\n`)
chmodSync(bin, 0o755)
writeFileSync(join(root, 'AGENTS.md'), 'A throwaway design canvas for a Marver Jam check. When a "Live Jam: ... new request" message arrives, follow it.\n')

const connectors = ensureConnectors(root, { agents: ['codex'], bin })
say(`connectors: ${connectors.map((c) => `${c.agent} ${c.state}`).join(', ')}`)

const cfg: JamConfig = { agent: 'codex', concurrency: 3, subagents: true, proactive: false, chime: false, capture: 'confirm', loc: true, names: false, runner: 'auto', session: true, context: 'fork', mcp: true, skills: true, others: false, sessionMax: 3 }
const jam = startJam(root, cfg, (m) => say(m.trim()))
if (!jam) { say('the daemon did not start'); process.exit(1) }
const ses = await jamLive.session!({ action: 'start', id: `ses-${Date.now()}-livechk` })
say(`jam session: ${ses.ok ? 'running' : ses.error}`)

// the session: a Codex turn that works a while (busy), its project trusted and its hooks run without the
// one-time review (automation only - a person trusts them once with /hooks)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|MARVER_JAM)/.test(k)))
const tty = spawn('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '-c', `projects."${root}".trust_level="trusted"`,
  'Run the shell command `sleep 25 && echo warm` and tell me what it printed. Follow any Live Jam message you get after that.'],
  { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env })
let out = ''
tty.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
tty.on('close', () => { try { writeFileSync(join(root, '.codex-run.jsonl'), out) } catch { /* the workspace is gone: it passed */ } })

const until = async (what: string, ok: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 1_000)) }
  say(`timed out waiting for ${what}`)
  return false
}

let pass = false
try {
  if (!await until('the session to connect and start its turn', () => listConns(root).some((c) => c.agent === 'codex' && c.busy && !c.ended), 90_000)) throw new Error('no connection')
  say(`connected: ${listConns(root).map((c) => `${c.id} pid ${c.pid}`).join(', ')}`)
  await new Promise((r) => setTimeout(r, 2_000))
  const id = randomUUID()
  const ev: CommentEvent = { id, ts: Date.now(), type: 'create', commentId: id, frame: 'demo/hero', nodeKey: 'demo/hero', author: { email: 'live@local', name: 'Live check' },
    body: '@marver change this frame\'s headline to exactly "Your Codex session did this", then reply confirming.' }
  appendEvents(join(root, 'design', 'comments'), 'home', [ev])
  record(root, 'home', id)
  jamLive.poke?.()
  say('tagged - waiting for the session to take it and hand it back')
  const replies = () => replay(readLog(join(root, 'design', 'comments'), 'home')).flatMap((t) => t.replies.filter((r) => r.agent))
  const finals = () => replies().filter((r) => !/^jam-(c-)?e\d+-[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.id ?? ''))
  await until('the reply', () => finals().length > 0, 420_000)
  const edited = readFileSync(frame, 'utf8').includes('Your Codex session did this')
  for (const r of replies()) say(`reply [${r.agentMeta?.harness}/${r.agentMeta?.runner ?? '-'}] ${(r.body ?? '').slice(0, 160)}`)
  pass = edited && finals().length > 0 && finals().every((r) => r.agentMeta?.runner === 'session' && r.agentMeta?.harness === 'codex')
  say(pass ? 'JAM-CODEX-LIVE PASS' : `JAM-CODEX-LIVE FAIL: edited=${edited} finals=${finals().length} runner=${finals().map((r) => r.agentMeta?.runner).join(',')}`)
} catch (err) {
  say(`JAM-CODEX-LIVE FAIL: ${(err as Error).message}`)
} finally {
  try { tty.kill('SIGTERM') } catch { /* gone */ }
  jam.stop()
  if (pass) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })   // a session still writing its last file as it ends
  else say(`workspace kept: ${root} (the Codex run: .codex-run.jsonl)`)
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
}
