/**
 * `marver serve` - a zero-dependency static server for design/.dist with an optional
 * password gate (SPEC-M2 §4b). No MARVER_PASSWORD → plain static serving. With it, the
 * bundle is never sent pre-auth: every unauthenticated request gets the gate page, auth
 * is a POST compare + an HMAC-signed 30-day cookie keyed off the password itself (all
 * instances agree, nothing stored server-side).
 */
import { createServer } from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { NAME } from '../cli/name.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
}

const COOKIE = 'mv_a'
const MONTH = 30 * 24 * 3600

export function serve(root: string, portFlag?: number) {
  const dist = join(root, 'design', '.dist')
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`[${NAME}] design/.dist not found - run \`npx ${NAME} build\` first.`)
    process.exit(1)
  }
  const realDist = realpathSync(dist)
  let meta = { name: 'Marver', branding: true }
  try { meta = { ...meta, ...JSON.parse(readFileSync(join(dist, 'meta.json'), 'utf8')) } } catch { /* defaults */ }

  const password = process.env.MARVER_PASSWORD ?? ''
  // verifier: scrypt-derived, fixed length - each guess pays the scrypt cost (a natural
  // throttle) and the compare never leaks password length. Cookies are signed with a
  // RANDOM per-boot secret, so a captured cookie is not offline brute-force material
  // for the password; a restart just re-prompts.
  const verifier = password ? scryptSync(password, 'marver-gate', 32) : null
  const cookieKey = randomBytes(32)
  const sign = (exp: number) => createHmac('sha256', cookieKey).update(`v1.${exp}`).digest('hex')
  const authed = (req: any): boolean => {
    const m = /(?:^|;\s*)mv_a=(\d+)\.([0-9a-f]+)/.exec(String(req.headers.cookie ?? ''))
    if (!m) return false
    const exp = Number(m[1])
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false
    const want = Buffer.from(sign(exp)), got = Buffer.from(m[2])
    return want.length === got.length && timingSafeEqual(want, got)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')

    if (verifier) {
      if (req.method === 'POST' && url.pathname === '/__mv/auth') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
        req.on('end', () => {
          const given = new URLSearchParams(body).get('password') ?? ''
          if (timingSafeEqual(scryptSync(given, 'marver-gate', 32), verifier)) {
            const exp = Math.floor(Date.now() / 1000) + MONTH
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
            res.setHeader('set-cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${MONTH}; HttpOnly; SameSite=Lax${secure}`)
            res.statusCode = 303
            res.setHeader('location', '/')
            return res.end()
          }
          return gate(res, meta, 'Wrong password - try again')
        })
        return
      }
      // the bundle is never sent pre-auth - a client-side gate would be theater
      if (!authed(req)) return gate(res, meta)
    }

    // static: sanitized path under dist; extensionless → index.html (hash routing).
    // Containment is realpath-based: encoded separators and symlinks cannot escape.
    let path: string
    try { path = decodeURIComponent(url.pathname) } catch { res.statusCode = 400; return res.end('bad request') }
    if (path.endsWith('/')) path += 'index.html'
    let file = resolve(dist, path.slice(1))
    try {
      const real = realpathSync(file)
      const rel = relative(realDist, real)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('outside dist')
      file = real
    } catch { file = join(dist, 'index.html') }   // missing or escaping → the shell (hash routing)
    if (!extname(file)) file = join(dist, 'index.html')
    try {
      const content = readFileSync(file)
      res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream')
      // gated responses are never publicly cacheable - a CDN would serve the bundle
      // (inlined boards included) to unauthenticated clients from its cache
      const cache = verifier ? 'private, no-store'
        : file.startsWith(join(dist, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-store'
      res.setHeader('cache-control', cache)
      res.end(content)
    } catch { res.statusCode = 404; res.end('not found') }
  })

  const port = portFlag ?? (Number(process.env.PORT) || 4199)
  server.listen(port, () => {
    console.log(`\n  ${NAME} serving design/.dist → http://localhost:${port}/`)
    console.log(verifier ? '  gate: ON (MARVER_PASSWORD set)\n' : '  gate: off - set MARVER_PASSWORD to require a password\n')
  })
  return server
}

/** The gate: one card on a near-black stage, in the shell's glass language. */
function gate(res: any, meta: { name: string; branding: boolean }, error?: string) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0 }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0b; font: 500 14px -apple-system, system-ui, sans-serif; color: #f5f5f7 }
  main { display: flex; flex-direction: column; align-items: center; gap: 24px }
  form { width: 320px; padding: 28px; border-radius: 18px; display: flex; flex-direction: column; gap: 14px;
    background: rgba(18, 18, 24, .82); border: 1px solid rgba(255, 255, 255, .12) }
  h1 { font-size: 15px; font-weight: 600 }
  p { font-size: 12px; color: rgba(245, 245, 247, .55) }
  input { height: 38px; padding: 0 12px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .16);
    background: rgba(255, 255, 255, .06); color: #f5f5f7; font: inherit; outline: none }
  input:focus { border-color: rgba(255, 255, 255, .4) }
  button { height: 38px; border: 0; border-radius: 10px; background: #f5f5f7; color: #18181b;
    font: 600 13px -apple-system, system-ui, sans-serif; cursor: pointer }
  button:hover { background: #fff }
  .err { color: #ff8a80; font-size: 12px }
  footer a { color: rgba(245, 245, 247, .4); font-size: 12px; text-decoration: none }
  footer a:hover { color: rgba(245, 245, 247, .7) }
</style></head>
<body><main>
  <form method="post" action="/__mv/auth">
    <h1>${esc(meta.name)}</h1>
    <p>This canvas is password-protected.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" />
    <button type="submit">Open canvas</button>
  </form>
  ${meta.branding ? '<footer><a href="https://marver.design">Powered by Marver</a></footer>' : ''}
</main></body></html>`)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
