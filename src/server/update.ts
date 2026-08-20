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
const newer = (a: string, b: string): boolean => {
  const pa = a.split('.').map((n) => parseInt(n, 10))
  const pb = b.split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x !== y) return x > y
  }
  return false
}

/** The latest published version when strictly newer than installed, else null. Never throws. */
export async function checkUpdate(root: string): Promise<string | null> {
  if (process.env.MARVER_NO_UPDATE_CHECK) return null
  const current = installedVersion()
  if (!current) return null
  const latest = await latestVersion(root)
  return latest && newer(latest, current) ? latest : null
}

async function latestVersion(root: string): Promise<string | null> {
  const cacheFile = join(root, 'design', '.local', 'update-check.json')
  // only plain x.y.z ever reaches the terminal or the UI - registry data is input
  const wellFormed = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
    const age = Date.now() - c.checkedAt
    if (typeof c.checkedAt === 'number' && age >= 0 && age < TTL)   // a future stamp is corruption, not freshness
      return wellFormed(c.latest) ? c.latest : null
  } catch { /* no fresh cache - ask the registry */ }
  let latest: string | null = null
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG)}/latest`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const v = (await res.json())?.version
      if (wellFormed(v)) latest = v
    }
  } catch { /* offline or slow - stay silent, the cache write below spaces retries */ }
  try {
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latest }) + '\n')
  } catch { /* read-only fs - checks just repeat, still capped by the request timeout */ }
  return latest
}
