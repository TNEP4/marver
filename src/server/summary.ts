/**
 * The front door's canvas half (02-home §3, 04-solution §9.1-9.2).
 *
 * Three pieces live here: the canvas identity keypair (generated once onto the
 * volume - the private half never leaves it), the JWS the summary endpoint
 * answers with (origin alone is not a durable identity; possession of the key
 * is what makes a front-door row light up), and the per-user seen marks that
 * make `unread` a real number instead of a bookmark.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './auth.ts'
import type { CommentEvent } from '../shared/events.ts'
import { replay } from '../shared/events.ts'

export interface CanvasIdentity { kid: string; publicJwk: Record<string, string>; privatePem: string }

const idCache = new Map<string, CanvasIdentity>()

/** RFC 7638 thumbprint input: the required EC members, lexicographic, no space. */
const thumbprint = (jwk: Record<string, string>) =>
  createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('hex')

/**
 * The keypair, generated on first boot with a data dir. ES256 (P-256), the
 * same suite the identity service already signs with. Stored as one JSON file
 * at 0600; a half-written file from a crashed boot is regenerated - nothing
 * has pinned a kid the canvas never served.
 */
export function canvasIdentity(dir: string): CanvasIdentity {
  const hit = idCache.get(dir)
  if (hit) return hit
  const file = join(dir, 'identity.json')
  const read = (): CanvasIdentity | null => {
    try {
      const p = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof p?.privatePem !== 'string' || typeof p?.publicJwk?.x !== 'string') return null
      return { kid: thumbprint(p.publicJwk), publicJwk: p.publicJwk, privatePem: p.privatePem }
    } catch { return null }
  }
  const identity = read() ?? withLock(dir, () => {
    const again = read()
    if (again) return again
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, string>
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeSync(fd, JSON.stringify({ publicJwk, privatePem })); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, file)
    return { kid: thumbprint(publicJwk), publicJwk, privatePem }
  }, '.identity.lock')
  idCache.set(dir, identity)
  return identity
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** A compact JWS over `payload`, signed by the canvas identity key. The header
 *  carries the kid, never the key - discovery is `GET /__mv/api/identity`. */
export function signCanvasJws(dir: string, payload: Record<string, unknown>, typ = 'marver-summary+jwt'): string {
  const id = canvasIdentity(dir)
  const head = b64u(JSON.stringify({ alg: 'ES256', typ, kid: id.kid }))
  const body = b64u(JSON.stringify(payload))
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(id.privatePem), dsaEncoding: 'ieee-p1363',
  })
  return `${head}.${body}.${b64u(sig)}`
}

/** The public half, exported for tests that verify the JWS end to end. */
export function canvasPublicKey(dir: string) {
  return createPublicKey({ key: canvasIdentity(dir).publicJwk as any, format: 'jwk' })
}

// ---- seen marks (§9.2) ----
// `<MARVER_DATA_DIR>/seen.json`: { "<emailNorm>": { "<board>": "<eventId>" } }.
// Its own small file, atomic replace, never inside auth.json.

type SeenStore = Record<string, Record<string, string>>

export function loadSeen(dir: string): SeenStore {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
    return typeof p === 'object' && p !== null ? p : {}
  } catch { return {} }
}

export function markSeen(dir: string, emailNorm: string, board: string, eventId: string) {
  withLock(dir, () => {
    const store = loadSeen(dir)
    ;(store[emailNorm] ??= {})[board] = eventId
    const file = join(dir, 'seen.json')
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeSync(fd, JSON.stringify(store)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, file)
  }, '.seen.lock')
}

// ---- thread counters ----
// Maintained, never scanned per probe (02-home §3): the collab handler owns a
// per-board cache built once at boot (boot already reads the logs) and updated
// on every append. Logs are tens to low hundreds of events.

export interface BoardThreads { events: CommentEvent[]; open: Set<string> }

export function deriveThreads(events: CommentEvent[]): BoardThreads {
  const open = new Set(replay(events).filter((t) => !t.resolved).map((t) => t.id))
  return { events, open }
}

/** Unread for one board = open-thread events after the caller's mark; no mark
 *  (or a mark the log no longer holds) = every open-thread event counts. */
export function unreadCount(state: BoardThreads, markId: string | undefined): number {
  const from = markId ? state.events.findIndex((e) => e.id === markId) : -1
  let n = 0
  for (let i = from + 1; i < state.events.length; i++) {
    const e = state.events[i]
    const root = e.type === 'reply' ? e.parentId : e.commentId
    if (root && state.open.has(root)) n++
  }
  return n
}
