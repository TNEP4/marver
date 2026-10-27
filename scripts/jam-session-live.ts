/**
 * Jam with your session, live (spec 29b) - a REAL interactive Claude Code session takes a Jam run.
 *
 *   node scripts/jam-session-live.ts [model]        (default model: sonnet)
 *
 * Builds a throwaway workspace whose `node_modules/.bin/marver` runs this checkout, writes its
 * connectors the way `marver dev` does, starts the daemon and a Jam session, then opens an
 * interactive `claude` in it, off-screen in a pseudo-terminal (expect), and leaves it idle. Once its
 * listener has connected, an owner @marver tag lands on a frame. The session must be woken through
 * its inbox, take the run with `marver jam next`, edit the frame, and hand it back with
 * `marver jam done` - and the daemon must post the reply as the session's.
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

const model = process.argv[2] || 'sonnet'
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
writeFileSync(join(root, 'CLAUDE.md'), 'A throwaway design canvas for a Marver Jam check. When a "Live Jam: ... new request" message arrives, follow it.\n')

const connectors = ensureConnectors(root, { agents: ['claude'], bin })
say(`connectors: ${connectors.map((c) => `${c.agent} ${c.state}`).join(', ')}`)

const cfg: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: false, capture: 'confirm', loc: true, names: false, runner: 'auto', session: true, context: 'fork', mcp: true, skills: true, others: false, sessionMax: 3 }
const jam = startJam(root, cfg, (m) => say(m.trim()))
if (!jam) { say('the daemon did not start'); process.exit(1) }
const ses = await jamLive.session!({ action: 'start', id: `ses-${Date.now()}-livechk` })
say(`jam session: ${ses.ok ? 'running' : ses.error}`)

// the session: interactive, off-screen, trusted once, then left alone
const exp = join(root, '.drive.exp')
writeFileSync(exp, `set timeout 600
log_file -noappend ${join(root, '.drive.log')}
spawn claude --model ${model} --dangerously-skip-permissions
expect {
  -re {trust} { sleep 1; send "\\033\\[B"; sleep 0.5; send "\\r"; exp_continue }
  -re {Bypass Permissions mode} { sleep 1; send "\\033\\[B"; sleep 0.5; send "\\r"; exp_continue }
  -re {JAM-LIVE-STOP} { }
  timeout { }
  eof { }
}
`)
// (a clean environment: nothing of the session that runs this check - its inbox, its ids)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|MARVER_JAM)/.test(k)))
const tty = spawn('expect', [exp], { cwd: root, stdio: 'ignore', env: { ...env, TERM: 'xterm-256color', COLUMNS: '140', LINES: '40' } })

const until = async (what: string, ok: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 1_000)) }
  say(`timed out waiting for ${what}`)
  return false
}

let pass = false
try {
  if (!await until('the session to connect', () => listConns(root).some((c) => c.agent === 'claude' && !c.ended), 90_000)) throw new Error('no connection')
  say(`connected: ${listConns(root).map((c) => `${c.id} pid ${c.pid}`).join(', ')}`)
  await new Promise((r) => setTimeout(r, 5_000))   // idle, for real
  const id = randomUUID()
  const ev: CommentEvent = { id, ts: Date.now(), type: 'create', commentId: id, frame: 'demo/hero', nodeKey: 'demo/hero', author: { email: 'live@local', name: 'Live check' },
    body: '@marver change this frame\'s headline to exactly "Your session did this", then reply confirming.' }
  appendEvents(join(root, 'design', 'comments'), 'home', [ev])
  record(root, 'home', id)
  jamLive.poke?.()
  say('tagged - waiting for the session to take it and hand it back')
  const replies = () => replay(readLog(join(root, 'design', 'comments'), 'home')).flatMap((t) => t.replies.filter((r) => r.agent))
  const finals = () => replies().filter((r) => !/^jam-(c-)?e\d+-[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.id ?? ''))
  await until('the reply', () => finals().length > 0, 420_000)
  const edited = readFileSync(frame, 'utf8').includes('Your session did this')
  for (const r of replies()) say(`reply [${r.agentMeta?.harness}/${r.agentMeta?.runner ?? '-'}] ${(r.body ?? '').slice(0, 160)}`)
  pass = edited && finals().length > 0 && finals().every((r) => r.agentMeta?.runner === 'session' && r.agentMeta?.harness === 'claude')
  say(pass ? 'JAM-SESSION-LIVE PASS' : `JAM-SESSION-LIVE FAIL: edited=${edited} finals=${finals().length} runner=${finals().map((r) => r.agentMeta?.runner).join(',')}`)
} catch (err) {
  say(`JAM-SESSION-LIVE FAIL: ${(err as Error).message}`)
} finally {
  try { tty.kill('SIGTERM') } catch { /* gone */ }
  jam.stop()
  if (pass) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })   // a session still writing its last file as it ends
  else say(`workspace kept: ${root} (the session's screen: .drive.log)`)
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
}
