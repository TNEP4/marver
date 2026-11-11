/**
 * One parser for a canvas link (spec 28 A2.7, v1.10 r1 #4): Home's line under the link field reads it as you
 * type, and main reads it again for `link:open`. Pure; no Electron, no DOM beyond `URL`.
 *
 * A local link is `http:` to `localhost`, `127.0.0.1` or `[::1]` with a port and no credentials - main never loads
 * the host it wrote: it takes the registry entry on that port and builds the address from the entry's bound origin
 * plus the link's path, query and hash (`rest`). Only the canvas's own page opens in its tab: `rest` must be the shell's
 * document, `/` or `/index.html` with its query and hash - the only documents the proof admits (A2.14 #11) - so a
 * link to a frame's file or an API on a canvas's port is not a canvas link (`why: 'page'`), and both sides say so
 * before anything loads. An https link is a shared canvas (A4.4, A4.6 #39): a hostname, no credentials, under 2 KB,
 * and never a loopback host - a shared canvas is someone else's server, and a loopback page in a shared tab would
 * be a local listener wearing no proof. Anything else is not a canvas link. A bare `localhost:4806/#/b/x`, as agents
 * sometimes print it, reads as http; a bare non-loopback host (`pilot.example.com/#/b/x`) reads as https.
 *
 * A shared canvas's tab keeps where it returns (`remoteStart`, `shellDestination`; A4.6 r1 #9): the opening link,
 * moved only to a later page of the shell on the tab's own origin - never to a sign-in route or another site.
 *
 * Spec 32 D3: a `marver:` link (`marver://open?ws=...`, what Home's Copy link writes for a stopped canvas) is `deep`
 * when `parseDeepLink` (src/shared/deep-link.ts, pure, so the page bundles it) accepts it, else `bad`.
 */

import { parseDeepLink } from '../../../src/shared/deep-link.ts'

/** The longest link either side takes (the channels table: under 2 KB). */
export const LINK_MAX = 2048

export type ParsedLink =
   /** `rest` is the path, query and hash (always the shell's own document); `host` as written, for the words */
  | { kind: 'local'; port: number; rest: string; host: string; board: string | null }
  | { kind: 'https'; url: string; host: string }
  /**
   * spec 32 D3: a `marver:` link `parseDeepLink` accepts (what Copy link writes for a stopped canvas), as typed; main
   * hands it to its deep-link handler, which checks it again. `ws` the folder it names, for the words
   */
  | { kind: 'deep'; url: string; ws: string }
  /** `page`: a loopback link with a port whose path is not the canvas's own page */
  | { kind: 'bad'; why?: 'page'; port?: number }

const BAD = { kind: 'bad' } as const

/** The shell's own document only - `/` or `/index.html`, its query and hash - under 2 KB; anything else is `/`. */
export const shellPath = (p: unknown): string =>
  typeof p === 'string' && p.length < LINK_MAX && /^\/(index\.html)?([?#][^\0]*)?$/.test(p) ? p : '/'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A host no shared canvas may have (A4.6 #39): `localhost` and `*.localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0` - and
 * their spellings `URL` normalises to (`127.1`, `[0:0::1]`), the unspecified `[::]` and IPv4-mapped loopback. Takes a
 * `URL`'s `hostname` (an IPv6 one in brackets).
 */
export function loopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return h === '[::1]' || h === '[::]' || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(h)
}

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
  // spec 32 D3: a `marver:` link is a deep link or nothing - never read as a host
  if (/^marver:/i.test(s)) {
    const d = parseDeepLink(s)
    return d ? { kind: 'deep', url: s, ws: d.ws } : BAD
  }
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  if (!schemed && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return BAD   // javascript:, mailto:, data: ... (not host:port)
  let u: URL
  try { u = new URL(schemed ? s : `http://${s}`) } catch { return BAD }
  // a bare host that is not loopback is a shared canvas's (A4.6 #39) - a dotted name or an address, never one word
  if (!schemed && !loopbackHost(u.hostname) && (u.hostname.includes('.') || u.hostname.startsWith('['))) {
    try { u = new URL(`https://${s}`) } catch { return BAD }
  }
  if (u.username || u.password) return BAD
  if (u.protocol === 'https:') return u.hostname && !loopbackHost(u.hostname) && u.href.length < LINK_MAX ? { kind: 'https', url: u.href, host: u.host } : BAD
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || !u.port) return BAD
  const port = Number(u.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return BAD
  const rest = `${u.pathname}${u.search}${u.hash}`
  if (rest.length >= LINK_MAX) return BAD
  if (shellPath(rest) !== rest) return { kind: 'bad', why: 'page', port }
  return { kind: 'local', port, rest, host: u.host, board: boardOf(u.hash) }
}

/**
 * Where a shared canvas's tab starts (A4.6 #39, r1 #9): its opening link as `parseLink` gave it - or, when its path is
 * under `/__mv/` (a sign-in route, an API), its origin and `/`, so the tab never holds a sign-in URL.
 */
export function remoteStart(url: string): string {
  const u = new URL(url)
  return /^\/__mv(\/|$)/.test(u.pathname) ? `${u.origin}/` : u.href
}

/**
 * A shell destination of a shared canvas (A4.6 r1 #9): a URL on the tab's own `origin` whose path, query and hash
 * `shellPath` keeps unchanged - `/` or `/index.html` and its query and hash. A sign-in route (`/__mv/id/start`,
 * `/__mv/id/finish#...`), another page of the site and another origin are not: the tab's place never moves to them.
 */
export function shellDestination(origin: string, href: string): boolean {
  let u: URL
  try { u = new URL(href) } catch { return false }
  if (u.origin !== origin || u.username || u.password) return false
  const rest = `${u.pathname}${u.search}${u.hash}`
  return shellPath(rest) === rest
}

/**
 * A shared canvas's favicon may be fetched (A4.6 #46): an https URL with no credentials on the tab's own `origin`,
 * while the committed document (`committed`) is on that origin too - so a sign-in host's icon (`id.marver.design`,
 * Google) never becomes the canvas's, and no favicon names another site.
 */
export function remoteFavicon(url: unknown, origin: string, committed: string): boolean {
  if (typeof url !== 'string' || url.length >= LINK_MAX) return false
  let u: URL
  let d: URL
  try { u = new URL(url); d = new URL(committed) } catch { return false }
  return u.protocol === 'https:' && !u.username && !u.password && u.origin === origin && d.origin === origin
}

/** The repo's logo as a published shell and gate list it (src/server/logo.ts `logoIconLink`). */
const MV_LOGO = /^\/__mv\/logo\.(svg|png|ico)$/

/**
 * Which of a page's favicons a shared tab wears (A4.6 #46): of those `remoteFavicon` takes, the repo's logo on the
 * tab's origin, else the first. Not the page's first: Electron 45's `page-favicon-updated` hands a sorted,
 * de-duplicated set (a `base::flat_set<GURL>`), so a published canvas's `/__mv/favicon/favicon-16x16.png` comes before
 * the `/__mv/logo.svg` its page lists first.
 */
export function remoteFaviconPick(urls: unknown, origin: string, committed: string): string | undefined {
  if (!Array.isArray(urls)) return undefined
  const ok = urls.filter((u): u is string => remoteFavicon(u, origin, committed))
  return ok.find((u) => MV_LOGO.test(new URL(u).pathname)) ?? ok[0]
}
