/**
 * A request with no frame, live (0.28, F5) - a REAL interactive Claude Code session takes two captures made on an empty
 * board and a request on a frame of another board, all three at once, each run beside the others.
 *
 *   node scripts/jam-noframe-live.ts [model]       (default model: sonnet)
 *
 * The workspace and harness of jam-dispatch-live.ts: its CLAUDE.md is only `@design/AGENTS.md`, and design/AGENTS.md
 * and design/instructions/ are the shipped templates. A board `home` with one frame, and a new board `volume-ui` with
 * none. Once the idle session's listener has connected, at once: two captures land on the empty board (no frame on
 * screen - each asks for a small new frame), and an owner @marver tag lands on home's frame.
 *
 * PASS: all three are offered to the session and taken by it - none ever exclusive, none ever said to wait to run alone
 * (Nic, 28 Oct on 4806: two captures on the new volume-ui-exploration board sat "Queued · next" behind a run, then ran
 * alone, one at a time); at least three runs claimed at the same moment (the daemon's own view, sampled every half
 * second); each capture's run made a new frame and put it on the empty board with `--run` (the frame is that run's: its
 * batch made it), the two runs' frames apart; and all three answered, posted as the session's.
 *
 * No leg without a session: there, a capture with no frame is spawned alone, as before (test/jam-queue, test/jam-runs).
 * Spends real tokens. Never binds a port: the daemon runs in this process and the session talks to it through files.
 * A subagent taught to look at its frame may start `marver dev` itself (no canvas runs here): its slots are moved off
 * localhost:4805-4824 (MARVER_SLOT_BASE) and its Marver home into a temporary folder, and whatever is still running in
 * the workspace at the end is stopped.
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
import type { Batch, Journal } from '../src/server/jam/types.ts'

const model = process.argv[2] || 'sonnet'
const repo = realpathSync(join(import.meta.dirname, '..'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-noframe-')))
const say = (m: string) => console.log(`[noframe-live] ${m}`)
// never a canvas slot someone uses, never ~/.marver: a `marver dev` a subagent starts lands in a block of its own
const ownHome = process.env.MARVER_HOME ? undefined : (process.env.MARVER_HOME = mkdtempSync(join(tmpdir(), 'mv-jam-noframe-home-')))
process.env.MARVER_SLOT_BASE ||= String(40_000 + Math.floor(Math.random() * 20_000))

// the workspace: a frame on board home, an empty board volume-ui, a profile, a marver that is this checkout, the teaching
const EMPTY = 'volume-ui'
const scenes = join(root, 'design', 'scenes')
mkdirSync(join(scenes, 'demo'), { recursive: true })
mkdirSync(join(root, 'design', '.local'), { recursive: true })
mkdirSync(join(root, 'design', 'boards'), { recursive: true })
writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Live check', email: 'live@local' }))
writeFileSync(join(scenes, 'demo', 'hero.tsx'), 'export default function Hero() {\n  return <h1>Welcome to the demo</h1>\n}\n')
writeFileSync(join(root, 'design', 'boards', 'home.json'), JSON.stringify({ version: 1, nodes: [{ frame: 'demo/hero' }] }, null, 2) + '\n')
writeFileSync(join(root, 'design', 'boards', `${EMPTY}.json`), JSON.stringify({ version: 1, name: EMPTY, auto: false, nodes: [] }, null, 2) + '\n')
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'jam-noframe-live', private: true, type: 'module' }))
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
const sesId = `ses-${Date.now()}-noframe`
const ses = await jamLive.session!({ action: 'start', id: sesId })
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
  return `c-${id}`
}
// a capture ended with E on the empty board: words, no frame on screen - queued as it lands, in the Jam session running
const capture = async (words: string): Promise<string> => {
  const id = `cap-${Date.now()}-${randomUUID().replaceAll('-', '').slice(0, 6)}`
  const r = await jamLive.capture!({ format: 'marver.jam.capture', v: 1, id, context: { canvas: 'live', board: EMPTY, session: sesId }, view: { board: EMPTY, frames: [], theme: 'light' },
    timeline: [{ at: 1_000, event: 'view', view: { board: EMPTY, frames: [] } }, { at: 2_000, event: 'words', text: words }], pictures: [] })
  if (!r.ok || r.held) throw new Error(`the capture did not queue: ${r.error ?? r.held}`)
  return id
}

// the daemon's own view, sampled every half second: when each request was offered, taken (claimed) and finished, and
// whether it ever ran exclusive or was said to wait to run alone
type Seen = { offered?: number; claimed?: number; left?: number; kinds: Set<string>; batch?: string; waiting?: string; exclusive?: boolean; position?: number }
const seen = new Map<string, Seen>()   // by card id
const labels = new Map<string, string>()
const timeline: string[] = []
let maxClaimed = 0, maxClaimedAt = 0, maxWho: string[] = []
let t0 = 0
const clock = (t: number) => new Date(t).toTimeString().slice(0, 8)
const rel = (t?: number) => (t === undefined ? '-' : `+${((t - t0) / 1000).toFixed(1)}s (${clock(t)})`)
const sample = () => {
  const v = jamLive.view?.()
  if (!v) return
  const now = Date.now()
  const inFlight: string[] = []
  for (const c of v.cards) {
    const s = seen.get(c.id)
    if (!s) continue
    const k = labels.get(c.id)!
    const r = c.runner
    if (r) { s.kinds.add(r.kind); s.batch = r.batch }
    if (r?.state === 'claimed') inFlight.push(k)
    if (r?.state === 'offered' && s.offered === undefined) { s.offered = now; timeline.push(`${rel(now)} offered ${k} to the ${r.kind} (run ${r.batch.slice(0, 8)})`) }
    if (r?.state === 'claimed' && s.claimed === undefined) { s.claimed = now; s.offered ??= now; timeline.push(`${rel(now)} claimed ${k} (${r.kind}, run ${r.batch.slice(0, 8)})`) }
    if (c.state === 'queued' && c.position !== undefined && s.position === undefined) { s.position = c.position; timeline.push(`${rel(now)} ${k} queued, position ${c.position}`) }
    if (c.waiting && !s.waiting) { s.waiting = c.waiting; timeline.push(`${rel(now)} ${k} WAITS (${c.waiting})`) }
    if (c.exclusive && !s.exclusive) { s.exclusive = true; timeline.push(`${rel(now)} ${k} EXCLUSIVE`) }
    if (s.claimed !== undefined && s.left === undefined && c.state !== 'working') { s.left = now; timeline.push(`${rel(now)} ${k} ${c.state}`) }
  }
  if (inFlight.length > maxClaimed) { maxClaimed = inFlight.length; maxClaimedAt = now; maxWho = inFlight; timeline.push(`${rel(now)} ${inFlight.length} claimed at once: ${inFlight.join(', ')}`) }
}
let sampling = true
const sampler = (async () => { while (sampling) { try { sample() } catch { /* a view mid-write */ } await sleep(500) } })()

const ASKS = {
  // two captures on the empty board, each a small new frame with words to find it by
  menu: 'make a new frame for this board: a small floating volume menu - a rounded pill on a dark background with a speaker icon, a horizontal volume slider and a mute button, the label exactly "Floating volume", styled inline.',
  explainer: 'make a new frame for this board: a one-slide explainer with the title exactly "Why a floating menu", three short bullet points under it and a small caption, styled inline.',
  // the request on a frame of the other board: big enough to still be working while the session takes the captures
  hero: '@marver make this frame a proper landing hero: the headline exactly "Beside the captures", a one-line subheading, a short paragraph introducing the demo, a "Get started" button and a "Learn more" link, and a row of three small feature cards (a title and one sentence each), styled inline. Then reply confirming.',
}
const MARK = { menu: 'Floating volume', explainer: 'Why a floating menu' }

let pass = false
try {
  if (!await until('the session to connect', () => listConns(root).some((c) => c.agent === 'claude' && !c.ended), 90_000)) throw new Error('no connection')
  const conn = listConns(root).find((c) => c.agent === 'claude' && !c.ended)!
  say(`connected: ${conn.id} pid ${conn.pid} session ${conn.session}`)
  await sleep(5_000)   // idle, for real
  t0 = Date.now()
  // three at once: two captures on the empty board, a tag on home's frame
  const ids = { menu: await capture(ASKS.menu), explainer: await capture(ASKS.explainer), hero: tag('demo/hero', ASKS.hero) } as Record<string, string>
  for (const [k, id] of Object.entries(ids)) { seen.set(id, { kinds: new Set() }); labels.set(id, k) }
  jamLive.poke?.()
  say(`queued at once ${rel(t0)}: captures ${ids.menu} and ${ids.explainer} on ${EMPTY} (no frame), tag ${ids.hero.slice(0, 10)} on home demo/hero`)

  const threads = (board: string) => replay(readLog(join(root, 'design', 'comments'), board))
  const replies = () => [EMPTY, 'home'].flatMap((board) => threads(board).flatMap((t) => t.replies.filter((r) => r.agent).map((r) => ({ ...r, thread: t.id, board }))))
  const EARLY = /^jam-(c-)?e\d+-[0-9a-f]{8}-[0-9a-f]{4}-/
  const finals = () => replies().filter((r) => !EARLY.test(r.id ?? ''))
  // a card's thread: the tag's is its event; a capture's is the comment it wrote at confirm
  const threadOf = (k: string) => (k === 'hero' ? ids.hero.slice(2) : `cap-${ids[k]}`)
  const finalOn = (k: string) => finals().some((r) => r.thread === threadOf(k))
  await until('all three replies', () => ['menu', 'explainer', 'hero'].every(finalOn), 1_200_000)
  await sleep(2_000)
  sample()

  // the journal: each request's run - exclusive or not, whose, the frames it made
  const j = JSON.parse(readFileSync(join(root, 'design', '.local', 'jam-jobs.json'), 'utf8')) as Journal
  const runsOf = (id: string) => j.batches.filter((b) => b.members.some((m) => m.card === id))
  const show = (b: Batch) => `${b.batchId.slice(0, 8)} [${b.runner?.kind ?? '-'}${b.exclusive ? ', EXCLUSIVE' : ''}${b.share ? ', for the session' : ''}] frames ${b.frames.join(', ') || '(none)'}${b.created?.length ? `, made ${b.created.join(', ')}` : ''}`
  for (const [k, id] of Object.entries(ids)) say(`runs of ${k}: ${runsOf(id).map(show).join('; ') || 'none'}`)
  const board = (() => { try { return JSON.parse(readFileSync(join(root, 'design', 'boards', `${EMPTY}.json`), 'utf8')).nodes.map((n: { frame: string }) => n.frame) as string[] } catch { return [] } })()
  const fileOf = (f: string) => join(scenes, ...f.split('/')) + '.tsx'
  const read = (f: string) => { try { return readFileSync(fileOf(f), 'utf8') } catch { return '' } }
  const made = (k: 'menu' | 'explainer') => runsOf(ids[k]).flatMap((b) => b.created ?? [])
  const placed = (['menu', 'explainer'] as const).map((k) => ({ k, frames: made(k).filter((f) => board.includes(f) && existsSync(fileOf(f))), says: made(k).some((f) => read(f).includes(MARK[k])) }))
  for (const p of placed) say(`${p.k}: its run made ${made(p.k).join(', ') || 'nothing'}; on ${EMPTY} and on disk: ${p.frames.join(', ') || 'none'}; "${MARK[p.k]}" in it: ${p.says}`)
  say(`board ${EMPTY}: ${board.join(', ') || '(empty)'}`)
  const apart = !placed[0].frames.some((f) => placed[1].frames.includes(f))
  const ownFrames = placed.every((p) => p.frames.length > 0 && p.says) && apart
  const heroDone = read('demo/hero').includes('Beside the captures')

  const label = (r: { thread: string }) => (['menu', 'explainer', 'hero'] as const).find((k) => threadOf(k) === r.thread) ?? r.thread.slice(0, 8)
  for (const r of replies().sort((a, b) => a.ts - b.ts)) say(`reply ${label(r)} ${EARLY.test(r.id ?? '') ? '(early)' : '(final)'} [${r.agentMeta?.harness}/${r.agentMeta?.runner ?? '-'}] ${rel(r.ts)} ${(r.body ?? '').replace(/\s+/g, ' ').slice(0, 140)}`)
  const answered = (['menu', 'explainer', 'hero'] as const).every((k) => finals().some((r) => r.thread === threadOf(k) && r.agentMeta?.runner === 'session' && r.agentMeta?.harness === 'claude'))

  // to the session, never exclusive, never waiting to run alone: the view as sampled, and every run in the journal
  const toSession = Object.values(ids).every((id) => { const s = seen.get(id)!; return s.claimed !== undefined && [...s.kinds].every((x) => x === 'session') })
    && Object.values(ids).every((id) => runsOf(id).every((b) => b.runner?.kind === 'session'))
  const besides = Object.values(ids).every((id) => { const s = seen.get(id)!; return !s.exclusive && !s.waiting }) && Object.values(ids).every((id) => runsOf(id).every((b) => !b.exclusive))

  // overlap in time: the daemon's own view (three claimed at one sample), and the claims' spans side by side
  const spans = Object.entries(ids).map(([k, id]) => {
    const s = seen.get(id)!
    const end = Math.min(s.left ?? Infinity, ...finals().filter((r) => r.thread === threadOf(k)).map((r) => r.ts))
    return { k, from: s.claimed, to: Number.isFinite(end) ? end : undefined }
  })
  for (const s of spans) say(`claim ${s.k}: ${rel(s.from)} -> ${rel(s.to)}`)
  const from = Math.max(...spans.map((s) => s.from ?? Infinity)), to = Math.min(...spans.map((s) => s.to ?? -Infinity))
  const all3 = Number.isFinite(from) && Number.isFinite(to) && from < to
  say(`all three claimed at once: ${all3 ? `${rel(from)} -> ${rel(to)} (${((to - from) / 1000).toFixed(1)}s)` : 'never'}; at most ${maxClaimed} claimed at one sample (${rel(maxClaimedAt)}: ${maxWho.join(', ')})`)
  const concurrent = maxClaimed >= 3 && all3

  // the session's transcript and its subagents': background subagents, and how each new frame was put on the board
  const projects = join(homedir(), '.claude', 'projects')
  let tdir = ''
  try { for (const d of readdirSync(projects)) if (existsSync(join(projects, d, `${conn.session}.jsonl`))) { tdir = join(projects, d); break } } catch { /* none */ }
  const files = tdir ? [join(tdir, `${conn.session}.jsonl`), ...(() => { try { return readdirSync(join(tdir, conn.session!, 'subagents')).filter((f) => f.endsWith('.jsonl')).map((f) => join(tdir, conn.session!, 'subagents', f)) } catch { return [] } })()] : []
  let bg = 0
  const pins: string[] = []
  const known = new Set<string>()   // (a transcript writes a step more than once)
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    for (const c of Array.isArray(o?.message?.content) ? o.message.content : []) {
      if (c?.type !== 'tool_use' || known.has(c.id)) continue
      known.add(c.id)
      if ((c.name === 'Agent' || c.name === 'Task') && (c.input?.run_in_background === true || c.input?.run_in_background === 'true')) bg += 1
      const cmd = c.name === 'Bash' ? String(c.input?.command ?? '') : ''
      pins.push(...(cmd.match(/marver boards (pin|place) [^\n;&|]*/g) ?? []).map((x) => x.trim()))
    }
  }
  say(`transcripts: ${files.length} (${tdir || 'not found'}); ${bg} background subagent(s)`)
  for (const p of pins) say(`placed: ${p}`)
  say(`timeline:\n  ${timeline.join('\n  ')}`)

  pass = toSession && besides && concurrent && ownFrames && answered && heroDone
  say(pass ? 'JAM-NOFRAME-LIVE PASS' : `JAM-NOFRAME-LIVE FAIL: to-session=${toSession} beside=${besides} three-at-once=${concurrent} (max ${maxClaimed}) own-frames=${ownFrames} (apart ${apart}) answered=${answered} hero=${heroDone}`)
} catch (err) {
  say(`JAM-NOFRAME-LIVE FAIL: ${(err as Error).message}`)
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
