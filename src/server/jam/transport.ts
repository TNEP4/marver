/**
 * The session's commands travel through files, not a port (spec 29b, Part 6): Codex's and Cursor's
 * sandboxes can block localhost, and a file in the repo reaches the daemon from any of them.
 *
 * The CLI writes design/.local/jam/req/<id>.json - the connection, the operation, its arguments, the
 * time, and an HMAC-SHA256 over all of it made with the connection's key. The daemon checks the MAC,
 * the age and that the id is new, does the operation, and answers design/.local/jam/res/<id>.json.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { jamDir, readConn, validConnId, writeAtomic, type Conn } from './conn.ts'

export const reqDir = (root: string) => join(jamDir(root), 'req')
export const resDir = (root: string) => join(jamDir(root), 'res')

/** A request older than this is refused (its clock, or a replay). */
export const REQ_MAX_AGE_MS = 60_000
/** Requests and answers older than this are swept. */
const KEEP_MS = 10 * 60_000
const REQ_ID = /^[0-9a-f-]{36}$/

export type Op = 'next' | 'say' | 'progress' | 'done' | 'release' | 'status' | 'mute' | 'own'
export const OPS: Op[] = ['next', 'say', 'progress', 'done', 'release', 'status', 'mute', 'own']

export interface Req { v: 1; id: string; conn: string; op: Op; args: Record<string, unknown>; ts: number; mac: string }

/** JSON with its keys in order, at every depth: the bytes a MAC is made over. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export const macOf = (key: string, body: Omit<Req, 'mac'>): string => createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(body)).digest('hex')

/** Write a request and wait for its answer. Throws with a sentence a person can act on. */
export async function request(root: string, conn: Conn, op: Op, args: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  mkdirSync(reqDir(root), { recursive: true, mode: 0o700 })
  mkdirSync(resDir(root), { recursive: true, mode: 0o700 })
  const body: Omit<Req, 'mac'> = { v: 1, id: randomUUID(), conn: conn.id, op, args, ts: Date.now() }
  const req: Req = { ...body, mac: macOf(conn.key, body) }
  const res = join(resDir(root), `${req.id}.json`)
  writeAtomic(join(reqDir(root), `${req.id}.json`), JSON.stringify(req))
  return await new Promise((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => { if (done) return; done = true; clearInterval(poll); clearTimeout(to); clearTimeout(again); try { w?.close() } catch { /* gone */ } fn() }
    const look = () => {
      let text: string
      try { text = readFileSync(res, 'utf8') } catch { return }
      let out: Record<string, unknown>
      try { out = JSON.parse(text) } catch { return }   // half written cannot happen (atomic), but never trust it
      rmSync(res, { force: true })
      finish(() => resolve(out))
    }
    let w: ReturnType<typeof watch> | undefined
    try { w = watch(resDir(root), { persistent: false }, look) } catch { /* the poll is enough */ }
    const poll = setInterval(look, 200)
    // no answer by half time: the same request once more (same id, same signature) - a daemon that took it and
    // restarted before answering finds its receipt and answers what it answered the first time
    const again = setTimeout(() => { if (!done && Date.now() - body.ts < REQ_MAX_AGE_MS - 5_000) try { writeAtomic(join(reqDir(root), `${req.id}.json`), JSON.stringify(req)) } catch { /* the wait goes on */ } }, Math.min(timeoutMs / 2, 20_000))
    const to = setTimeout(() => finish(() => {
      rmSync(join(reqDir(root), `${req.id}.json`), { force: true })
      reject(new Error('the canvas did not answer - is `marver dev` running in this repo?'))
    }), timeoutMs)
    look()
    void again
  })
}

/** Check one request file: a known, live connection, a MAC made with its key, recent, never seen. */
export function verify(root: string, raw: unknown, seen: Set<string>, now = Date.now()): { ok: true; req: Req; conn: Conn } | { ok: false; id?: string; error: string } {
  const r = raw as Partial<Req> | null
  const id = typeof r?.id === 'string' && REQ_ID.test(r.id) ? r.id : undefined
  if (!r || r.v !== 1 || !id || !validConnId(r.conn) || !OPS.includes(r.op as Op) || !r.args || typeof r.args !== 'object' || typeof r.ts !== 'number' || typeof r.mac !== 'string') return { ok: false, id, error: 'not a Jam request' }
  const conn = readConn(root, r.conn)
  if (!conn) return { ok: false, id, error: 'this session is not connected to the canvas' }
  const want = Buffer.from(macOf(conn.key, { v: 1, id, conn: r.conn, op: r.op as Op, args: r.args, ts: r.ts }), 'hex')
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(r.mac) ? r.mac : '', 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, id, error: 'the request is not signed by this session' }
  if (Math.abs(now - r.ts) > REQ_MAX_AGE_MS) return { ok: false, id, error: 'the request is too old - run the command again' }
  if (seen.has(id)) return { ok: false, id, error: 'this request was already answered' }
  seen.add(id)
  return { ok: true, req: r as Req, conn }
}

export function answer(root: string, id: string, body: Record<string, unknown>): void {
  if (!REQ_ID.test(id)) return
  mkdirSync(resDir(root), { recursive: true, mode: 0o700 })
  writeAtomic(join(resDir(root), `${id}.json`), JSON.stringify(body))
}

/** The requests waiting now, oldest first - each read and removed (a request is taken once). */
export function takeRequests(root: string): { file: string; raw: unknown }[] {
  let names: string[]
  try { names = readdirSync(reqDir(root)).filter((n) => n.endsWith('.json')) } catch { return [] }
  const out: { file: string; raw: unknown; t: number }[] = []
  for (const n of names) {
    const file = join(reqDir(root), n)
    let raw: unknown = null
    let t = 0
    try { t = statSync(file).mtimeMs; raw = JSON.parse(readFileSync(file, 'utf8')) } catch { /* half there: a later look */ continue }
    rmSync(file, { force: true })
    out.push({ file, raw, t })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Requests and answers nobody came back for. */
export function sweep(root: string, now = Date.now()): void {
  for (const dir of [reqDir(root), resDir(root)]) {
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      try { if (now - statSync(join(dir, n)).mtimeMs > KEEP_MS) rmSync(join(dir, n), { force: true }) } catch { /* gone */ }
    }
  }
}
