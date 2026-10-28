/**
 * The dispatcher, live (0.28, F3) - a REAL interactive Claude Code session hands each Jam run to a background subagent.
 *
 *   node scripts/jam-dispatch-live.ts [model]       (default model: sonnet)
 *
 * The workspace and harness of jam-session-live.ts, with two frames. Once the idle session's listener has connected,
 * two owner @marver tags land on the two frames a few seconds apart. PASS: both runs are taken by the session and
 * handed back as the session's, both frames are edited, the session's transcript shows background subagents
 * (the Agent tool with run_in_background: true), and the two runs overlapped in time - the second said "On it"
 * before the first was handed back. The session's own pick of what to do is reported either way.
 *
 * Spends real tokens. Never binds a port: the daemon runs in this process and the session talks to it through files.
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-dispatch-')))
const say = (m: string) => console.log(`[dispatch-live] ${m}`)

mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
mkdirSync(join(root, 'design', '.local'), { recursive: true })
writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Live check', email: 'live@local' }))
const frames = { hero: join(root, 'design', 'scenes', 'demo', 'hero.tsx'), about: join(root, 'design', 'scenes', 'demo', 'about.tsx') }
writeFileSync(frames.hero, 'export default function Hero() {\n  return <h1>Welcome to the demo</h1>\n}\n')
writeFileSync(frames.about, 'export default function About() {\n  return <h1>About the demo</h1>\n}\n')
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'jam-dispatch-live', private: true, type: 'module' }))
mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
const bin = join(root, 'node_modules', '.bin', 'marver')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'src', 'cli', 'index.ts')}" "$@"\n`)
chmodSync(bin, 0o755)
writeFileSync(join(root, 'CLAUDE.md'), 'A throwaway design canvas for a Marver Jam check. When a "Live Jam: ... new request" message arrives, follow it.\n')

const connectors = ensureConnectors(root, { agents: ['claude'], bin })
say(`connectors: ${connectors.map((c) => `${c.agent} ${c.state}`).join(', ')}`)

// sessionMax unset: a Claude Code session holds up to 8 runs
const cfg: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: false, capture: 'confirm', loc: true, names: false, runner: 'auto', session: true, context: 'fork', mcp: true, skills: true, others: false }
const jam = startJam(root, cfg, (m) => say(m.trim()))
if (!jam) { say('the daemon did not start'); process.exit(1) }
const ses = await jamLive.session!({ action: 'start', id: `ses-${Date.now()}-dispchk` })
say(`jam session: ${ses.ok ? 'running' : ses.error}`)

const exp = join(root, '.drive.exp')
writeFileSync(exp, `set timeout 900
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
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|MARVER_JAM)/.test(k)))
const tty = spawn('expect', [exp], { cwd: root, stdio: 'ignore', env: { ...env, TERM: 'xterm-256color', COLUMNS: '140', LINES: '40' } })

const until = async (what: string, ok: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 1_000)) }
  say(`timed out waiting for ${what}`)
  return false
}
const tag = (frame: string, body: string) => {
  const id = randomUUID()
  const ev: CommentEvent = { id, ts: Date.now(), type: 'create', commentId: id, frame, nodeKey: frame, author: { email: 'live@local', name: 'Live check' }, body }
  appendEvents(join(root, 'design', 'comments'), 'home', [ev])
  record(root, 'home', id)
  jamLive.poke?.()
}

let pass = false
try {
  if (!await until('the session to connect', () => listConns(root).some((c) => c.agent === 'claude' && !c.ended), 90_000)) throw new Error('no connection')
  const conn = listConns(root).find((c) => c.agent === 'claude' && !c.ended)!
  say(`connected: ${conn.id} pid ${conn.pid}`)
  await new Promise((r) => setTimeout(r, 5_000))   // idle, for real
  tag('demo/hero', '@marver change this frame\'s headline to exactly "Dispatched one", then reply confirming.')
  await new Promise((r) => setTimeout(r, 3_000))
  tag('demo/about', '@marver change this frame\'s headline to exactly "Dispatched two", then reply confirming.')
  say('tagged twice - waiting for both to be handed back')
  const replies = () => replay(readLog(join(root, 'design', 'comments'), 'home')).flatMap((t) => t.replies.filter((r) => r.agent))
  const EARLY = /^jam-(c-)?e\d+-[0-9a-f]{8}-[0-9a-f]{4}-/
  const finals = () => replies().filter((r) => !EARLY.test(r.id ?? ''))
  await until('both replies', () => finals().length >= 2, 600_000)
  const edited = readFileSync(frames.hero, 'utf8').includes('Dispatched one') && readFileSync(frames.about, 'utf8').includes('Dispatched two')
  for (const r of replies()) say(`reply ${EARLY.test(r.id ?? '') ? '(early)' : '(final)'} [${r.agentMeta?.harness}/${r.agentMeta?.runner ?? '-'}] at ${new Date(r.ts).toISOString().slice(11, 19)} ${(r.body ?? '').slice(0, 120)}`)
  // overlap: the second run's "On it" before the first run's final reply
  const early = replies().filter((r) => EARLY.test(r.id ?? '')).map((r) => r.ts).sort((a, b) => a - b)
  const fin = finals().map((r) => r.ts).sort((a, b) => a - b)
  const overlapped = early.length >= 2 && fin.length >= 2 && early[1] < fin[0]
  // the session's transcript: background subagents started with the Agent tool
  const projects = join(homedir(), '.claude', 'projects')
  let transcript = ''
  try { for (const d of readdirSync(projects)) { const f = join(projects, d, `${conn.session}.jsonl`); if (existsSync(f)) { transcript = readFileSync(f, 'utf8'); break } } } catch { /* none */ }
  const agents = (transcript.match(/"name":"Agent","input":\{[^\n]*?"run_in_background":true/g) ?? []).length
  const anyAgent = (transcript.match(/"name":"Agent"/g) ?? []).length
  say(`transcript: ${transcript ? `${anyAgent} Agent call(s), ${agents} with run_in_background: true` : 'not found'}; overlapped: ${overlapped}`)
  pass = edited && fin.length >= 2 && finals().every((r) => r.agentMeta?.runner === 'session' && r.agentMeta?.harness === 'claude') && agents >= 2 && overlapped
  say(pass ? 'JAM-DISPATCH-LIVE PASS' : `JAM-DISPATCH-LIVE FAIL: edited=${edited} finals=${fin.length} runner=${finals().map((r) => r.agentMeta?.runner).join(',')} background-agents=${agents} overlapped=${overlapped}`)
} catch (err) {
  say(`JAM-DISPATCH-LIVE FAIL: ${(err as Error).message}`)
} finally {
  try { tty.kill('SIGTERM') } catch { /* gone */ }
  jam.stop()
  if (pass) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  else say(`workspace kept: ${root} (the session's screen: .drive.log)`)
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
}
