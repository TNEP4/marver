/**
 * The logos Home keeps (spec 31 E2, E3), in `<state>/logos/` (700, each file 600):
 * - `ws-<workspace>.<png|ico|svg>`: a local canvas's logo, as the app proved and fetched it for its tab (proof.ts
 *   `fetchLogo`'s rules: no redirect, 256 KB, sniffed) - so its Recently here card keeps it once it stops;
 * - `site-<sha16(origin)>.<ext>`: a shared canvas's logo, read with its name through the remote tab's own session
 *   (views.ts `siteMeta`: `meta.json` alone, no redirect, 64 KB, the logo same-origin and sniffed) - kept only on success.
 * Every file is sniffed again when read; one that is not a logo (or too big) is as if absent. Pure of Electron.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOGO_MAX, LOGO_MIME, sniffLogo, type LogoType } from '../../../src/shared/logo-sniff.ts'
import { writeWhole } from './fsx.ts'

const KEY = /^(?:ws|site)-[0-9a-f]{16}$/
const TYPES: readonly LogoType[] = ['png', 'ico', 'svg']

export const wsKey = (ws: string): string | null => (/^[0-9a-f]{16}$/.test(ws) ? `ws-${ws}` : null)
export const siteKey = (origin: string): string => `site-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`

/** A checked `data:` URL's bytes and type, or null (pure). */
export function fromDataUrl(url: unknown): { type: LogoType; bytes: Buffer } | null {
  if (typeof url !== 'string' || url.length > LOGO_MAX * 2) return null
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url)
  if (!m) return null
  const bytes = Buffer.from(m[2]!, 'base64')
  if (!bytes.length || bytes.length > LOGO_MAX) return null
  const type = sniffLogo(bytes)
  return type && LOGO_MIME[type] === m[1] ? { type, bytes } : null
}

export const toDataUrl = (type: LogoType, bytes: Buffer): string => `data:${LOGO_MIME[type]};base64,${bytes.toString('base64')}`

export interface LogoStore {
  /** a logo proved and fetched: kept (written once whole), the key's other types removed */
  keep(key: string, dataUrl: string): void
  /** the kept logo as a `data:` URL, or undefined */
  get(key: string): string | undefined
  /** every kept file whose key is not in `keys` goes (a canvas no longer listed) */
  prune(keys: Iterable<string>): void
}

export function createLogoStore(dir: () => string | undefined): LogoStore {
  const mem = new Map<string, string | null>()
  const folder = () => {
    const d = dir()
    if (!d) return undefined
    try { mkdirSync(d, { recursive: true, mode: 0o700 }); return d } catch { return undefined }
  }
  return {
    keep(key, dataUrl) {
      if (!KEY.test(key)) return
      const l = fromDataUrl(dataUrl)
      if (!l) return
      if (mem.get(key) === dataUrl) return
      mem.set(key, dataUrl)
      const d = folder()
      if (!d) return
      for (const t of TYPES) if (t !== l.type) rmSync(join(d, `${key}.${t}`), { force: true })
      writeWhole(join(d, `${key}.${l.type}`), l.bytes).catch(() => { /* kept in memory for this run */ })
    },
    get(key) {
      if (!KEY.test(key)) return undefined
      if (mem.has(key)) return mem.get(key) ?? undefined
      const d = dir()
      let found: string | null = null
      if (d) {
        for (const t of TYPES) {
          const f = join(d, `${key}.${t}`)
          try {
            const st = statSync(f)
            if (!st.isFile() || st.size > LOGO_MAX) continue
            const bytes = readFileSync(f)
            if (sniffLogo(bytes) === t) { found = toDataUrl(t, bytes); break }
          } catch { /* none of this type */ }
        }
      }
      mem.set(key, found)
      return found ?? undefined
    },
    prune(keys) {
      const keepSet = new Set(keys)
      const d = dir()
      if (!d) return
      let names: string[] = []
      try { names = readdirSync(d) } catch { return }
      for (const n of names) {
        const key = n.replace(/\.(png|ico|svg)$/, '')
        if (KEY.test(key) && !keepSet.has(key)) { rmSync(join(d, n), { force: true }); mem.delete(key) }
      }
    },
  }
}
