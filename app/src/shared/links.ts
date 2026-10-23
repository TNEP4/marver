/**
 * One parser for a canvas link (spec 28 A2.7, v1.10 r1 #4): Home's line under the link field reads it as you
 * type, and main reads it again for `link:open`. Pure; no Electron, no DOM beyond `URL`.
 *
 * A local link is `http:` to `localhost`, `127.0.0.1` or `[::1]` with a port and no credentials - main never loads
 * the host it wrote: it takes the registry entry on that port and builds the address from the entry's bound origin
 * plus the link's path, query and hash (`rest`). An https link is a shared canvas (A4.4). Anything else is not a
 * canvas link. A bare `localhost:4806/#/b/x`, as agents sometimes print it, reads as http.
 */

/** The longest link either side takes (the channels table: under 2 KB). */
export const LINK_MAX = 2048

export type ParsedLink =
  /** `rest` is the path, query and hash; `host` as written, for the words */
  | { kind: 'local'; port: number; rest: string; host: string; board: string | null }
  | { kind: 'https'; url: string; host: string }
  | { kind: 'bad' }

const BAD = { kind: 'bad' } as const
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The board a Marver hash route names (`#/b/<board>`, shell/hash.ts), or null. */
export function boardOf(hash: string): string | null {
  const m = /^#\/b\/([^?/#]+)/.exec(hash)
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

export function parseLink(raw: unknown): ParsedLink {
  if (typeof raw !== 'string') return BAD
  const s = raw.trim()
  if (!s || s.length >= LINK_MAX) return BAD
  if (/[\s\0]/.test(s)) return BAD
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  if (!schemed && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return BAD   // javascript:, mailto:, data: ... (not host:port)
  let u: URL
  try { u = new URL(schemed ? s : `http://${s}`) } catch { return BAD }
  if (u.username || u.password) return BAD
  if (u.protocol === 'https:') return u.hostname ? { kind: 'https', url: u.href, host: u.host } : BAD
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || !u.port) return BAD
  const port = Number(u.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return BAD
  return { kind: 'local', port, rest: `${u.pathname}${u.search}${u.hash}`, host: u.host, board: boardOf(u.hash) }
}
