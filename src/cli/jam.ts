/**
 * `marver jam` - Live Jam from a coding-agent session (spec 29b).
 *
 *   jam next | say <handle> <words> | progress <handle> | done <handle> --file <f> | release <handle> | status | mute
 *       what a session runs when Marver Jam wakes it: take a run, work on it, hand the result back
 *   jam hook <claude|codex|cursor> <start|prompt|stop|end>     run by the tools' hooks, never by hand
 *   jam listen                                                 Claude Code's listener, started by its hooks
 *   jam permit                                                 the permission tool of a background Claude Code run
 *
 * The session's commands reach the daemon through files (transport.ts) - a sandbox that blocks
 * localhost cannot stop them. A hook never fails its host: an error prints nothing and exits 0.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, watch } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { connId, endConn, listConns, offersFile, pidAlive, readConn, readOffers, upsertConn, type Conn, type ConnAgent } from '../server/jam/conn.ts'
import { request, type Op } from '../server/jam/transport.ts'
import { NAME } from './name.ts'

/** The repo a hook or a session works in: the nearest folder above `from` with a design/ that marver made. */
export function marverRoot(from: string): string | null {
  let at = resolve(from)
  for (;;) {
    if (['config.ts', 'scenes', '.local'].some((x) => existsSync(join(at, 'design', x)))) { try { return realpathSync(at) } catch { return at } }
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/** Jam is off for this repo's sessions (`jam: false`, `jam.session: false`), or for this process. */
async function sessionsOff(root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.MARVER_JAM_BACKGROUND === '1' || env.MARVER_JAM === 'off') return true
  try {
    const { loadConfig } = await import('../server/config.ts')
    const cfg = await loadConfig(root)
    return !cfg.jam || cfg.jam.session === false
  } catch { return true }
}

const readStdin = async (): Promise<Record<string, any>> => {
  if (process.stdin.isTTY) return {}
  const chunks: Buffer[] = []
  const done = new Promise<void>((res) => { process.stdin.on('data', (c: Buffer) => chunks.push(c)); process.stdin.on('end', () => res()); process.stdin.on('error', () => res()) })
  await Promise.race([done, new Promise((r) => setTimeout(r, 2_000))])
  try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return o && typeof o === 'object' ? o : {} } catch { return {} }
}

/** The nearest ancestor process whose command is `name` (Codex runs its hooks through a shell). */
function ancestor(name: RegExp, from = process.ppid): number | undefined {
  let pid = from
  for (let i = 0; i < 8 && pid > 1; i++) {
    let line: string
    try { line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim() } catch { return undefined }
    const m = /^(\d+)\s+(.*)$/.exec(line)
    if (!m) return undefined
    if (name.test(m[2].split('/').pop() ?? '')) return pid
    pid = Number(m[1])
  }
  return undefined
}

const STOP_LINE = (handles: string[], as?: string) => `Marver Jam: the owner moved ${handles.join(', ')} to another runner - stop working on ${handles.length === 1 ? 'it' : 'them'} and run ${handles.map((h) => `\`npx ${NAME} jam release ${h}${as ? ` --as ${as}` : ''}\``).join(', ')}.`
const READY_LINE = (n: number, as?: string) => `Marver Jam: ${n} run${n === 1 ? '' : 's'} ready on the canvas - run \`npx ${NAME} jam next${as ? ` --as ${as}` : ''}\` to take ${n === 1 ? 'it' : 'the next one'}.`
const CONNECTED_LINE = (as?: string) => `Marver Jam is connected to this session: the owner's @marver tags and voice captures on the design canvas can come to you. When you are told runs are ready, run \`npx ${NAME} jam next${as ? ` --as ${as}` : ''}\` - it prints the run and how to hand it back (design/instructions/jam.md, "Runs from the canvas").`

// ---- the hooks ---------------------------------------------------------------------------------------

/** `jam hook <agent> <event>`: register, mark busy or idle, answer in the tool's own words. Prints
 *  nothing and exits 0 on anything unexpected - a hook must never break its host. */
export async function hookCommand(agent: string, event: string, rootOpt?: string): Promise<void> {
  try {
    const input = await readStdin()
    const out = await hook(agent, event, input, process.env, Date.now(), rootOpt)
    if (out) process.stdout.write(JSON.stringify(out))
  } catch { /* never the host's problem */ }
}

/** Is this hook input from the tool the entry was written for? Cursor runs Claude Code's hooks, Grok runs
 *  both Claude Code's and Cursor's - and either may have inherited a Claude Code session's variables, so the
 *  input's own shape decides, before anything else is looked at. */
export function ownHost(agent: string, input: Record<string, any>, env: NodeJS.ProcessEnv): boolean {
  if (env.GROK_HOOK_EVENT || typeof input.hookEventName === 'string') return false
  const cursor = typeof input.cursor_version === 'string'
  if (agent === 'cursor') return cursor && typeof (input.session_id ?? input.conversation_id) === 'string'
  if (cursor || typeof input.hook_event_name !== 'string' || typeof input.session_id !== 'string') return false
  return agent === 'claude' ? !!env.CLAUDE_CODE_MESSAGING_SOCKET : agent === 'codex'
}

/** The repo a hook speaks for: its `--root`, else the session's folder, else here. */
const hookRoot = (input: Record<string, any>, rootOpt?: string): string | null => {
  if (rootOpt) return marverRoot(rootOpt)
  const from = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd
    : Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === 'string' ? input.workspace_roots[0] : process.cwd()
  return marverRoot(from)
}

/** The hook itself, pure enough to test: what it writes is the connection, what it returns is the answer. */
export async function hook(agent: string, event: string, input: Record<string, any>, env: NodeJS.ProcessEnv, now = Date.now(), rootOpt?: string): Promise<Record<string, unknown> | null> {
  // a run Marver spawned (a copy of a session, a fresh agent) never connects, whatever it is
  if (env.MARVER_JAM_BACKGROUND === '1') return null
  if (!ownHost(agent, input, env)) return null
  if (agent === 'claude' && event !== 'end') return null   // Claude Code's start and prompt go to the listener (`jam listen`)
  const session = String(input.session_id ?? input.conversation_id ?? '')
  const root = hookRoot(input, rootOpt)
  if (!session || !root) return null
  const id = connId(agent as ConnAgent, session)
  if (event === 'end') { endConn(root, id); return null }
  if (await sessionsOff(root, env)) { endConn(root, id); return null }

  if (agent === 'codex') {
    const start = event === 'start'
    const pid = start ? ancestor(/^codex/) : readConn(root, id)?.pid
    const c = upsertConn(root, 'codex', session, { pid, cwd: root, mode: typeof input.permission_mode === 'string' ? input.permission_mode : undefined, busy: event === 'prompt' }, now, start && input.source !== 'compact')
    const offers = readOffers(root, id)
    const stops = offers?.stop?.length ? ` ${STOP_LINE(offers.stop)}` : ''
    if (start) return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONNECTED_LINE() } }
    if (event === 'prompt') return offers?.n || stops ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `${offers?.n ? READY_LINE(offers.n) : ''}${stops}`.trim() } } : null
    if (event === 'stop' && offers && (offers.n || offers.stop?.length) && offers.gen > (c.acted ?? 0)) {
      upsertConn(root, 'codex', session, { acted: offers.gen, busy: true }, now)
      return { decision: 'block', reason: `${offers.n ? READY_LINE(offers.n) : ''}${stops}`.trim() }
    }
    return null
  }

  // Cursor: its shell gives no session id, so its messages name the connection
  if (input.is_background_agent === true) return null
  const composer = typeof input.composer_mode === 'string' ? input.composer_mode : undefined
  const c = upsertConn(root, 'cursor', session, { cwd: root, busy: event === 'prompt', ...(composer ? { composer } : {}) }, now, event === 'start')
  const offers = readOffers(root, id)
  const stops = offers?.stop?.length ? ` ${STOP_LINE(offers.stop, c.id)}` : ''
  if (event === 'start') return { additional_context: CONNECTED_LINE(c.id) }
  if (event === 'prompt') return { continue: true }
  if (event === 'stop' && offers && (offers.n || offers.stop?.length) && offers.gen > (c.acted ?? 0)) {
    upsertConn(root, 'cursor', session, { acted: offers.gen, busy: true }, now)
    return { followup_message: `${offers.n ? READY_LINE(offers.n, c.id) : ''}${stops}`.trim() }
  }
  return null
}

// ---- Claude Code's listener --------------------------------------------------------------------------

/** One listener per Claude Code process (spec 29b, Part 5): registers the session, wakes it through
 *  its inbox when runs are offered, and exits with it. Started by both hooks; a second start hands
 *  over the current session id and exits. */
export async function listenCommand(rootOpt?: string): Promise<void> {
  const env = process.env
  if (env.MARVER_JAM_BACKGROUND === '1') return
  const input = await readStdin().catch(() => ({} as Record<string, any>))
  if (!ownHost('claude', input, env)) return
  const sock = env.CLAUDE_CODE_MESSAGING_SOCKET!, token = env.CLAUDE_CODE_MESSAGING_TOKEN, claudePid = Number(env.CLAUDE_PID)
  if (!token || !Number.isInteger(claudePid) || claudePid <= 1) return
  const session = String(input.session_id)
  const root = hookRoot(input, rootOpt)
  if (!root || await sessionsOff(root, env)) return
  const { claimListener, readListener, writeListener, releaseListener } = await import('../server/jam/listener.ts')
  const mode = typeof input.permission_mode === 'string' ? input.permission_mode : undefined
  // another listener already serves this Claude Code process: hand it this session id, and go
  const held = readListener(root, claudePid)
  if (held && held.pid !== process.pid && pidAlive(held.pid)) {
    if (held.session !== session || (mode && held.mode !== mode)) writeListener(root, claudePid, { ...held, session, ...(mode ? { mode } : {}) })
    return
  }
  if (!claimListener(root, claudePid, { pid: process.pid, session, ...(mode ? { mode } : {}) })) return
  const parent = process.ppid
  let current = session
  // a listener starting is a new incarnation: a new key, nothing the last one held still signs
  let conn: Conn = upsertConn(root, 'claude', current, { pid: claudePid, cwd: root, mode, busy: false }, Date.now(), true)
  const was = readOffers(root, conn.id)
  let posted = was?.gen ?? 0
  let stopsSaid = JSON.stringify(was?.stop ?? [])
  const post = (text: string) => new Promise<void>((res) => {
    const c = createConnection(sock)
    const end = () => { try { c.destroy() } catch { /* gone */ } res() }
    c.on('connect', () => {
      c.write(JSON.stringify({ type: 'auth', token }) + '\n')
      c.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n', () => setTimeout(end, 500))
    })
    c.on('error', end)
    setTimeout(end, 5_000)
  })
  const quit = () => { endConn(root, conn.id, conn.inc); releaseListener(root, claudePid, process.pid); process.exit(0) }
  process.on('SIGTERM', quit); process.on('SIGINT', quit); process.on('SIGHUP', quit)
  const look = async () => {
    // it ends with its Claude Code process (S29-5: an orphan would outlive the session)
    if (!pidAlive(claudePid) || process.ppid !== parent || !existsSync(join(root, 'design'))) return quit()
    const l = readListener(root, claudePid)
    if (l && l.pid !== process.pid) return quit()   // another took over (a stale lock, cleared): never two
    if (l && (l.session !== current || l.mode !== conn.mode)) {
      if (l.session !== current) { endConn(root, conn.id, conn.inc); current = l.session; posted = 0; stopsSaid = '[]' }
      conn = upsertConn(root, 'claude', current, { pid: claudePid, cwd: root, mode: l.mode, busy: false }, Date.now(), l.session !== conn.session)
    }
    const now = readConn(root, conn.id)
    if (!now || now.inc !== conn.inc) conn = upsertConn(root, 'claude', current, { pid: claudePid, cwd: root, mode: conn.mode, busy: false }, Date.now(), true)   // swept, or ended
    const o = readOffers(root, conn.id)
    if (!o) return
    const stops = JSON.stringify(o.stop ?? [])
    if (o.gen > posted) {
      posted = o.gen
      const lines = [o.n > 0 ? READY_LINE(o.n) : '', stops !== stopsSaid && o.stop?.length ? STOP_LINE(o.stop) : ''].filter(Boolean)
      stopsSaid = stops
      if (lines.length) await post(lines.join(' '))
    }
  }
  let busy = false
  const tick = () => { if (busy) return; busy = true; look().catch(() => {}).finally(() => { busy = false }) }
  try { watch(dirname(offersFile(root, conn.id)), { persistent: false }, tick) } catch { /* the interval is enough */ }
  setInterval(tick, 1_000)
}

// ---- the session's commands ----------------------------------------------------------------------------

/** This session's own connection: by its tool's session id, or `--as` (Cursor) - never "whichever". */
export function ownConn(root: string, env: NodeJS.ProcessEnv, as?: string): Conn {
  if (as) {
    const c = readConn(root, as)
    if (!c) throw new Error(`no connected session ${as} - it may have ended`)
    return c
  }
  const tries: [ConnAgent, string | undefined][] = [['claude', env.CLAUDE_CODE_SESSION_ID], ['codex', env.CODEX_THREAD_ID]]
  for (const [agent, session] of tries) {
    if (!session) continue
    const c = readConn(root, connId(agent, session))
    if (c) return c
  }
  if (env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID) throw new Error('this session is not connected to the canvas yet - it connects at its next message (or start a Jam session on the canvas)')
  const cursor = listConns(root).filter((c) => c.agent === 'cursor')
  throw new Error(cursor.length ? 'name your connection: --as <id>, as the message from Marver Jam said' : 'run this from the coding-agent session Marver Jam woke')
}

interface JamOpts { as?: string; file?: string; json?: boolean }

export async function jamCommand(root: string, action: string, args: string[], opts: JamOpts): Promise<void> {
  const ops: Op[] = ['next', 'say', 'progress', 'done', 'release', 'status', 'mute']
  if (!ops.includes(action as Op)) throw new Error(`unknown jam action "${action}" - next, say, progress, done, release, status or mute`)
  const conn = ownConn(root, process.env, opts.as)
  const a: Record<string, unknown> = {}
  if (['say', 'progress', 'done', 'release'].includes(action)) {
    if (!args[0]) throw new Error(`name the run: jam ${action} <handle>`)
    a.handle = args[0]
  }
  if (action === 'say') { a.text = args.slice(1).join(' ').trim(); if (!a.text) throw new Error('say what: jam say <handle> "On it - ..."') }
  if (action === 'done') {
    let text = ''
    if (opts.file) {
      const f = resolve(root, opts.file)
      if (!statSync(f).isFile()) throw new Error(`${opts.file} is not a file`)
      text = readFileSync(f, 'utf8')
    } else if (!process.stdin.isTTY) text = readFileSync(0, 'utf8')
    if (!text.trim()) throw new Error('hand back the final message: jam done <handle> --file <file> (the marver-reply blocks)')
    if (text.length > 400_000) throw new Error('the final message is too long - the replies go in marver-reply blocks, not the work itself')
    a.text = text
  }
  const r = await request(root, conn, action as Op, a, action === 'done' ? 120_000 : 30_000)
  if (opts.json) { console.log(JSON.stringify(r, null, 1)); return }
  if (r.ok === false) throw new Error(String(r.error ?? 'refused'))
  if (typeof r.text === 'string') console.log(r.text)
}
