/**
 * Two small reads Home makes of a canvas (spec 31 E3, E4), each through the session the canvas's own tab uses, never
 * following a redirect, bounded in time and in bytes, and checked whole before anything is kept:
 * - a running local canvas's `GET /__mv/api/update` (on its partition, `persist:local:<ws>`): `{ current, latest,
 *   checkedAt, state }` - its card says "<latest> available" only when `latest` is strictly newer;
 * - a shared canvas's `GET /meta.json` (on `persist:remote`, so the gate's cookie applies): its `name`, and its `logo`
 *   when that is the repo's logo on the same origin (`/__mv/logo.<svg|png|ico>`), fetched and sniffed like a favicon.
 * Pure parsers here; the fetches take the session's `fetch` as a parameter (Electron's `Session.fetch`, or a test's).
 */
import { LOGO_MAX, sniffLogo } from '../../../src/shared/logo-sniff.ts'
import { newerVersion } from '../../../src/shared/deep-link.ts'
import { readAtMost } from './proof.ts'
import { toDataUrl } from './logos.ts'

export const UPDATE_MAX = 4 * 1024
export const META_MAX = 64 * 1024
export const FETCH_MS = 5_000

type Fetch = (url: string, init: RequestInit) => Promise<Response>
const VERSION = /^\d+\.\d+\.\d+$/

/** The update endpoint's answer (pure): its latest when strictly newer than its current, else null. */
export function updateOf(v: unknown): { current: string; latest: string } | null {
  const r = v as { current?: unknown; latest?: unknown; state?: unknown } | null
  if (!r || typeof r !== 'object' || typeof r.current !== 'string' || typeof r.latest !== 'string') return null
  if (!VERSION.test(r.current) || !VERSION.test(r.latest)) return null
  return newerVersion(r.latest, r.current) ? { current: r.current, latest: r.latest } : null
}

/** `meta.json` (pure): a name (trimmed, 1-120 characters, no control character) and the logo's path on its origin, when it is the repo's. */
export function metaOf(v: unknown): { name: string; logoPath?: string } | null {
  const r = v as { name?: unknown; logo?: unknown } | null
  if (!r || typeof r !== 'object' || typeof r.name !== 'string') return null
  const name = humanName(r.name)
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return null
  const logoPath = typeof r.logo === 'string' && /^\/__mv\/logo\.(svg|png|ico)$/.test(r.logo) ? r.logo : undefined
  return { name, ...(logoPath ? { logoPath } : {}) }
}

/** The canvas's name as its gate and finish page say it (src/server/serve.ts `humanName`): a package name in words. */
export function humanName(raw: string): string | undefined {
  const words = raw.trim().replace(/^@[^/]+\//, '').split(/[-_.\s]+/).filter(Boolean)
  if (!words.length) return undefined
  return words.map((w) => (/[A-Z]/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1))).join(' ')
}

async function getJson(fetch: Fetch, url: string, max: number, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(FETCH_MS), ...(signal ? [signal] : [])]) })
  if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return null }
  const bytes = await readAtMost(res, max)
  if (!bytes) return null
  try { return JSON.parse(bytes.toString('utf8')) } catch { return null }
}

/** A running canvas's update, through its tab's session: `{ current, latest }` when newer, else null (never throws). */
export async function fetchUpdate(fetch: Fetch, origin: string, signal?: AbortSignal): Promise<{ current: string; latest: string } | null> {
  try { return updateOf(await getJson(fetch, `${origin}/__mv/api/update`, UPDATE_MAX, signal)) } catch { return null }
}

/**
 * A shared canvas's name and logo, through the remote session: `meta.json` alone (64 KB), then its logo on the same
 * origin (256 KB, sniffed). Null when the name could not be read - nothing is kept then; a logo that fails is left out.
 */
export async function fetchSite(fetch: Fetch, origin: string, signal?: AbortSignal): Promise<{ name: string; logo?: string } | null> {
  let meta: ReturnType<typeof metaOf>
  try { meta = metaOf(await getJson(fetch, `${origin}/meta.json`, META_MAX, signal)) } catch { return null }
  if (!meta) return null
  if (!meta.logoPath) return { name: meta.name }
  try {
    const res = await fetch(`${origin}${meta.logoPath}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(FETCH_MS), ...(signal ? [signal] : [])]) })
    if (res.status !== 200 || new URL(res.url || `${origin}${meta.logoPath}`).origin !== origin) { await res.body?.cancel().catch(() => {}); return { name: meta.name } }
    const bytes = await readAtMost(res, LOGO_MAX)
    const type = bytes && sniffLogo(bytes)
    return type ? { name: meta.name, logo: toDataUrl(type, bytes!) } : { name: meta.name }
  } catch { return { name: meta.name } }
}
