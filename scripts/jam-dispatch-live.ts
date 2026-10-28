/**
 * The dispatcher, live (0.28, F3 + F4) - a REAL interactive Claude Code session hands each Jam run to a background
 * subagent, several at once, and decides what to do with a second request on a frame one of its runs is working.
 *
 *   node scripts/jam-dispatch-live.ts [model]       (default model: sonnet)
 *
 * The workspace and harness of jam-session-live.ts, but taught the way a real repo is: its CLAUDE.md is only
 * `@design/AGENTS.md`, and design/AGENTS.md and design/instructions/ are the shipped templates (no crutch line). Three
 * frames on a board. Once the idle session's listener has connected, three owner @marver tags land at once on the three
 * frames; while the first frame's run is working, a fourth lands on that same frame.
 *
 * PASS: all four are answered and posted as the session's; at least two runs were claimed at the same time (the
 * daemon's own view, sampled every half second); the session's transcript shows background subagents (the Agent tool
 * with run_in_background: true); the fourth was offered to the session while the first was still its (not held back
 * behind it) and the brief named the overlap; and the session made a choice for it - reported (sent to the subagent on
 * that frame, a variant in a new frame, or done in the session itself).
 *
 * Spends real tokens. Never binds a port: the daemon runs in this process and the session talks to it through files.
 * A subagent taught to look at its frame may start `marver dev` itself (no canvas runs here): its slots are moved off
 * localhost:4805-4824 (MARVER_SLOT_BASE) and its Marver home into the workspace, and whatever is still running in the
 * workspace at the end is stopped.
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendEvents, readLog, replay, type CommentEvent } from '../src/server/comments.ts'
import { startJam } from '../src/server/jam/daemon.ts'
import { record } from '../src/server/jam/ledger.ts'
import { ensureConnectors } from '../src/server/jam/connectors.ts'
import { listConns } from '../src/server/jam/conn.ts'
import { jamLive } from '../src/server/jam/live.ts'
import { enumerateInstructionTemplates } from '../src/server/managed.ts'
import type { JamConfig } from '../src/server/config.ts'

const model = process.argv[2] || 'sonnet'
const repo = realpathSync(join(import.meta.dirname, '..'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-dispatch-')))
const say = (m: string) => console.log(`[dispatch-live] ${m}`)
// never a canvas slot someone uses, never ~/.marver: a `marver dev` a subagent starts lands in a block of its own
const ownHome = process.env.MARVER_HOME ? undefined : (process.env.MARVER_HOME = mkdtempSync(join(tmpdir(), 'mv-jam-dispatch-home-')))
process.env.MARVER_SLOT_BASE ||= String(40_000 + Math.floor(Math.random() * 20_000))

// the workspace: three frames on a board, a profile, a marver that is this checkout, and the shipped teaching
const scenes = join(root, 'design', 'scenes', 'demo')
mkdirSync(scenes, { recursive: true })
mkdirSync(join(root, 'design', '.local'), { recursive: true })
mkdirSync(join(root, 'design', 'boards'), { recursive: true })
writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Live check', email: 'live@local' }))
const frames = { hero: join(scenes, 'hero.tsx'), about: join(scenes, 'about.tsx'), pricing: join(scenes, 'pricing.tsx') }
writeFileSync(frames.hero, 'export default function Hero() {\n  return <h1>Welcome to the demo</h1>\n}\n')
writeFileSync(frames.about, 'export default function About() {\n  return <h1>About the demo</h1>\n}\n')
writeFileSync(frames.pricing, 'export default function Pricing() {\n  return <h1>Pricing for the demo</h1>\n}\n')
writeFileSync(join(root, 'design', 'boards', 'home.json'), JSON.stringify({ version: 1, nodes: [{ frame: 'demo/hero' }, { frame: 'demo/about' }, { frame: 'demo/pricing' }] }, null, 2) + '\n')
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'jam-dispatch-live', private: true, type: 'module' }))
mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
const bin = join(root, 'node_modules', '.bin', 'marver')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'src', 'cli', 'index.ts')}" "$@"\n`)
chmodSync(bin, 0o755)
// what `marver init` gives a repo with an app and no component library - the contract and the method files
const templates = join(repo, 'templates')
writeFileSync(join(root, 'design', 'AGENTS.md'), readFileSync(join(templates, 'AGENTS-studio.md'), 'utf8')
  .replaceAll('{{UI_GUIDANCE}}', 'Use the app\'s existing components and stylesheets (import them directly); there is no Tailwind or component library detected - extract shared pieces into design/components/.')
  .replace(/\{\{NEXT_NOTES\}\}\n?/, ''))
for (const { rel, body } of enumerateInstructionTemplates(templates)) {
  mkdirSync(dirname(join(root, 'design', rel)), { recursive: true })
  writeFileSync(join(root, 'design', rel), body)
}
writeFileSync(join(root, 'CLAUDE.md'), '@design/AGENTS.md\n')

const connectors = ensureConnectors(root, { agents: ['claude'], bin })
say(`connectors: ${connectors.map((c) => `${c.agent} ${c.state}`).join(', ')}`)

// sessionMax unset: a Claude Code session holds up to 8 runs
const cfg: JamConfig = { agent: 'claude', concurrency: 3, subagents: true, proactive: false, chime: false, capture: 'confirm', loc: true, names: false, runner: 'auto', session: true, context: 'fork', mcp: true, skills: true, others: false }
const jam = startJam(root, cfg, (m) => say(m.trim()))
if (!jam) { say('the daemon did not start'); process.exit(1) }
const ses = await jamLive.session!({ action: 'start', id: `ses-${Date.now()}-dispchk` })
say(`jam session: ${ses.ok ? 'running' : ses.error}`)

const exp = join(root, '.drive.exp')
writeFileSync(exp, `set timeout 1500
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (what: string, ok: () => boolean, ms: number, step = 1_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await sleep(step) }
  say(`timed out waiting for ${what}`)
  return false
}
/** the processes working in the workspace - lsof exits 1 when a file under it is open by none, the pids printed all the same */
const inWorkspace = (): number[] => {
  let out = ''
  try { out = execFileSync('lsof', ['-t', '-a', '-d', 'cwd', '+D', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch (e) { out = String((e as { stdout?: string }).stdout ?? '') }
  return out.split('\n').map(Number).filter((p) => p && p !== process.pid)
}
const tag = (frame: string, body: string): string => {
  const id = randomUUID()
  const ev: CommentEvent = { id, ts: Date.now(), type: 'create', commentId: id, frame, nodeKey: frame, author: { email: 'live@local', name: 'Live check' }, body }
  appendEvents(join(root, 'design', 'comments'), 'home', [ev])
  record(root, 'home', id)
  return id
}

// the daemon's own view, sampled every half second: when each request was offered, taken (claimed) and finished
type Seen = { offered?: number; claimed?: number; left?: number; waitsFor?: string; runner?: string; overlapOffered?: boolean }
const seen = new Map<string, Seen>()   // by tag (event) id
const timeline: string[] = []
let maxClaimed = 0, maxClaimedAt = 0
let t0 = 0
const rel = (t?: number) => (t === undefined ? '-' : `+${((t - t0) / 1000).toFixed(1)}s`)
const sample = () => {
  const v = jamLive.view?.()
  if (!v) return
  const now = Date.now()
  let claimed = 0
  for (const c of v.cards) {
    const ev = c.events[0]
    if (!ev) continue
    const s = seen.get(ev)
    if (!s) continue
    const r = c.runner
    if (r?.state === 'claimed') claimed += 1
    if (r?.state === 'offered' && s.offered === undefined) { s.offered = now; timeline.push(`${rel(now)} offered ${ev.slice(0, 8)} to the ${r.kind}`) }
    if (r?.state === 'claimed' && s.claimed === undefined) { s.claimed = now; s.offered ??= now; timeline.push(`${rel(now)} claimed ${ev.slice(0, 8)} (${r.kind})`) }
    if (r) s.runner = r.kind
    if (c.waitsFor && !s.waitsFor) { s.waitsFor = `${c.waitsFor.frame}${c.waitsFor.by ? ` (by ${c.waitsFor.by})` : ''}`; timeline.push(`${rel(now)} ${ev.slice(0, 8)} waits for ${s.waitsFor}`) }
    if (s.claimed !== undefined && s.left === undefined && c.state !== 'working') { s.left = now; timeline.push(`${rel(now)} ${ev.slice(0, 8)} ${c.state}`) }
  }
  if (claimed > maxClaimed) { maxClaimed = claimed; maxClaimedAt = now }
}
let sampling = true
const sampler = (async () => { while (sampling) { try { sample() } catch { /* a view mid-write */ } await sleep(500) } })()

const ASKS = {
  // the hero's is the biggest: its run must still be working when the fourth reaches the session (a dispatcher takes
  // its runs one after another, a few seconds each - a one-line hero was done before it got to the fourth)
  one: '@marver make this frame a proper landing hero: the headline exactly "Dispatched one", a one-line subheading, a short paragraph introducing the demo, a "Get started" button and a "Learn more" link, and a row of three small feature cards (a title and one sentence each), styled inline. Then reply confirming.',
  two: '@marver change this frame\'s headline to exactly "Dispatched two", then reply confirming.',
  three: '@marver change this frame\'s headline to exactly "Dispatched three", then reply confirming.',
  four: '@marver also add a small line under the headline that reads exactly "Fourth ask", then reply confirming.',
}

let pass = false
try {
  if (!await until('the session to connect', () => listConns(root).some((c) => c.agent === 'claude' && !c.ended), 90_000)) throw new Error('no connection')
  const conn = listConns(root).find((c) => c.agent === 'claude' && !c.ended)!
  say(`connected: ${conn.id} pid ${conn.pid} session ${conn.session}`)
  await sleep(5_000)   // idle, for real
  t0 = Date.now()
  // three at once, on three frames
  const ids = { one: tag('demo/hero', ASKS.one), two: tag('demo/about', ASKS.two), three: tag('demo/pricing', ASKS.three) } as Record<string, string>
  for (const k of ['one', 'two', 'three']) seen.set(ids[k], {})
  jamLive.poke?.()
  say('tagged three frames at once - waiting for the hero run to be working')
  const replies = () => replay(readLog(join(root, 'design', 'comments'), 'home')).flatMap((t) => t.replies.filter((r) => r.agent).map((r) => ({ ...r, thread: t.id })))
  const EARLY = /^jam-(c-)?e\d+-[0-9a-f]{8}-[0-9a-f]{4}-/
  const finals = () => replies().filter((r) => !EARLY.test(r.id ?? ''))
  const earlyOn = (thread: string) => replies().some((r) => r.thread === thread && EARLY.test(r.id ?? ''))
  const finalOn = (thread: string) => finals().some((r) => r.thread === thread)
  // the fourth, on the hero frame, while its run is working: once the hero's subagent said "On it" and the session has
  // taken all three (it is free again, so it takes the fourth at once) - or 45 s after the hero was taken
  await until('the hero run to be taken', () => seen.get(ids.one)!.claimed !== undefined, 420_000, 250)
  const allTaken = () => ['one', 'two', 'three'].every((k) => seen.get(ids[k])!.claimed !== undefined)
  await until('the hero run to say On it and all three to be taken', () => (earlyOn(ids.one) && allTaken()) || finalOn(ids.one)
    || Date.now() - (seen.get(ids.one)!.claimed ?? Date.now()) > 45_000, 120_000, 250)
  const heroStillWorking = !finalOn(ids.one) && seen.get(ids.one)!.left === undefined
  ids.four = tag('demo/hero', ASKS.four)
  seen.set(ids.four, {})
  const fourAt = Date.now()
  jamLive.poke?.()
  timeline.push(`${rel(fourAt)} tagged the fourth on demo/hero (hero run ${heroStillWorking ? 'still working' : 'ALREADY FINISHED - the overlap was not exercised'})`)
  say(`tagged the fourth on demo/hero ${rel(fourAt)} - hero run still working: ${heroStillWorking}`)
  // was the fourth offered while the hero run was still the session's? (not held back behind it)
  await until('the fourth to be offered', () => seen.get(ids.four)!.offered !== undefined || seen.get(ids.four)!.claimed !== undefined, 300_000, 250)
  const four = seen.get(ids.four)!, hero = seen.get(ids.one)!
  const fourOffer = four.offered ?? four.claimed
  const heroEnd = () => Math.min(hero.left ?? Infinity, ...finals().filter((r) => r.thread === ids.one).map((r) => r.ts))
  four.overlapOffered = fourOffer !== undefined && fourOffer < heroEnd() && !four.waitsFor
  say(`the fourth offered ${rel(fourOffer)}; hero run left ${rel(hero.left)}; offered beside it: ${four.overlapOffered}${four.waitsFor ? ` (it waited for ${four.waitsFor})` : ''}`)

  await until('all four replies', () => ['one', 'two', 'three', 'four'].every((k) => finalOn(ids[k])), 900_000)
  await sleep(2_000)
  sample()

  const allFrames = readdirSync(scenes).filter((f) => f.endsWith('.tsx'))
  const read = (f: string) => readFileSync(join(scenes, f), 'utf8')
  const fourthIn = allFrames.filter((f) => read(f).includes('Fourth ask'))
  const edited = read('hero.tsx').includes('Dispatched one') && read('about.tsx').includes('Dispatched two') && read('pricing.tsx').includes('Dispatched three') && fourthIn.length > 0
  const label = (thread: string) => Object.entries(ids).find(([, v]) => v === thread)?.[0] ?? thread.slice(0, 8)
  for (const r of replies().sort((a, b) => a.ts - b.ts)) say(`reply ${label(r.thread)} ${EARLY.test(r.id ?? '') ? '(early)' : '(final)'} [${r.agentMeta?.harness}/${r.agentMeta?.runner ?? '-'}] ${rel(r.ts)} ${(r.body ?? '').replace(/\s+/g, ' ').slice(0, 140)}`)
  const answered = ['one', 'two', 'three', 'four'].every((k) => finals().some((r) => r.thread === ids[k] && r.agentMeta?.runner === 'session' && r.agentMeta?.harness === 'claude'))

  // overlap in time: the daemon's own view (two runs claimed at one sample), and the claims' spans side by side
  const spans = Object.entries(ids).map(([k, id]) => {
    const s = seen.get(id)!
    const end = Math.min(s.left ?? Infinity, ...finals().filter((r) => r.thread === id).map((r) => r.ts))
    return { k, from: s.claimed, to: Number.isFinite(end) ? end : undefined }
  })
  for (const s of spans) say(`claim ${s.k}: ${rel(s.from)} -> ${rel(s.to)}`)
  const pairs: string[] = []
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const a = spans[i], b = spans[j]
    if (a.from !== undefined && b.from !== undefined && a.to !== undefined && b.to !== undefined && Math.max(a.from, b.from) < Math.min(a.to, b.to))
      pairs.push(`${a.k}+${b.k} (${((Math.min(a.to, b.to) - Math.max(a.from, b.from)) / 1000).toFixed(1)}s)`)
  }
  const concurrent = maxClaimed >= 2 && pairs.length > 0
  say(`claims overlapping: ${pairs.join(', ') || 'none'}; at most ${maxClaimed} claimed at once (${rel(maxClaimedAt)})`)

  // the session's transcript: background subagents, the overlap brief, and what it did with it
  const projects = join(homedir(), '.claude', 'projects')
  let transcript = '', tdir = ''
  try { for (const d of readdirSync(projects)) { const f = join(projects, d, `${conn.session}.jsonl`); if (existsSync(f)) { transcript = readFileSync(f, 'utf8'); tdir = join(projects, d); break } } } catch { /* none */ }
  type Step = { kind: 'use'; id: string; name: string; input: Record<string, unknown> } | { kind: 'result'; id: string; text: string }
  const steps: Step[] = []
  const known = new Set<string>()
  for (const line of transcript.split('\n')) {
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    for (const c of Array.isArray(o?.message?.content) ? o.message.content : []) {
      if (c?.type === 'tool_use' && !known.has(`u${c.id}`)) { known.add(`u${c.id}`); steps.push({ kind: 'use', id: String(c.id), name: String(c.name), input: c.input ?? {} }) }
      if (c?.type === 'tool_result' && !known.has(`r${c.tool_use_id}`)) {
        known.add(`r${c.tool_use_id}`)
        const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join('\n') : ''
        steps.push({ kind: 'result', id: String(c.tool_use_id), text })
      }
    }
  }
  const isAgent = (s: Step) => s.kind === 'use' && (s.name === 'Agent' || s.name === 'Task')
  const agentCalls = steps.filter(isAgent)
  const bg = agentCalls.filter((s) => s.kind === 'use' && (s.input.run_in_background === true || s.input.run_in_background === 'true')).length
  // the jam next that printed the overlap, and what the session did right after it
  const at = steps.findIndex((s) => s.kind === 'result' && /It overlaps your run/.test(s.text))
  const after = at < 0 ? [] : steps.slice(at + 1).filter((s): s is Extract<Step, { kind: 'use' }> => s.kind === 'use')
  const firstMove = after.find((s) => s.name === 'SendMessage' || s.name === 'Agent' || s.name === 'Task' || s.name === 'Edit' || s.name === 'Write'
    || (s.name === 'Bash' && /jam (say|done|release)|boards place/.test(String(s.input.command ?? ''))))
  const newFrames = allFrames.filter((f) => !['hero.tsx', 'about.tsx', 'pricing.tsx'].includes(f))
  const board = (() => { try { return JSON.parse(readFileSync(join(root, 'design', 'boards', 'home.json'), 'utf8')).nodes.map((n: { frame: string }) => n.frame) as string[] } catch { return [] } })()
  let choice = 'none found'
  if (firstMove) {
    const what = firstMove.name === 'Bash' ? String(firstMove.input.command) : JSON.stringify(firstMove.input)
    if (firstMove.name === 'SendMessage') choice = `sent to the subagent on the frame (SendMessage to ${String(firstMove.input.to ?? '?')})`
    else if (firstMove.name === 'Agent' || firstMove.name === 'Task') choice = /boards place|variant|new frame/i.test(what) ? 'a new subagent making a variant in a new frame' : 'a new subagent on the same frame'
    else choice = `done in the session itself (${firstMove.name})`
    choice += `: ${what.replace(/\s+/g, ' ').slice(0, 300)}`
  }
  say(`transcript: ${transcript ? `${agentCalls.length} Agent call(s), ${bg} with run_in_background: true; overlap brief seen: ${at >= 0}` : 'not found'} (${tdir})`)
  say(`the dispatcher's choice on the overlap: ${choice}`)
  say(`new frames: ${newFrames.join(', ') || 'none'}; "Fourth ask" in: ${fourthIn.join(', ') || 'nowhere'}; board: ${board.join(', ')}`)
  say(`timeline:\n  ${timeline.join('\n  ')}`)

  pass = edited && answered && concurrent && bg >= 3 && !!four.overlapOffered && at >= 0 && !!firstMove
  // taken while the hero's run was still working - else its brief rightly names no overlap (the run it overlapped is done)
  const tookBeside = four.claimed !== undefined && four.claimed < heroEnd()
  say(pass ? 'JAM-DISPATCH-LIVE PASS' : `JAM-DISPATCH-LIVE FAIL: edited=${edited} answered=${answered} concurrent=${concurrent} background-agents=${bg} overlap-offered=${four.overlapOffered} taken-beside-hero=${tookBeside} overlap-brief=${at >= 0} choice=${!!firstMove}`)
} catch (err) {
  say(`JAM-DISPATCH-LIVE FAIL: ${(err as Error).message}`)
  say(`timeline:\n  ${timeline.join('\n  ')}`)
} finally {
  sampling = false
  await sampler
  try { tty.kill('SIGTERM') } catch { /* gone */ }
  jam.stop()
  // anything still running in the workspace (a `marver dev` a subagent started, the session itself) - stopped before
  // the workspace goes: a dev server stopping writes design/.local again and would make it anew
  await sleep(1_000)
  const left = inWorkspace()
  for (const p of left) { try { process.kill(p, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 20 && inWorkspace().length; i++) await sleep(250)
  for (const p of inWorkspace()) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
  if (left.length) say(`stopped ${left.length} process(es) left running in the workspace: ${left.join(', ')}`)
  if (ownHome) rmSync(ownHome, { recursive: true, force: true })
  if (pass) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  else say(`workspace kept: ${root} (the session's screen: .drive.log)`)
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
}
