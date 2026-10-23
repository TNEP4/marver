/**
 * Running canvases (spec 28 A2.3, A2.14 #10, #12). Owner: the trust stream.
 *
 * The app reads `<MARVER_HOME>/running/` itself and never calls the package's `readRunning()`, which drops `key`
 * and `instance` and reads synchronously (A2.14 #12). Each `slot-<n>.json` / `port-<p>.json`:
 * - is opened without following a link (`O_NOFOLLOW`, `O_NONBLOCK`: a FIFO never blocks main) and checked on the
 *   open file itself: a regular file, the inode `lstat` saw, owned by this user, `mode & 0o077 === 0`, at most
 *   16 KB. The folder itself must be a real folder of this user that no one else can write;
 * - must hold A1.3's record: `v: 1`, a pid, an instance, `slot-<n>.json` holding slot n on `slotBase() + n`
 *   (MARVER_SLOT_BASE honoured, as the package does), `port-<p>.json` holding no slot and port p, `url` exactly
 *   `http://localhost:<port>/`, a loopback `origin` on that port once `ready`, a 32-byte key, a 16-hex `ws`;
 * - counts only while its pid runs: `process.kill(pid, 0)`, and `EPERM` is gone - the file is ours, so a pid of
 *   another user is a reused one.
 * Only `starting` and `ready` records are listed; a `closing` one is gone for opening (A2.3), told once as
 * `{ kind: 'gone', why: 'closing' }`. A state a later marver adds reads as `starting`: never opened.
 *
 * The folder is watched (100 ms debounce) and reconciled every 5 s - a SIGKILLed canvas changes no file, so only
 * the tick notices it. `reread()` is one fresh read now, for the proof's "instance differs" path (A2.14 #11): its
 * events are told before it resolves. Every read is async: main carries every local script request.
 *
 * The key never leaves main: no event, log line or test hook carries it (`publicEntry` strips it).
 */
import { constants, watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { SlotFile } from '../../../src/server/slots.ts'
import { marverHome } from './config.ts'
import { T } from './timings.ts'

/** A slot file read and checked: the package's record with its key decoded. The key never leaves main. */
export interface RegistryEntry extends Omit<SlotFile, 'v' | 'key'> {
  /** `running/slot-<n>.json` or `running/port-<p>.json` */
  file: string
  /** the document proof's key, 32 bytes */
  key: Buffer
}

/** What the reader tells the tabs. `starting` binds a tab by `(ws, port)`; `ready` by `(ws, origin)` (A2.14 #10). */
export type RegistryEvent =
  | { kind: 'entry'; entry: RegistryEntry }
  | { kind: 'gone'; file: string; instance: string; why: 'pid' | 'removed' | 'closing' }

export interface Registry {
  /** makes `running/` (700) when missing, then watches and reconciles */
  start(): Promise<void>
  stop(): void
  /** the live `starting` and `ready` entries, by slot then port */
  entries(): RegistryEntry[]
  byPort(port: number): RegistryEntry | undefined
  /** the live entry of that instance (never a `closing` one) */
  byInstance(instance: string): RegistryEntry | undefined
  /** one fresh read (the proof's "instance differs" path, A2.14 #11); its events are told before it resolves */
  reread(): Promise<void>
  on(fn: (e: RegistryEvent) => void): () => void
}

export interface RegistryOptions {
  /** `<MARVER_HOME>/running` by default */
  dir?: string
  /** whether a pid runs (tests) */
  alive?: (pid: number) => boolean
  /** a line about a file skipped or the folder refused - once per file, change and reason */
  log?: (line: string) => void
}

export const SLOTS = 20
/** The most a slot file may weigh. */
export const MAX_FILE = 16 * 1024
const NAME = /^(?:slot-(\d{1,2})|port-(\d{1,5}))\.json$/
const WS = /^[0-9a-f]{16}$/
const INSTANCE = /^[A-Za-z0-9_-]{8,64}$/
/** base64url of 32 bytes, unpadded: 43 characters, the last carrying 4 bits */
const KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** The port before slot 1, as the package reads it (slots.ts `slotBase`). */
export function slotBase(env: NodeJS.ProcessEnv = process.env): number {
  const b = Number(env.MARVER_SLOT_BASE)
  return env.MARVER_SLOT_BASE && Number.isInteger(b) && b >= 1024 && b <= 65535 - SLOTS ? b : 4804
}

/** What `fstat` said of the open file. */
export interface FileFacts { uid: number; mode: number; isFile: boolean; isSymlink: boolean; size: number }

export type Parsed = { ok: true; entry: RegistryEntry } | { ok: false; why: string }

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/** A bound origin the app may load: http, a loopback host, the record's port, nothing else in it. */
export function boundOrigin(origin: unknown, port: number): string | null {
  if (typeof origin !== 'string' || origin.length > 64) return null
  let u: URL
  try { u = new URL(origin) } catch { return null }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || Number(u.port) !== port) return null
  return u.origin === origin ? origin : null
}

/** One slot file, checked (pure). `file` is its name in running/. */
export function parseEntry(file: string, facts: FileFacts, raw: string, opts: { uid: number; slotBase: number }): Parsed {
  const m = NAME.exec(file)
  if (!m) return { ok: false, why: 'not a slot file name' }
  if (!facts.isFile || facts.isSymlink) return { ok: false, why: 'not a regular file' }
  if (facts.uid !== opts.uid) return { ok: false, why: 'owned by another user' }
  if ((facts.mode & 0o077) !== 0) return { ok: false, why: 'readable or writable by others' }
  if (facts.size > MAX_FILE) return { ok: false, why: 'larger than 16 KB' }
  let r: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, why: 'not a record' }
    r = v as Record<string, unknown>
  } catch { return { ok: false, why: 'not JSON' } }
  if (r.v !== 1) return { ok: false, why: 'not version 1' }
  if (!int(r.pid, 1, 2 ** 31 - 1)) return { ok: false, why: 'no pid' }
  if (typeof r.instance !== 'string' || !INSTANCE.test(r.instance)) return { ok: false, why: 'no instance' }
  if (!int(r.port, 1, 65535)) return { ok: false, why: 'no port' }
  const port = r.port
  if (m[1] !== undefined) {
    const n = Number(m[1])
    if (n < 1 || n > SLOTS || r.slot !== n) return { ok: false, why: 'its slot is not its name' }
    if (port !== opts.slotBase + n) return { ok: false, why: 'its port is not its slot' }
  } else if (r.slot !== null || port !== Number(m[2])) return { ok: false, why: 'its port is not its name' }
  if (r.url !== `http://localhost:${port}/`) return { ok: false, why: 'its url is not localhost on its port' }
  if (typeof r.ws !== 'string' || !WS.test(r.ws)) return { ok: false, why: 'no workspace' }
  if (typeof r.key !== 'string' || !KEY.test(r.key)) return { ok: false, why: 'no 32-byte key' }
  const key = Buffer.from(r.key, 'base64url')
  if (key.length !== 32) return { ok: false, why: 'no 32-byte key' }
  if (!str(r.root, 4096) || !isAbsolute(r.root)) return { ok: false, why: 'no root' }
  if (!str(r.name, 200)) return { ok: false, why: 'no name' }
  if (!str(r.version, 50)) return { ok: false, why: 'no version' }
  if (r.features !== undefined && !(Array.isArray(r.features) && r.features.length <= 32 && r.features.every((f) => str(f, 32)))) return { ok: false, why: 'bad features' }
  // a state a later marver adds reads as starting: never opened (slots.ts asRecord)
  const state = r.state === 'ready' || r.state === 'closing' ? r.state : 'starting'
  let origin: string | null = null
  if (state !== 'starting') {
    origin = boundOrigin(r.origin, port)
    if (!origin) return { ok: false, why: 'its origin is not loopback on its port' }
  }
  return {
    ok: true,
    entry: {
      file, state, pid: r.pid, instance: r.instance, slot: m[1] !== undefined ? Number(m[1]) : null, port, origin,
      url: r.url, root: r.root, name: r.name, version: r.version, features: (r.features as string[] | undefined) ?? [],
      ws: r.ws, startedAt: typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : 0, key,
    },
  }
}

/** Does `pid` run? `EPERM` is gone: the file is ours, so another user's pid is a reused one (A2.14 #12). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** An entry without its key - for logs, journals and test hooks. */
export function publicEntry(e: RegistryEntry): Omit<RegistryEntry, 'key'> {
  const { key: _key, ...rest } = e
  return rest
}

const order = (a: RegistryEntry, b: RegistryEntry) => (a.slot ?? 1000) - (b.slot ?? 1000) || a.port - b.port
const facts = (e: RegistryEntry) => JSON.stringify([e.instance, e.state, e.origin, e.pid, e.name, e.version, e.root, e.features, e.ws, e.slot, e.port])

type Read = { entry: RegistryEntry; alive: boolean } | { skip: string; mtime: number }

let current: Registry | null = null
/** The app's registry - the last one created and not stopped - for the proof and the bridge. */
export const appRegistry = (): Registry | null => current

export function createRegistry(opts: RegistryOptions = {}): Registry {
  const dir = opts.dir ?? join(marverHome(), 'running')
  const alive = opts.alive ?? pidAlive
  const log = opts.log ?? ((line: string) => { process.stderr.write(`marver-app: ${line}\n`) })
  const uid = process.getuid?.() ?? -1
  const listeners = new Set<(e: RegistryEvent) => void>()
  /** the listed entries: live `starting` and `ready` ones, by file */
  let live = new Map<string, RegistryEntry>()
  const said = new Map<string, string>()
  let watcher: FSWatcher | null = null
  let tick: NodeJS.Timeout | null = null
  let debounce: NodeJS.Timeout | null = null
  let stopped = false
  let running: Promise<void> | null = null
  let again = false

  const tell = (e: RegistryEvent) => {
    for (const fn of [...listeners]) {
      try { fn(e) } catch (err) { log(`registry: a listener threw: ${(err as Error).message}`) }
    }
  }
  const once = (key: string, line: string) => { if (said.get(key) !== line) { said.set(key, line); log(line) } }

  async function readOne(name: string): Promise<Read | null> {
    const path = join(dir, name)
    let st
    try { st = await lstat(path) } catch { return null }
    const mtime = st.mtimeMs
    if (!st.isFile() || st.isSymbolicLink()) return { skip: 'not a regular file', mtime }
    let fh
    try { fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return null }
    try {
      const fst = await fh.stat()
      if (fst.ino !== st.ino || fst.dev !== st.dev) return null   // replaced between the two looks: the next read decides
      const f: FileFacts = { uid: fst.uid, mode: fst.mode, isFile: fst.isFile(), isSymlink: false, size: fst.size }
      let raw = ''
      if (f.size <= MAX_FILE) {
        const buf = Buffer.alloc(MAX_FILE + 1)
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
        if (bytesRead > MAX_FILE) f.size = bytesRead
        raw = buf.subarray(0, bytesRead).toString('utf8')
      }
      const p = parseEntry(name, f, raw, { uid, slotBase: slotBase() })
      if (!p.ok) return { skip: p.why, mtime }
      return { entry: p.entry, alive: alive(p.entry.pid) }
    } catch { return null } finally { await fh.close().catch(() => {}) }
  }

  async function scanOnce(): Promise<void> {
    const found = new Map<string, Read>()
    try {
      const d = await lstat(dir)
      if (!d.isDirectory() || d.isSymbolicLink()) throw new Error('not a folder')
      if (d.uid !== uid) throw new Error('owned by another user')
      if ((d.mode & 0o022) !== 0) throw new Error('writable by others')
      said.delete(dir)
      const names = (await readdir(dir)).filter((n) => NAME.test(n))
      const reads = await Promise.all(names.map(async (n) => [n, await readOne(n)] as const))
      for (const [n, r] of reads) if (r) found.set(n, r)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') once(dir, `registry: ${dir} is not read: ${(err as Error).message}`)
    }
    if (stopped) return
    for (const [n, r] of found) {
      if ('skip' in r) once(n, `registry: ${n} skipped: ${r.skip}`)
      else said.delete(n)
    }
    const next = new Map<string, RegistryEntry>()
    const gone: RegistryEvent[] = []
    for (const [n, r] of found) {
      if (!('entry' in r) || !r.alive) continue
      if (r.entry.state === 'closing') continue
      next.set(n, r.entry)
    }
    for (const [file, was] of live) {
      const now = found.get(file)
      const same = now && 'entry' in now && now.entry.instance === was.instance ? now : null
      if (same && next.get(file)?.instance === was.instance) continue
      const why = same && !same.alive ? 'pid' : same && same.entry.state === 'closing' ? 'closing' : 'removed'
      gone.push({ kind: 'gone', file, instance: was.instance, why })
    }
    const told: RegistryEvent[] = []
    for (const [file, e] of next) {
      const was = live.get(file)
      if (!was || facts(was) !== facts(e)) told.push({ kind: 'entry', entry: e })
    }
    live = next
    for (const e of gone) tell(e)
    for (const e of told) tell(e)
  }

  /** One scan at a time; asked during one, it runs once more after it, and every caller waits for that. */
  function scan(): Promise<void> {
    if (running) { again = true; return running }
    running = (async () => {
      try {
        do { again = false; await scanOnce() } while (again && !stopped)
      } finally { running = null }
    })()
    return running
  }

  function ensureWatch() {
    if (watcher || stopped) return
    try {
      watcher = watch(dir, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => { debounce = null; void scan() }, T.watchDebounceMs)
      })
      watcher.on('error', () => { watcher?.close(); watcher = null })
    } catch { watcher = null }   // the folder went: the tick tries again
  }

  const reg: Registry = {
    async start() {
      stopped = false
      try { await mkdir(dir, { recursive: true, mode: 0o700 }) } catch (err) { log(`registry: ${dir} cannot be made: ${(err as Error).message}`) }
      await scan()
      ensureWatch()
      if (!tick) {
        tick = setInterval(() => { ensureWatch(); void scan() }, T.reconcileMs)
        tick.unref()
      }
    },
    stop() {
      stopped = true
      if (tick) clearInterval(tick)
      if (debounce) clearTimeout(debounce)
      tick = debounce = null
      watcher?.close()
      watcher = null
      listeners.clear()
      if (current === reg) current = null
    },
    entries: () => [...live.values()].sort(order),
    byPort: (port) => [...live.values()].find((e) => e.port === port),
    byInstance: (instance) => [...live.values()].find((e) => e.instance === instance),
    reread: () => scan(),
    on(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  current = reg
  return reg
}
