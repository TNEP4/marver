/**
 * Update discovery - dev only, and deliberately boring about privacy: one anonymous
 * registry metadata GET per day (the same request `npm view` makes), cached in
 * design/.local/, nothing sent beyond the request itself. Offline, slow, or
 * firewalled registries degrade to silence. MARVER_NO_UPDATE_CHECK=1 disables it.
 * Published bundles never check anything - viewers are not the owner.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PKG } from '../cli/name.ts'
import { newerVersion } from '../shared/deep-link.ts'

const TTL = 24 * 3600 * 1000

/** Installed version: walk up from this module to the package's own package.json
 *  (one level from dist/, two from src/server/ - the walk covers both). */
export function installedVersion(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === PKG) return pkg.version
    } catch { /* keep walking */ }
    dir = dirname(dir)
  }
  return null
}

/** Strictly-newer numeric compare; anything non-numeric (prerelease tags) compares false. */
const newer = (a: string, b: string): boolean => newerVersion(a, b)

/** The latest published version when strictly newer than installed, else null. Never throws. */
export async function checkUpdate(root: string): Promise<string | null> {
  if (process.env.MARVER_NO_UPDATE_CHECK) return null
  const current = installedVersion()
  if (!current) return null
  const { latest } = await latestVersion(root)
  return latest && newer(latest, current) ? latest : null
}

/**
 * What `GET /__mv/api/update` answers (spec 31 E4) - always, current or not: the installed version, the registry's
 * latest (null when never read), when it was last asked, and `state`: `ok` (the registry answered), `offline` (the
 * last ask failed), `disabled` (MARVER_NO_UPDATE_CHECK). Each request reads the cache and asks the registry again
 * only once the day's TTL has passed - the same one anonymous GET a day as before.
 */
export interface UpdateStatus { current: string | null; latest: string | null; checkedAt: number | null; state: 'ok' | 'offline' | 'disabled' }
export async function updateStatus(root: string): Promise<UpdateStatus> {
  const current = installedVersion()
  if (process.env.MARVER_NO_UPDATE_CHECK) return { current, latest: null, checkedAt: null, state: 'disabled' }
  const r = await latestVersion(root)
  return { current, latest: r.latest, checkedAt: r.checkedAt, state: r.ok ? 'ok' : 'offline' }
}

/** One registry read at a time per root: requests that come together share it. */
const asking = new Map<string, Promise<{ latest: string | null; checkedAt: number; ok: boolean }>>()

function latestVersion(root: string): Promise<{ latest: string | null; checkedAt: number; ok: boolean }> {
  const cacheFile = join(root, 'design', '.local', 'update-check.json')
  // only plain x.y.z ever reaches the terminal or the UI - registry data is input
  const wellFormed = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
    const age = Date.now() - c.checkedAt
    if (typeof c.checkedAt === 'number' && age >= 0 && age < TTL)   // a future stamp is corruption, not freshness
      // a cache from before 0.31 says nothing of a failure: a latest it holds was an answer, none was a failure
      return Promise.resolve({ latest: wellFormed(c.latest) ? c.latest : null, checkedAt: c.checkedAt, ok: typeof c.ok === 'boolean' ? c.ok : wellFormed(c.latest) })
  } catch { /* no fresh cache - ask the registry */ }
  const had = asking.get(root)
  if (had) return had
  const p = (async () => {
    let latest: string | null = null
    let ok = false
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG)}/latest`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const v = (await res.json())?.version
        if (wellFormed(v)) { latest = v; ok = true }
      }
    } catch { /* offline or slow - stay silent, the cache write below spaces retries */ }
    const checkedAt = Date.now()
    try {
      mkdirSync(join(root, 'design', '.local'), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({ checkedAt, latest, ok }) + '\n')
    } catch { /* read-only fs - checks just repeat, still capped by the request timeout */ }
    return { latest, checkedAt, ok }
  })().finally(() => asking.delete(root))
  asking.set(root, p)
  return p
}
