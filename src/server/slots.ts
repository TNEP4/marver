/**
 * The slots (spec 28 A1.3): every canvas on this Mac listens on one of twenty fixed ports,
 * localhost:4805-4824, and says so in ~/.marver/running/ - the registry `marver ls` and the Mac app
 * read. A project usually gets the same slot back: its preferred slot, and the addresses it ran on,
 * live in ~/.marver/prefer/<workspace>.json.
 *
 * - A slot file (`running/slot-<n>.json`; an explicit port outside the range is `port-<p>.json`) is
 *   taken with the exclusive-file rules (exclusive.ts) while the port is checked free, written
 *   `starting`, and rewritten whole as `ready` with the bound origin once the server listens - a
 *   reader sees one or the other, never half a file. It holds the document proof's key (A1.4), which
 *   never leaves the file.
 * - A live holder means the next slot; a port another program holds is released and skipped, said
 *   once; a stuck `.reclaim` skips its slot with the repair line. All twenty taken: the start stops
 *   before Vite with the list.
 * - An explicit port inside the range claims exactly that slot and never falls back; one outside it is
 *   tried first and, when busy, falls back to a slot (0.26 fell back to the hash range).
 *
 * MARVER_HOME moves running/, prefer/ and canvases/ (the collaboration credentials, sync.ts) - the test
 * suite's own, so no test writes the owner's; models/ stays in ~/.marver (MARVER_MODELS moves it), read
 * and never written by the tests, so the voice suites keep the real model. MARVER_SLOT_BASE moves the
 * twenty ports, for the test suite alone. Both are read on every call, so a test can point a call
 * elsewhere.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { asHolder, pidRuns, portInUse, readJson, takeExclusive } from './exclusive.ts'
import { legacyWorkspace, workspaceId } from './workspace.ts'
import { NAME } from '../cli/name.ts'

export const SLOTS = 20

export const marverHome = (): string => process.env.MARVER_HOME || join(homedir(), '.marver')

/** The port before slot 1 - slot n listens on base + n (localhost:4805-4824). MARVER_SLOT_BASE moves
 *  the range for the test suite alone: the port check sees every program on this Mac, so a suite on
 *  4805+ would take the slot of a canvas someone is using. */
export function slotBase(): number {
  const b = Number(process.env.MARVER_SLOT_BASE)
  return process.env.MARVER_SLOT_BASE && Number.isInteger(b) && b >= 1024 && b <= 65535 - SLOTS ? b : 4804
}
export const slotPort = (n: number): number => slotBase() + n
export const slotOfPort = (port: number): number | null => { const n = port - slotBase(); return n >= 1 && n <= SLOTS ? n : null }

/** `~/x` for a path under the home directory - how paths are shown. */
export const tilde = (p: string): string => {
  const h = homedir()
  return p === h ? '~' : p.startsWith(h + '/') ? `~${p.slice(h.length)}` : p
}

const runningDir = () => join(marverHome(), 'running')
const preferDir = () => join(marverHome(), 'prefer')
/** A registry folder, made for writing: mode 700. The home itself is made 700 only when missing (it holds
 *  canvases/ and models/ too, and an existing one is never changed). */
function made(d: string): string {
  mkdirSync(marverHome(), { recursive: true, mode: 0o700 })
  mkdirSync(d, { recursive: true, mode: 0o700 })
  try { chmodSync(d, 0o700) } catch { /* best effort: not ours to fix */ }
  return d
}
export const slotFileOf = (n: number): string => join(runningDir(), `slot-${n}.json`)
export const portFileOf = (port: number): string => join(runningDir(), `port-${port}.json`)

/** Write `file` whole: a private temp file renamed over it. */
function writeWhole(file: string, body: string): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  try { renameSync(tmp, file) } catch (err) { try { unlinkSync(tmp) } catch { /* gone */ } throw err }
}

// ---- the record -------------------------------------------------------------------------------

export interface SlotFile {
  v: 1
  state: 'starting' | 'ready'
  pid: number
  instance: string
  /** null for an explicit port outside the range (port-<p>.json) */
  slot: number | null
  port: number
  /** the address the server actually bound (`http://[::1]:4806`) - what the app loads; null while starting */
  origin: string | null
  /** `http://localhost:<port>/` - the link for people, and the browser's storage origin */
  url: string
  /** the project's real path, and its folder name */
  root: string
  name: string
  version: string
  /** what this canvas's shell offers the app, by short name (0.27.0: none) */
  features: string[]
  /** the workspace this run serves under (A1.6) - a --recover run's is an earlier address's */
  ws: string
  startedAt: number
  /** 32 random bytes, base64url: the document proof's key (A1.4). Never leaves the file */
  key: string
}

/** A record read back, or null when the file names no canvas. Lenient on what a later version adds. */
function asRecord(v: unknown): SlotFile | null {
  const h = asHolder(v)
  const r = v as Partial<SlotFile> | null
  if (!h || !r || typeof r.port !== 'number' || typeof r.url !== 'string') return null
  return {
    v: 1, state: r.state === 'ready' ? 'ready' : 'starting', pid: h.pid, instance: h.instance,
    slot: typeof r.slot === 'number' ? r.slot : null, port: r.port, origin: typeof r.origin === 'string' ? r.origin : null, url: r.url,
    root: typeof r.root === 'string' ? r.root : '', name: typeof r.name === 'string' ? r.name : '', version: typeof r.version === 'string' ? r.version : '',
    features: Array.isArray(r.features) ? r.features.filter((f): f is string => typeof f === 'string') : [],
    ws: typeof r.ws === 'string' ? r.ws : '', startedAt: typeof r.startedAt === 'number' ? r.startedAt : h.at, key: typeof r.key === 'string' ? r.key : '',
  }
}

// ---- placing a canvas -------------------------------------------------------------------------

export interface Claim {
  slot: number | null
  port: number
  file: string
  instance: string
  key: Buffer
  url: string
  /** the file rewritten whole as `ready`, with the bound origin (same instance, same key) */
  ready(origin: string): void
  /** removes the file while it still names this instance */
  release(): void
}

export interface PlaceInput {
  /** the project's real path, and its folder name */
  root: string
  name: string
  version: string
  /** the canonical identity: picks the preference file (A1.13 #6) */
  id: string
  /** the workspace this run serves under: written into the record */
  ws: string
  instance: string
  pid?: number
  /** --port, or a config.port other than 5199 */
  explicit?: { port: number; from: 'flag' | 'config' }
  /** --recover: exactly this port, never another */
  recover?: { port: number }
  /** each file's release, the moment it is held - before the port check awaits (A1.1) */
  onHold?: (release: () => void) => void
  reclaimWaitMs?: number
  /** tests: the port check */
  inUse?: (port: number) => Promise<boolean>
}
export type Placed =
  | { ok: true; claim: Claim; notes: string[]; fellBackFrom?: number }
  | { ok: false; message: string }

type Took =
  | { ok: true; claim: Claim }
  | { ok: false; why: 'held'; holder: SlotFile | null; file: string }
  | { ok: false; why: 'busy' | 'stuck' | 'unreadable'; file: string }

/** Take one candidate: the file, then - holding it - the port check. */
async function take(i: PlaceInput, slot: number | null, port: number): Promise<Took> {
  const file = slot ? slotFileOf(slot) : portFileOf(port)
  made(runningDir())
  const key = randomBytes(32)
  const rec: SlotFile = {
    v: 1, state: 'starting', pid: i.pid ?? process.pid, instance: i.instance, slot, port, origin: null, url: `http://localhost:${port}/`,
    root: i.root, name: i.name, version: i.version, features: [], ws: i.ws, startedAt: Date.now(), key: key.toString('base64url'),
  }
  const r = await takeExclusive(file, { pid: rec.pid, instance: rec.instance, at: rec.startedAt }, JSON.stringify(rec, null, 2) + '\n', { reclaimWaitMs: i.reclaimWaitMs })
  if (!r.ok) return r.why === 'held' ? { ok: false, why: 'held', holder: asRecord(readJson(file)), file } : { ok: false, why: r.why, file }
  i.onHold?.(r.release)
  if (await (i.inUse ?? portInUse)(port)) { r.release(); return { ok: false, why: 'busy', file } }
  return {
    ok: true,
    claim: {
      slot, port, file, instance: rec.instance, key, url: rec.url, release: r.release,
      ready(origin: string) {
        // only over our own claim: a file some other start holds is never overwritten
        if (asHolder(readJson(file))?.instance !== rec.instance) return
        writeWhole(file, JSON.stringify({ ...rec, state: 'ready', origin }, null, 2) + '\n')
      },
    },
  }
}

const canvasOf = (rec: SlotFile | null): string => rec ? `"${rec.name || '?'}" (${tilde(rec.root) || '?'})` : 'another canvas'
const stuckLine = (n: number): string => `slot ${n} is stuck: delete ${tilde(slotFileOf(n))}.reclaim if no canvas is starting`
const unreadableLine = (file: string, n: number | null): string => `${tilde(file)} is unreadable - ${n ? `slot ${n}` : 'that port'} skipped (delete it if no canvas runs there)`

/** A slot, any slot: the project's preferred one first, then 1..20. */
async function anySlot(i: PlaceInput, notes: string[]): Promise<Placed> {
  const preferred = readPrefer(i.id)?.slot ?? null
  const order = [...(preferred ? [preferred] : []), ...Array.from({ length: SLOTS }, (_, k) => k + 1).filter((n) => n !== preferred)]
  for (const n of order) {
    const t = await take(i, n, slotPort(n))
    if (t.ok) return { ok: true, claim: t.claim, notes }
    if (t.why === 'busy') notes.push(`port ${slotPort(n)} is used by another program - slot ${n} skipped`)
    else if (t.why === 'stuck') notes.push(stuckLine(n))
    else if (t.why === 'unreadable') notes.push(unreadableLine(t.file, n))
  }
  return { ok: false, message: [`all ${SLOTS} slots are taken:`, ...formatRunning(readRunning()).map((l) => `  ${l}`), ...notes, 'stop one (Ctrl-C in its terminal), or start this one with --port <n>'].join('\n  ') }
}

/** Where this canvas listens: a slot, a port of its own, or --recover's exact one - held as a file before
 *  anything binds. */
export async function place(i: PlaceInput): Promise<Placed> {
  if (i.recover) {
    const port = i.recover.port
    const n = slotOfPort(port)
    const t = await take(i, n, port)
    if (t.ok) return { ok: true, claim: t.claim, notes: [] }
    const never = '--recover never takes another address'
    return { ok: false, message:
      t.why === 'held' ? `port ${port} is held by ${canvasOf(t.holder)} - ${never}; stop it (Ctrl-C in its terminal) and run it again`
      : t.why === 'busy' ? `port ${port} is in use - ${never}; stop what holds it and run it again`
      : t.why === 'stuck' && n ? `${stuckLine(n)} - ${never}`
      : `${unreadableLine(t.file, n)} - ${never}` }
  }
  if (i.explicit) {
    const { port, from } = i.explicit
    const n = slotOfPort(port)
    if (n) {
      // a port inside the range claims exactly that slot - never another (A1.3)
      const t = await take(i, n, port)
      if (t.ok) return { ok: true, claim: t.claim, notes: [] }
      const instead = from === 'config' ? 'or remove `port` from design/config.ts' : 'or start without --port'
      return { ok: false, message:
        t.why === 'held' ? `port ${port} is slot ${n}, and ${canvasOf(t.holder)} holds it - stop it first (Ctrl-C in its terminal), ${instead}`
        : t.why === 'busy' ? `port ${port} (slot ${n}) is in use by another program - stop it, ${instead}`
        : t.why === 'stuck' ? stuckLine(n)
        : unreadableLine(t.file, n) }
    }
    const t = await take(i, null, port)
    if (t.ok) return { ok: true, claim: t.claim, notes: [] }
    const notes = t.why === 'stuck' ? [`${tilde(t.file)}.reclaim is left from a start that crashed: delete it if no canvas is starting`]
      : t.why === 'unreadable' ? [unreadableLine(t.file, null)] : []
    const placed = await anySlot(i, notes)
    return placed.ok ? { ...placed, fellBackFrom: port } : placed
  }
  return anySlot(i, [])
}

/** The address a listening server actually bound - `[::1]` or `127.0.0.1`, wildcards mapped to
 *  loopback - or null before it listens. */
export const originOf = (a: AddressInfo | string | null | undefined): string | null => {
  if (!a || typeof a === 'string') return null
  const host = a.family === 'IPv6'
    ? (a.address === '::' ? '[::1]' : `[${a.address}]`)
    : (a.address === '0.0.0.0' ? '127.0.0.1' : a.address)
  return `http://${host}:${a.port}`
}

/** 0.26's per-project port in [5200,5399], verbatim - kept only so --recover can offer the address a
 *  canvas had before 0.27. Hashes the root exactly as given, as 0.26 did. */
export const legacyPort = (root: string): number => {
  let h = 0
  for (let i = 0; i < root.length; i++) h = (Math.imul(h, 31) + root.charCodeAt(i)) | 0
  return 5200 + (Math.abs(h) % 200)
}

/** What every `marver dev` since 0.24 writes in design/.local as it starts and keeps once it stops: the sidebar
 *  marks (changes.json, seen.json - the dev server their only writer, at every start), the daily update check,
 *  the Jam queue, the reload log. No other command writes them, and dev.lock and dev.json go when a canvas stops. */
const DEV_TRACES = ['changes.json', 'seen.json', 'update-check.json', 'jam-jobs.json', join('perf', 'reloads.jsonl')]
/** Did a `marver dev` run in this folder before? Read before this start writes any of them: with none, a project
 *  with no preference file is new, not one 0.26 served - and its first start has nothing to say about 0.26. */
export const ranDevBefore = (root: string): boolean => DEV_TRACES.some((f) => existsSync(join(root, 'design', '.local', f)))
/** A start that found none of them and failed (a sandbox, a port just taken) takes back those it wrote - the marks
 *  (with their deps.json) and the rest - so the folder still reads as one no canvas ran in. */
export const forgetDevTraces = (root: string): void => {
  for (const f of [...DEV_TRACES, 'deps.json']) { try { rmSync(join(root, 'design', '.local', f), { force: true }) } catch { /* not ours to fight */ } }
}

// ---- the preference file ------------------------------------------------------------------------

/** One address a project ran on: `url` the link people open (the browser's storage origin), `bind` the
 *  address the server bound (what the app loads), `ws` the workspace that run served under. `from` is the
 *  first start there; `until` moves at each start there and when it stops. */
export interface Address { url: string; bind: string; ws: string; from: number; until: number }
export interface Prefer { v: 1; slot: number | null; history: Address[] }
export interface RunAddress { slot: number | null; url: string; bind: string; ws: string }

const HISTORY = 5
const preferFileOf = (id: string): string | null => /^[0-9a-f]{16}$/.test(id) ? join(preferDir(), `${id}.json`) : null
const sameAddress = (a: { url: string; bind: string; ws: string }, b: { url: string; bind: string; ws: string }) => a.url === b.url && a.bind === b.bind && a.ws === b.ws

/** The project's preference: undefined when it has none (its first 0.27 run), null when the file is there
 *  but unreadable (not a first run; the next write replaces it). */
export function readPrefer(id: string): Prefer | null | undefined {
  const file = preferFileOf(id)
  if (!file) return null
  const raw = readJson(file) as Partial<Prefer> | null | undefined
  if (raw === undefined) return undefined
  if (!raw || raw.v !== 1 || !(raw.slot === null || (Number.isInteger(raw.slot) && raw.slot! >= 1 && raw.slot! <= SLOTS)) || !Array.isArray(raw.history)) return null
  const history = raw.history.filter((a): a is Address => !!a && typeof a.url === 'string' && typeof a.bind === 'string' && typeof a.ws === 'string')
    .map((a) => ({ url: a.url, bind: a.bind, ws: a.ws, from: Number(a.from) || 0, until: Number(a.until) || 0 }))
  return { v: 1, slot: raw.slot ?? null, history }
}

/** Record this run's address, after ready: a new entry only when url, bind or ws differ from the newest
 *  (so recovery never loses the one it needs); an address it ran on before moves to the front, keeping its
 *  first start - five distinct addresses at most. Says whether this is the project's first 0.27 run, and
 *  the address it ran on last. */
export function notePrefer(id: string, run: RunAddress, now: number = Date.now()): { first: boolean; previous: Address | null } {
  const file = preferFileOf(id)
  if (!file) throw new Error(`not a workspace id: ${id}`)
  const cur = readPrefer(id)
  const previous = cur?.history[0] ? { ...cur.history[0] } : null
  const before = cur?.history.find((a) => sameAddress(a, run))
  const history = [{ url: run.url, bind: run.bind, ws: run.ws, from: before?.from ?? now, until: now }, ...(cur?.history ?? []).filter((a) => !sameAddress(a, run))]
  made(preferDir())
  writeWhole(file, JSON.stringify({ v: 1, slot: run.slot ?? cur?.slot ?? null, history: history.slice(0, HISTORY) } satisfies Prefer, null, 2) + '\n')
  return { first: cur === undefined, previous }
}

/** This run stopped: its entry's `until` (best effort, synchronous - it runs on exit and on signals). */
export function stopPrefer(id: string, run: RunAddress, now: number = Date.now()): void {
  try {
    const file = preferFileOf(id)
    const cur = readPrefer(id)
    if (!file || !cur || !cur.history[0] || !sameAddress(cur.history[0], run)) return
    cur.history[0].until = now
    writeWhole(file, JSON.stringify(cur, null, 2) + '\n')
  } catch { /* the start time stays */ }
}

// ---- --recover ------------------------------------------------------------------------------------

export interface RecoverEntry { url: string; bind: string; ws: string; from?: number; until?: number; legacy?: true }
/** What a --recover run binds and serves under: the port, the host Vite binds (undefined = its default,
 *  as 0.26 had it), the workspace key, and the two addresses to say. */
export interface Recover { port: number; host?: string; ws: string; url: string; bind: string }

/** The address 0.26 gave this folder: its hash port, `localhost`, and its key. */
export const legacyEntry = (root: string, port: number = legacyPort(root)): RecoverEntry =>
  ({ url: `http://localhost:${port}/`, bind: `http://localhost:${port}`, ws: legacyWorkspace(root), legacy: true })

/** The addresses this project ran on, newest first, then the one 0.26 gave it - always last, because the
 *  first 0.27 run has written history by the time anyone acts on its hint (A1.13 #6). */
export function recoverEntries(root: string): RecoverEntry[] {
  const history: RecoverEntry[] = readPrefer(workspaceId(root))?.history ?? []
  const legacy = legacyEntry(root)
  return history.some((h) => h.url === legacy.url && h.ws === legacy.ws) ? history : [...history, legacy]
}

/** What a start knows about where this canvas ran before. */
export interface Before {
  root: string
  /** this run's address, and its port */
  run: RunAddress
  port: number
  /** notePrefer's answer: this project's first 0.27 run, and the address it ran on last */
  first: boolean
  previous: Address | null
  /** ranDevBefore, read before this start wrote anything */
  ranBefore: boolean
}

/** What a start says about where this canvas ran before (A1.6) - nothing, when nothing a person could have open
 *  there has moved:
 *  - its first 0.27 start on a slot, only when a `marver dev` ran in this folder before: a new project has no 0.26
 *    address to name;
 *  - another link than last time (its slot taken, a port of its own given up): where it was, who runs there now
 *    when a canvas does, and how to run there again. A tab still open there keeps its unsaved edits until this
 *    canvas answers there, and a Jam capture left unsent waits there too. The link alone counts: the address a run
 *    bound (`[::1]` or `127.0.0.1`) is what the Mac app loads, and a browser at the link reaches either. */
export function startedWhere(b: Before): string[] {
  if (b.first) {
    if (!b.ranBefore || !b.run.slot) return []
    const old = legacyPort(b.root)
    return [`ports are now fixed slots: this canvas is at ${b.run.url}`,
      ...(old !== b.port ? [`0.26 served this canvas at http://localhost:${old}/ - if a Jam capture was left unsent there, \`npx ${NAME} dev --recover\` gets it back`] : [])]
  }
  const p = b.previous
  if (!p || p.url === b.run.url) return []
  const holder = readRunning().find((r) => r.url === p.url && r.pid !== process.pid)
  const who = holder ? `"${holder.name || '?'}"` : null
  // its place in --recover's list: this run is the newest, the address before it next
  const n = recoverEntries(b.root).findIndex((e) => e.url === p.url && e.bind === p.bind && e.ws === p.ws) + 1
  return [
    `last run was at ${p.url}${who ? ` - ${who} runs there now` : ''}`,
    'a tab still open there keeps its unsaved edits until this canvas runs there again (a Jam capture left unsent there waits too):',
    `stop ${who ? `${who} and ` : ''}this canvas, then \`npx ${NAME} dev --recover${n ? ` ${n}` : ''}\``,
  ]
}

export function recoverTarget(e: RecoverEntry): Recover {
  const b = new URL(e.bind)
  const port = Number(b.port)
  const host = b.hostname === 'localhost' ? undefined : b.hostname.replace(/^\[(.*)\]$/, '$1')
  return { port, ...(host ? { host } : {}), ws: e.ws, url: e.url, bind: e.bind }
}

// ---- marver ls, and the list a full start prints ---------------------------------------------

export type Running = Omit<SlotFile, 'key' | 'instance'> & { file: string }

/** The canvases running on this Mac: every slot and port file whose pid runs, slots by number, then
 *  ports. Reads only - a Mac with no registry has none. */
export function readRunning(): Running[] {
  let names: string[]
  try { names = readdirSync(runningDir()) } catch { return [] }
  const out: Running[] = []
  for (const name of names) {
    if (!/^(slot-\d+|port-\d+)\.json$/.test(name)) continue
    const file = join(runningDir(), name)
    const rec = asRecord(readJson(file))
    if (!rec || !pidRuns(rec.pid)) continue
    const { key: _key, instance: _instance, ...pub } = rec
    out.push({ ...pub, file })
  }
  return out.sort((a, b) => (a.slot === null ? 1 : 0) - (b.slot === null ? 1 : 0) || (a.slot ?? a.port) - (b.slot ?? b.port))
}

export const uptime = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : m ? `${m}m` : `${s}s`
}

/** The list as `marver ls` prints it: slot, link, name, version, state, uptime, then the folder - last, its length
 *  its own, so the columns before it stay on the line. */
export function formatRunning(list: Running[], now: number = Date.now()): string[] {
  const rows = [['slot', 'link', 'name', 'version', 'state', 'up', 'folder'],
    ...list.map((r) => [r.slot === null ? '-' : String(r.slot), r.url, r.name, r.version, r.state, uptime(now - r.startedAt), tilde(r.root)])]
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)))
  return rows.map((r) => r.map((cell, c) => c === 0 ? cell.padStart(widths[c]) : cell.padEnd(widths[c])).join('  ').trimEnd())
}
