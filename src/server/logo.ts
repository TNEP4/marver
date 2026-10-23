/**
 * The canvas's own logo (spec 28 A2.4, A2.9): one ladder, one set of checks, for `marver build` (which publishes it
 * beside the gate) and for `marver dev`'s `GET /__mv/logo` (which the Mac app shows on the canvas's tab and Home card).
 *
 * The ladder: `share.logo`, `design/logo.svg`, `design/logo.png`, `public/logo.svg`, `public/logo.png`,
 * `public/favicon.svg`, `public/favicon.png`, `public/favicon.ico`. A candidate counts only if `lstat` says it is a
 * regular file (a symlink never counts, even one inside the repo: `design/logo.svg -> ../.env` would otherwise serve
 * the env file), its real path is inside the repo's real path (a symlinked folder on the way out is caught here), its
 * extension is `.svg`, `.png` or `.ico`, it weighs at most 256 KB, and its bytes are one of the three image types
 * (`src/shared/logo-sniff.ts`, the sniff the app runs too). The type served and published comes from the bytes, never
 * the name: a PNG named `.svg` is the PNG it is. A `share.logo` that fails any check is ignored with one warning
 * naming why.
 */
import type { Connect } from 'vite'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ROUTE } from '../cli/name.ts'
import { LOGO_MAX, LOGO_MIME, sniffLogo, type LogoType } from '../shared/logo-sniff.ts'
import { proofHeaders, type DocProof } from './proof.ts'

export const LOGO_LADDER = ['design/logo.svg', 'design/logo.png', 'public/logo.svg', 'public/logo.png', 'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico'] as const

export interface Logo { type: LogoType; bytes: Buffer; from: string }

/** The first candidate that passes every check, read whole; null when none does. `warn` hears why a `share.logo`
 *  was ignored (the ladder's own entries are tried quietly: most repos have none of them). */
export function findLogo(root: string, shareLogo?: string, warn?: (m: string) => void): Logo | null {
  let realRoot: string
  try { realRoot = realpathSync(root) } catch { return null }
  const own = typeof shareLogo === 'string' && shareLogo !== '' ? shareLogo : null
  for (const cand of new Set(own ? [own, ...LOGO_LADDER] : LOGO_LADDER)) {
    const r = readLogo(realRoot, resolve(realRoot, cand))
    if (typeof r !== 'string') return { ...r, from: cand }
    if (cand === own) warn?.(`share.logo ${own} is ignored: ${r}`)
  }
  return null
}

/** One candidate: its bytes and type, or why it does not count. */
function readLogo(realRoot: string, file: string): { type: LogoType; bytes: Buffer } | string {
  let st
  try { st = lstatSync(file) } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'no such file' : 'unreadable' }
  if (st.isSymbolicLink()) return 'a symlink'
  if (!st.isFile()) return 'not a file'
  if (!/\.(svg|png|ico)$/i.test(file)) return 'not .svg, .png or .ico'
  if (st.size > LOGO_MAX) return 'over 256 KB'
  let real: string
  try { real = realpathSync(file) } catch { return 'unreadable' }
  if (!real.startsWith(realRoot + sep)) return 'outside the repo'
  // read what was checked: no symlink swapped in since (O_NOFOLLOW), the same file (device and inode), and never
  // more than one byte past the limit, whatever the file grew to meanwhile
  let fd: number
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { return 'unreadable' }
  try {
    const f = fstatSync(fd)
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev) return 'changed while it was read'
    const buf = Buffer.alloc(LOGO_MAX + 1)
    let n = 0
    for (let k = 1; k > 0 && n < buf.length; n += k) k = readSync(fd, buf, n, buf.length - n, null)
    if (n > LOGO_MAX) return 'over 256 KB'
    const bytes = Buffer.from(buf.subarray(0, n))
    const type = sniffLogo(bytes)
    return type ? { type, bytes } : 'not an image (PNG, ICO or SVG)'
  } catch { return 'unreadable' } finally { closeSync(fd) }
}

/** `marver build`: the logo into `<outDir>/__mv/logo.<type>` (an `.ico` as `logo.ico`), by its bytes - never a copy
 *  that follows a link. Its published path, or undefined when the repo has none. */
export function publishLogo(root: string, shareLogo: string | undefined, outDir: string, warn?: (m: string) => void): string | undefined {
  const logo = findLogo(root, shareLogo, warn)
  if (!logo) return undefined
  const dir = join(outDir, ROUTE.slice(1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `logo.${logo.type}`), logo.bytes)
  return `${ROUTE}/logo.${logo.type}`
}

/** A strong `ETag` for these bytes. */
export const logoTag = (bytes: Uint8Array): string => `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"`

/** Does an `If-None-Match` name this tag (a list, a weak tag, or `*`)? */
function matches(header: string | string[] | undefined, tag: string): boolean {
  if (typeof header !== 'string') return false
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === '*' || t === tag)
}

/**
 * `marver dev`'s `GET|HEAD /__mv/logo`. Read once per request (256 KB at most), checked, and answered with its sniffed
 * type, an `ETag` and `Cache-Control: no-cache`; `x-content-type-options: nosniff` and a CSP that runs nothing, so an
 * SVG opened as a page is a picture. A request carrying a well-formed `x-mv-nonce` gets the logo proof
 * (`x-mv-instance`, `x-mv-proof` over `logo|<nonce>|<port>`), on a 200 and a 304 alike. 404 when the repo has none.
 */
export function logoRoute(root: string, shareLogo: () => string | undefined, proof?: DocProof): Connect.NextHandleFunction {
  const warned = new Set<string>()
  const warn = (m: string) => { if (warned.has(m)) return; warned.add(m); console.warn(`  marver: ${m}`) }
  return (req, res, next) => {
    let path: string
    try { path = new URL(req.url ?? '/', 'http://x').pathname } catch { return next() }
    if (path !== `${ROUTE}/logo`) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      return res.end()
    }
    const logo = findLogo(root, shareLogo(), warn)
    if (!logo) {
      res.statusCode = 404
      res.setHeader('cache-control', 'no-store')
      return res.end()
    }
    const tag = logoTag(logo.bytes)
    res.setHeader('content-type', LOGO_MIME[logo.type])
    res.setHeader('etag', tag)
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('vary', 'x-mv-nonce')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    const signed = proofHeaders(proof, req.headers['x-mv-nonce'], 'logo')
    if (signed) for (const [k, v] of Object.entries(signed)) res.setHeader(k, v)
    if (matches(req.headers['if-none-match'], tag)) {
      res.statusCode = 304
      return res.end()
    }
    res.setHeader('content-length', String(logo.bytes.length))
    res.end(req.method === 'HEAD' ? undefined : logo.bytes)
  }
}
