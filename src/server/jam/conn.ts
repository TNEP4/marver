/**
 * The sessions connected to this repo (spec 29b, Part 3): one file per connection under
 * design/.local/jam/conn/, written by the hooks (`marver jam hook`, `marver jam listen`) and read by
 * the daemon. A connection is one Claude Code, Codex or Cursor session that can take Jam runs.
 *
 * Also the small shared state beside them: the offers file the daemon writes for each connection
 * (what the Claude Code listener and the Stop hooks read), and this machine's Jam preferences (the
 * start sheet's switches).
 *
 * Kept free of heavy imports: the hooks load this on every session start and every prompt.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ConnAgent = 'claude' | 'codex' | 'cursor'
export const CONN_AGENTS: ConnAgent[] = ['claude', 'codex', 'cursor']

export interface Conn {
  v: 1
  id: string
  agent: ConnAgent
  /** the tool's own session id (Claude Code's session, Codex's thread, Cursor's conversation) */
  session: string
  /** the tool's process - Claude Code's CLAUDE_PID, the Codex process its hook runs under; Cursor has none */
  pid?: number
  cwd: string
  /** the tool's permission mode, as its hook said (plan: never eligible) */
  mode?: string
  /** a turn is running: Codex's and Cursor's Stop hooks will pull an offer at its end */
  busy: boolean
  /** registered, and the last hook heard from it (ms) */
  since: number
  seen: number
  /** the connection capability: 32 random bytes, hex - every request it makes is MACed with it */
  key: string
  /** muted until it ends (`marver jam mute`, or MARVER_JAM=off in its environment) */
  muted?: boolean
  /** Cursor's sessionEnd came */
  ended?: boolean
  /** Cursor's composer mode at start (only `agent` can edit) */
  composer?: string
  /** the last offer generation its Stop hook acted on - it pulls once per new offer, never in a loop */
  acted?: number
  /** this registration's incarnation: a new one (a new process, a resume) makes a new key */
  inc: string
}

export const jamDir = (root: string) => join(root, 'design', '.local', 'jam')
export const connDir = (root: string) => join(jamDir(root), 'conn')
export const connFile = (root: string, id: string) => join(connDir(root), `${id}.json`)
export const offersFile = (root: string, id: string) => join(connDir(root), `${id}.offers`)
export const prefsFile = (root: string) => join(jamDir(root), 'prefs.json')

const CONN_ID = /^(claude|codex|cursor)-[0-9a-f]{12}$/
export const validConnId = (id: unknown): id is string => typeof id === 'string' && CONN_ID.test(id)
export const connId = (agent: ConnAgent, session: string): string => `${agent}-${createHash('sha256').update(session).digest('hex').slice(0, 12)}`

/** A Cursor session not heard from in this long is gone (Cursor has no process to look at). */
export const CURSOR_SILENT_MS = 6 * 60 * 60_000

/** Write a file whole or not at all: a reader never sees half of it. */
export function writeAtomic(file: string, text: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode })
  try { renameSync(tmp, file) } catch (err) { rmSync(tmp, { force: true }); throw err }
}

const ensureDir = (dir: string) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); try { chmodSync(dir, 0o700) } catch { /* not ours to change */ } }

export function readConn(root: string, id: string): Conn | null {
  if (!validConnId(id)) return null
  try {
    const c = JSON.parse(readFileSync(connFile(root, id), 'utf8')) as Conn
    return c && c.v === 1 && c.id === id && typeof c.key === 'string' && typeof c.inc === 'string' && CONN_AGENTS.includes(c.agent) ? c : null
  } catch { return null }
}

export function listConns(root: string): Conn[] {
  let names: string[]
  try { names = readdirSync(connDir(root)) } catch { return [] }
  return names.filter((n) => n.endsWith('.json')).map((n) => readConn(root, n.slice(0, -5))).filter((c): c is Conn => !!c)
}

/** Register (or refresh) a session's connection. A refresh keeps its incarnation and key - the capability
 *  its commands sign with; `fresh` (a session starting, a listener taking over) begins a new incarnation with a
 *  new key, so nothing the last one held still signs. An ended connection comes back only fresh. */
export function upsertConn(root: string, agent: ConnAgent, session: string, patch: Partial<Omit<Conn, 'v' | 'id' | 'agent' | 'session' | 'key' | 'since' | 'inc'>>, now = Date.now(), fresh = false): Conn {
  ensureDir(connDir(root))
  const id = connId(agent, session)
  const was0 = readConn(root, id)
  const was = was0 && !fresh && !was0.ended ? was0 : null
  // a field the hook did not know (undefined) keeps what was there
  const known = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  const c: Conn = {
    ...(was ?? { cwd: root, busy: false, since: now, key: randomBytes(32).toString('hex'), inc: randomBytes(6).toString('hex') }),
    ...known,
    v: 1, id, agent, session, seen: now,
    ...(was ? {} : { ended: undefined, muted: undefined, acted: was0?.acted }),
  } as Conn
  writeAtomic(connFile(root, id), JSON.stringify(c))
  return c
}

/** A session ended (its end hook, its listener exiting): marked, not removed - a run it held is reconciled first;
 *  the daemon removes it once nothing depends on it. `inc`: only that incarnation (a resumed one stays). */
export function endConn(root: string, id: string, inc?: string): void {
  const c = readConn(root, id)
  if (!c || c.ended || (inc && c.inc !== inc)) return
  writeAtomic(connFile(root, id), JSON.stringify({ ...c, ended: true, seen: Date.now() }))
}

/** Remove a connection for good: its file and its offers go. */
export function closeConn(root: string, id: string): void {
  if (!validConnId(id)) return
  rmSync(connFile(root, id), { force: true })
  rmSync(offersFile(root, id), { force: true })
}

export const pidAlive = (pid: number | undefined): boolean => {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

export const alive = (c: Conn, now = Date.now()): boolean =>
  !c.ended && (c.agent === 'cursor' ? now - c.seen < CURSOR_SILENT_MS : pidAlive(c.pid))

/** Is its writer proven gone? Its process is (Claude Code, Codex), or it said it ended (Cursor). Silence alone
 *  is not proof: a Cursor session not heard from is "unknown", never "stopped". */
export const gone = (c: Conn | null): boolean => !c || !!c.ended || (c.agent !== 'cursor' && !pidAlive(c.pid))

/** Can this session take Jam work now? (The selection and the runner choice come after.) */
export const eligible = (c: Conn, now = Date.now()): boolean =>
  alive(c, now) && !c.muted && c.mode !== 'plan' && (c.agent !== 'cursor' || !c.composer || c.composer === 'agent')

// ---- offers: what the daemon has for a connection -----------------------------------------------

/** `n`: runs offered to it now; `gen`: grows with every new offer - a listener or a Stop hook acts once per gen. */
export interface Offers { n: number; gen: number; stop?: string[] }

export function writeOffers(root: string, id: string, o: Offers): void {
  if (!validConnId(id)) return
  ensureDir(connDir(root))
  writeAtomic(offersFile(root, id), JSON.stringify(o))
}
export function readOffers(root: string, id: string): Offers | null {
  try {
    const o = JSON.parse(readFileSync(offersFile(root, id), 'utf8')) as Offers
    return Number.isInteger(o?.n) && Number.isInteger(o?.gen) ? o : null
  } catch { return null }
}

// ---- this machine's Jam preferences (the start sheet's switches) --------------------------------

export interface Prefs {
  mcp?: boolean
  skills?: boolean
  context?: 'fork' | 'fresh'
  others?: boolean
  /** the session the owner picked to take the work (kept until it ends) */
  pick?: string
  /** connectors the owner turned off in the sheet, or removed by hand */
  off?: Partial<Record<ConnAgent, boolean>>
}

export function readPrefs(root: string): Prefs {
  try {
    const p = JSON.parse(readFileSync(prefsFile(root), 'utf8'))
    return p && typeof p === 'object' && !Array.isArray(p) ? p as Prefs : {}
  } catch { return {} }
}
export function writePrefs(root: string, p: Prefs): void {
  ensureDir(jamDir(root))
  writeAtomic(prefsFile(root), JSON.stringify(p, null, 1))
}
