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
  let meta: { name: string; branding: boolean; logo?: string } = { name: 'Marver', branding: true }
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
          const form = new URLSearchParams(body)
          const given = form.get('password') ?? ''
          if (timingSafeEqual(scryptSync(given, 'marver-gate', 32), verifier)) {
            const exp = Math.floor(Date.now() / 1000) + MONTH
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
            res.setHeader('set-cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${MONTH}; HttpOnly; SameSite=Lax${secure}`)
            // deep links survive the gate: the page posts its hash, redirects carry it
            // back. Whitelisted charset - no CR/LF, no absolute URLs, no header games.
            const next = form.get('next') ?? ''
            res.statusCode = 303
            res.setHeader('location', /^#\/[\w\/?&=%.,~-]*$/.test(next) ? `/${next}` : '/')
            return res.end()
          }
          return gate(res, meta, 'Wrong password - try again')
        })
        return
      }
      // the bundle is never sent pre-auth - a client-side gate would be theater.
      // Favicons and the app logo are the one exemption: the gate page itself wears
      // them, and they carry no design data.
      const cosmetic = url.pathname.startsWith('/__mv/favicon/') || /^\/__mv\/logo\.(svg|png)$/.test(url.pathname)
      if (!authed(req) && !cosmetic) return gate(res, meta)
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

/** The Marver logo mark (ParallelogramDuo, same as the shell's sidebar). */
const MARK_AT = (size: number) => `<svg viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden><path d="M239.29,59.28l-64.8,144a8,8,0,0,1-7.3,4.72H24a8,8,0,0,1-7.3-11.28l64.8-144A8,8,0,0,1,88.81,48H232A8,8,0,0,1,239.29,59.28Z" opacity=".1"/><path d="M245.43,47.31A15.94,15.94,0,0,0,232,40H88.81a16,16,0,0,0-14.59,9.43l-64.8,144A16,16,0,0,0,24,216H167.19a16,16,0,0,0,14.59-9.43l64.8-144A16,16,0,0,0,245.43,47.31ZM167.19,200H24L88.81,56H232Z"/></svg>`
const MARK = MARK_AT(14)
const MARK_LG = MARK_AT(24)

/** The gate: the canvas's own antechamber - light ground, dot grid, glass card in the
 *  shell's exact token language. The visitor is one password away from stepping in. */
function gate(res: any, meta: { name: string; branding: boolean; logo?: string }, error?: string) {
  const name = meta.name ? meta.name[0].toUpperCase() + meta.name.slice(1) : 'Marver'
  // the app's own logo when the build found one; Marver's mark as the backup
  const appMark = meta.logo ? `<img src="${esc(meta.logo)}" alt="" width="24" height="24" />` : MARK_LG
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<link rel="icon" href="/__mv/favicon/favicon.ico" sizes="48x48" />
<link rel="icon" type="image/png" sizes="32x32" href="/__mv/favicon/favicon-32x32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/__mv/favicon/favicon-16x16.png" />
<link rel="apple-touch-icon" href="/__mv/favicon/apple-touch-icon.png" />
<style>
  * { box-sizing: border-box; margin: 0 }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background-color: #e7e9ef;
    background-image: radial-gradient(#c9cbd5 1px, transparent 1px); background-size: 20px 20px;
    font: 500 14px -apple-system, system-ui, sans-serif; color: #18181b;
    -webkit-font-smoothing: antialiased }
  main { display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 16px }
  form { width: 340px; padding: 24px; border-radius: 24px; display: flex; flex-direction: column; gap: 14px;
    background: rgba(255, 255, 255, .64); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(24, 24, 27, .1);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .65), 0 1px 2px rgba(24, 24, 27, .05), 0 4px 12px -6px rgba(24, 24, 27, .12) }
  header { display: flex; align-items: center; gap: 10px; padding: 4px 2px 4px 4px }
  header svg, header img { color: #0088ff; flex: none; border-radius: 6px }
  h1 { font-size: 17px; font-weight: 650; letter-spacing: -.01em }
  p { font-size: 12.5px; line-height: 1.5; color: rgba(24, 24, 27, .66); padding: 0 4px }
  input { height: 40px; padding: 0 13px; border-radius: 12px; border: 1px solid rgba(24, 24, 27, .14);
    background: #fff; color: #18181b; font: inherit; outline: none; transition: border-color .15s, box-shadow .15s }
  input::placeholder { color: rgba(24, 24, 27, .35) }
  input:focus { border-color: #0088ff; box-shadow: 0 0 0 3px rgba(0, 136, 255, .18) }
  button { height: 40px; border: 0; border-radius: 12px; background: #18181b; color: #fafafa;
    font: 600 13px -apple-system, system-ui, sans-serif; cursor: pointer; transition: background .15s }
  button:hover { background: #000 }
  .err { font-size: 12px; color: #b42318; padding: 0 4px }
  footer a { display: inline-flex; align-items: center; gap: 7px; font: 600 12.5px -apple-system, system-ui, sans-serif;
    color: #0077e6; text-decoration: none; transition: color .15s }
  footer a:hover { color: #0088ff; text-decoration: underline; text-underline-offset: 3px }
  footer .up { opacity: .7 }
</style></head>
<body><main>
  <form method="post" action="/__mv/auth">
    <header>${appMark}<h1>${esc(name)}</h1></header>
    <p>You're one step from the canvas. This space is private - enter the password to step inside.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" />
    <input type="hidden" name="next" />
    <button type="submit">Open the canvas</button>
  </form>
  <script>document.querySelector('[name=next]').value = location.hash</script>
  ${meta.branding ? `<footer><a href="https://marver.design" target="_blank" rel="noopener">${MARK} Powered by Marver.design <svg class="up" viewBox="0 0 256 256" width="10" height="10" fill="currentColor" aria-hidden><path d="M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z"/></svg></a></footer>` : ''}
</main></body></html>`)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
