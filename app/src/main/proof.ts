/**
 * The document proof, per tab (spec 28 A2.3, A2.14 #11). Owner: the trust stream.
 *
 * One dispatcher per local session (Electron keeps one listener per event), on `onBeforeSendHeaders` filtered to
 * `mainFrame` and `script`, and `onHeadersReceived` on `mainFrame`:
 * - any request carrying `Service-Worker: script` is cancelled, whatever it is for and whoever listens (A2.3, S12);
 * - a main-frame request is cancelled unless it is for the tab's canvas - http, a loopback host, the entry's port and,
 *   once ready, its bound origin - and the shell's own document (`/` or `/index.html`, the only paths A1.4 signs);
 *   else it carries a fresh `x-mv-nonce` (24 random bytes) and `x-mv-ws`, and the adapter's generation is stamped;
 * - a redirect authorizes nothing: the next hop is stamped again. A final response must carry `x-mv-instance` and an
 *   `x-mv-proof` equal (timingSafeEqual) to A1's own formula, `docProof(key, nonce, port)`, with the key of a ready
 *   registry entry of that instance, the tab's workspace and port, on the request's origin. An instance the
 *   registry does not hold yet is read again once before failing (A2.14 #11): the page's own reload after a restart
 *   often beats the new slot file. `x-mv-elsewhere: 1` fails as `elsewhere` (another workspace holds the port).
 *   Anything else is cancelled (`ERR_BLOCKED_BY_CLIENT`) and the adapter told why: no document commits on a local
 *   partition without a proof.
 * The proof only makes a result pending: trust is decided at the commit by the adapter (nav.ts), and `isTrusted` is
 * "attributed at its commit, nothing lost since, and its instance still the tab's current, live registry instance".
 *
 * `fetchLogo` and `probeProof` prove the logo and the address the same way (A2.4, v1.14 r3 #4).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session } from 'electron'
import { docProof, logoProof, NONCE } from '../../../src/server/proof.ts'
import { LOGO_MAX, LOGO_MIME, sniffLogo, type LogoType } from '../../../src/shared/logo-sniff.ts'
import { adapterFor, noHash, setLiveResolver, type FailWhy, type Outcome } from './nav.ts'
import { appRegistry, type RegistryEntry } from './registry.ts'
import { note } from './testing/index.ts'
import { T } from './timings.ts'

export { docProof, NONCE }

/** What the dispatcher needs of the tab a webContents belongs to. */
export interface ProofTarget {
  /** the tab's bound entry - kept while the tab is gone, so the page's own reload can find its new instance */
  entry: RegistryEntry
  /** the adapter's current generation, stamped on each main-frame request */
  gen(): number | null
}

export interface Dispatcher {
  /** a webContents of this session, mapped to its tab's target */
  attach(webContentsId: number, target: () => ProofTarget | undefined): void
  detach(webContentsId: number): void
}

/** The only paths A1.4 signs: the shell is hash-routed, so these are all of it. */
export const SHELL_DOC = /^\/(index\.html)?$/
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

const targets = new Map<number, () => ProofTarget | undefined>()

/** The target of a webContents now, or undefined (a throwing lookup counts as none). */
export function targetOf(webContentsId: number): ProofTarget | undefined {
  try { return targets.get(webContentsId)?.() } catch { return undefined }
}

/**
 * A URL a canvas tab's main frame may load: the shell's own document on the entry's canvas - http, a loopback
 * host, the entry's port, its bound origin once it has one, no credentials (pure).
 */
export function shellDocUrl(raw: string, entry: Pick<RegistryEntry, 'port' | 'origin'>): URL | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' || u.username || u.password || !LOOPBACK.has(u.hostname)) return null
  if (Number(u.port) !== entry.port || !SHELL_DOC.test(u.pathname)) return null
  if (entry.origin && u.origin !== entry.origin) return null
  return u
}

/** Response headers, one value per lowercased name: a name sent twice counts as missing (pure). */
export function oneHeaders(raw: Record<string, string[] | string> | undefined): Record<string, string> {
  const seen = new Map<string, string | null>()
  for (const [k, v] of Object.entries(raw ?? {})) {
    const name = k.toLowerCase()
    const vals = Array.isArray(v) ? v : [v]
    seen.set(name, seen.has(name) || vals.length !== 1 ? null : String(vals[0]))
  }
  const out: Record<string, string> = {}
  for (const [k, v] of seen) if (v !== null) out[k] = v
  return out
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A final response's proof against one entry (pure). */
export function checkProof(input: { headers: Record<string, string>; nonce: string; key: Buffer; port: number; instance: string; kind?: 'doc' | 'logo' }): 'ok' | 'proof' | 'elsewhere' | 'instance' {
  const h = input.headers
  if (h['x-mv-elsewhere'] === '1') return 'elsewhere'
  const got = h['x-mv-proof']
  const inst = h['x-mv-instance']
  if (!got || !inst) return 'proof'
  if (inst !== input.instance) return 'instance'
  const want = (input.kind === 'logo' ? logoProof : docProof)(input.key, input.nonce, input.port)
  return same(got, want) ? 'ok' : 'proof'
}

/** The statuses Chromium follows as redirects. A 304 is not one: passing it would commit a cached copy unproved. */
export const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** A final response Chromium never commits as a document: no content, or a download (pure). */
export const commitsNothing = (status: number, h: Record<string, string>): boolean =>
  status === 204 || status === 205 || /^\s*attachment\b/i.test(h['content-disposition'] ?? '')

/**
 * Why a webContents' preferences break the rules every view keeps (the app's shape, A2.14 #14): sandboxed, isolated,
 * no Node, no webview tags, no dialogs - or null. Electron 45 keeps `getLastWebPreferences()` out of its typings; when
 * it is not there nothing can be told and nothing is refused.
 */
export function unsafePrefs(wc: object | null | undefined): string | null {
  const get = (wc as { getLastWebPreferences?: () => Record<string, unknown> | null } | null | undefined)?.getLastWebPreferences
  if (typeof get !== 'function') return null
  let p: Record<string, unknown> | null
  try { p = get.call(wc) } catch { return null }
  if (!p) return null
  if (p.sandbox !== true) return 'not sandboxed'
  if (p.contextIsolation !== true) return 'no context isolation'
  if (p.nodeIntegration === true || p.nodeIntegrationInSubFrames === true || p.nodeIntegrationInWorker === true) return 'Node in its pages'
  if (p.webviewTag === true) return 'webview tags'
  if (p.disableDialogs !== true) return 'dialogs not disabled'
  return null
}

const isSwScript = (h: Record<string, string>) => Object.entries(h).some(([k, v]) => k.toLowerCase() === 'service-worker' && String(v).toLowerCase() === 'script')

interface Pending { nonce: string; gen: number | null; wcId: number; ws: string; port: number; at: number }
const pending = new Map<number, Pending>()
const prune = () => {
  const old = Date.now() - 120_000
  for (const [id, p] of pending) if (p.at < old) pending.delete(id)
}

/** The registry's ready entry of that instance, for this request's workspace and port. */
function liveEntry(req: Pick<Pending, 'ws' | 'port'>, instance: string): RegistryEntry | undefined {
  const e = appRegistry()?.byInstance(instance)
  return e && e.state === 'ready' && e.ws === req.ws && e.port === req.port ? e : undefined
}
/** Anything of this workspace on this port now, ready or starting. */
const anyLive = (req: Pick<Pending, 'ws' | 'port'>) => !!appRegistry()?.entries().some((e) => e.ws === req.ws && e.port === req.port)

/** Is `instance` still the tab's current, live registry instance? (the adapter's commit rule, and isTrusted) */
export function liveFor(webContentsId: number, instance: string): boolean {
  const t = targetOf(webContentsId)
  if (!t || t.entry.instance !== instance) return false
  const e = appRegistry()?.byInstance(instance)
  return !!e && e.state === 'ready' && e.ws === t.entry.ws
}
setLiveResolver(liveFor)

/** Trusted at its commit, and its instance is still the tab's current, live registry instance (A2.14 #8). */
export function isTrusted(webContentsId: number): boolean {
  const c = adapterFor(webContentsId)?.committed()
  if (!c || !c.attributed || c.lost || !c.instance) return false
  return liveFor(webContentsId, c.instance)
}

function beforeSend(d: OnBeforeSendHeadersListenerDetails, cb: (r: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void, allowSw = false): void {
  if (!allowSw && isSwScript(d.requestHeaders)) {
    if (__MV_TEST__) note('proof', { wc: d.webContentsId, event: 'service-worker-refused', url: d.url })
    return cb({ cancel: true })
  }
  if (d.resourceType !== 'mainFrame') return cb({})
  const id = d.webContentsId
  const t = id === undefined ? undefined : targetOf(id)
  let gen: number | null = null
  if (t && id !== undefined) { try { gen = t.gen() } catch { gen = adapterFor(id)?.stamp() ?? null } }
  const fail = (why: FailWhy) => {
    if (__MV_TEST__) note('proof', { wc: id, event: 'request-refused', why, url: d.url, gen })
    if (id !== undefined && gen !== null) adapterFor(id)?.response(gen, { kind: 'failed', why })
    cb({ cancel: true })
  }
  if (!t || id === undefined) return fail('gone')
  if (!shellDocUrl(d.url, t.entry) || unsafePrefs(d.webContents)) return fail('unverified')
  const nonce = randomBytes(24).toString('base64url')
  prune()
  pending.set(d.id, { nonce, gen, wcId: id, ws: t.entry.ws, port: t.entry.port, at: Date.now() })
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.requestHeaders)) if (!/^x-mv-(nonce|ws)$/i.test(k)) headers[k] = v
  if (__MV_TEST__) note('proof', { wc: id, event: 'stamped', url: d.url, gen })
  cb({ requestHeaders: { ...headers, 'x-mv-nonce': nonce, 'x-mv-ws': t.entry.ws } })
}

async function headersReceived(d: OnHeadersReceivedListenerDetails): Promise<{ cancel?: boolean }> {
  const req = pending.get(d.id)
  if (!req) return { cancel: true }   // a main-frame response to a request we never stamped
  if (REDIRECTS.has(d.statusCode)) return {}   // a redirect authorizes nothing; the next hop is stamped again
  pending.delete(d.id)
  const report = (o: Outcome) => {
    if (__MV_TEST__) note('proof', { wc: req.wcId, event: 'outcome', gen: req.gen, outcome: o, status: d.statusCode })
    if (req.gen !== null) adapterFor(req.wcId)?.response(req.gen, o)
  }
  const fail = (why: FailWhy) => { report({ kind: 'failed', why }); return { cancel: true } }
  const h = oneHeaders(d.responseHeaders)
  if (commitsNothing(d.statusCode, h)) {
    // a 204, a 205 or a download commits no document: the navigation ends with no commit (an abort, A2.14 #8),
    // and the document shown keeps its trust. Cancelling it would put an error page in its place
    if (__MV_TEST__) note('proof', { wc: req.wcId, event: 'commits-nothing', gen: req.gen, status: d.statusCode })
    return {}
  }
  if (h['x-mv-elsewhere'] === '1') return fail('elsewhere')
  const inst = h['x-mv-instance']
  if (!inst || !h['x-mv-proof']) return fail('unverified')
  let entry = liveEntry(req, inst)
  if (!entry) {
    // once: the page's own reload after a restart can beat the new slot file (A2.14 #11)
    if (__MV_TEST__) note('proof', { wc: req.wcId, event: 'reread', instance: inst })
    await appRegistry()?.reread()
    entry = liveEntry(req, inst)
  }
  if (!entry) return fail(anyLive(req) ? 'unverified' : 'gone')
  const u = shellDocUrl(d.url, entry)
  if (!u) return fail('unverified')
  const r = checkProof({ headers: h, nonce: req.nonce, key: entry.key, port: entry.port, instance: entry.instance })
  if (r !== 'ok') return fail(r === 'elsewhere' ? 'elsewhere' : 'unverified')
  report({ kind: 'proved', url: noHash(d.url), instance: entry.instance })
  return {}
}

const dispatchers = new WeakMap<Session, Dispatcher>()

/**
 * Installs the one dispatcher of a local session (`persist:local:<ws>`); a second call gives the same one.
 * `allowServiceWorkers` is a test build's planted-worker run alone (sessions.ts): never in the app.
 */
export function installDispatcher(ses: Session, opts: { allowServiceWorkers?: boolean } = {}): Dispatcher {
  const had = dispatchers.get(ses)
  if (had) return had
  const allowSw = __MV_TEST__ && opts.allowServiceWorkers === true
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'], types: ['mainFrame', 'script'] }, (d, cb) => beforeSend(d, cb, allowSw))
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame'] }, (d, cb) => {
    headersReceived(d).then(cb, () => cb({ cancel: true }))
  })
  const dispatcher: Dispatcher = {
    attach: (id, target) => { targets.set(id, target) },
    detach: (id) => { targets.delete(id) },
  }
  dispatchers.set(ses, dispatcher)
  return dispatcher
}

/** A logo proved like the document (A2.4): its bytes, its type by the sniff, and the `data:` URL the pages show. */
export interface Logo { type: LogoType; bytes: Buffer; dataUrl: string }

/**
 * `GET <origin>/__mv/logo` with a fresh nonce: a 200 whose `x-mv-instance` is the entry's and whose `x-mv-proof` is
 * `logoProof(key, nonce, port)`, at most 256 KB actually received (the stream is cut past it), sniffed as a PNG, an
 * ICO or an SVG, within 5 s; anything else is null and the tab wears its initials. No redirect is followed. The
 * caller passes `signal` to abort it when a newer fetch starts or the tab navigates or closes, and applies a result
 * only if the tab, its instance and its navigation count are unchanged (A2.4).
 */
export async function fetchLogo(entry: RegistryEntry, signal?: AbortSignal): Promise<Logo | null> {
  if (entry.state !== 'ready' || !entry.origin) return null
  const nonce = randomBytes(24).toString('base64url')
  const abort = AbortSignal.any([AbortSignal.timeout(T.logoDeadlineMs), ...(signal ? [signal] : [])])
  try {
    const res = await fetch(`${entry.origin}/__mv/logo`, { headers: { 'x-mv-nonce': nonce, 'x-mv-ws': entry.ws }, redirect: 'error', signal: abort, cache: 'no-store' })
    const h = oneHeaders(Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k, [v]])))
    if (res.status !== 200 || checkProof({ headers: h, nonce, key: entry.key, port: entry.port, instance: entry.instance, kind: 'logo' }) !== 'ok') {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const bytes = await readAtMost(res, LOGO_MAX)
    if (!bytes) return null
    const type = sniffLogo(bytes)
    if (!type) return null
    return { type, bytes, dataUrl: `data:${LOGO_MIME[type]};base64,${bytes.toString('base64')}` }
  } catch { return null }
}

/** The body, or null once more than `max` bytes have actually arrived (Content-Length is not trusted). */
async function readAtMost(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { await reader.cancel().catch(() => {}); return null }
    parts.push(value)
  }
  return Buffer.concat(parts)
}

/**
 * What answers on a failed tab's address now (v1.14 r3 #4): `proved` when a GET of the shell's document carries the
 * entry's proof, `answers` for any other HTTP answer, `silent` for none within the HEAD's timeout. The body is
 * dropped unread; no redirect is followed.
 */
export async function probeProof(entry: RegistryEntry, signal?: AbortSignal): Promise<'proved' | 'answers' | 'silent'> {
  if (entry.state !== 'ready' || !entry.origin) return 'silent'
  const nonce = randomBytes(24).toString('base64url')
  const abort = AbortSignal.any([AbortSignal.timeout(T.headTimeoutMs), ...(signal ? [signal] : [])])
  try {
    const res = await fetch(`${entry.origin}/`, { headers: { 'x-mv-nonce': nonce, 'x-mv-ws': entry.ws }, redirect: 'manual', signal: abort, cache: 'no-store' })
    await res.body?.cancel().catch(() => {})
    const h = oneHeaders(Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k, [v]])))
    return res.status === 200 && checkProof({ headers: h, nonce, key: entry.key, port: entry.port, instance: entry.instance }) === 'ok' ? 'proved' : 'answers'
  } catch { return 'silent' }
}
