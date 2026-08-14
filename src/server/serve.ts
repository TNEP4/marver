/**
 * `marver serve` - a zero-dependency static server for design/.dist with an optional
 * password gate (SPEC-M2 §4b). No MARVER_PASSWORD → plain static serving. With it, the
 * bundle is never sent pre-auth: every unauthenticated request gets the gate page, auth
 * is a POST compare + an HMAC-signed 30-day cookie keyed off the password itself (all
 * instances agree, nothing stored server-side).
 */
import { createServer } from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
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

export async function serve(root: string, portFlag?: number) {
  const dist = join(root, 'design', '.dist')
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`[${NAME}] design/.dist not found - run \`npx ${NAME} build\` first.`)
    process.exit(1)
  }
  const realDist = realpathSync(dist)
  let meta: { name: string; branding: boolean; logo?: string } = { name: 'Marver', branding: true }
  try { meta = { ...meta, ...JSON.parse(readFileSync(join(dist, 'meta.json'), 'utf8')) } } catch { /* defaults */ }

  // ---- collaboration (SPEC-M3): on when MARVER_DATA_DIR names a durable home ----
  let collab: ((req: any, res: any, url: URL) => Promise<boolean>) | null = null
  let bearerCheck: ((token: string) => unknown) | null = null
  let sessionCheck: ((req: any) => unknown) | null = null
  if (process.env.MARVER_DATA_DIR) {
    const { collabHandler } = await import('./collab.ts')
    const { appendEvents, readLog } = await import('./comments.ts')
    const { dataDir } = await import('./comments.ts')
    const dir = dataDir()
    // the load-bearing seed rule: store = union of bundle seed + what it already holds.
    // Republishing must never clobber feedback collected since the last deploy.
    const seedDir = join(dist, 'design', 'comments')
    if (existsSync(seedDir))
      for (const f of readdirSync(seedDir)) {
        if (!f.endsWith('.jsonl')) continue
        const board = f.slice(0, -6)
        appendEvents(join(dir, 'comments'), board, readLog(seedDir, board))
      }
    collab = collabHandler(dir, dist)
    const { loadStore, createInvite, normEmail, sessionUser } = await import('./auth.ts')
    bearerCheck = (token) => sessionUser(dir, token)
    // a member's session IS gate passage - an account is strictly stronger than the
    // shared canvas password, so members never touch the shared secret again
    sessionCheck = (req) => {
      const tok = /(?:^|;\s*)mv_s=([\w-]+)/.exec(String(req.headers.cookie ?? ''))?.[1]
      return tok ? sessionUser(dir, tok) : null
    }
    // bootstrap: a fresh store has no owner to mint invites. MARVER_OWNER_EMAIL names
    // the first account; its one-time claim token prints HERE (deploy logs are the
    // trusted channel the deployer already reads - the Jupyter token pattern).
    const owner = process.env.MARVER_OWNER_EMAIL
    if (owner) {
      const store = loadStore(dir)
      if (!store.users.length && !store.invites.some((i) => i.emailNorm === normEmail(owner))) {
        const { token } = createInvite(dir, owner)
        console.log(`\n  owner bootstrap for ${normEmail(owner)} (single-use, 7 days):`)
        console.log(`    in the browser:  <canvas-url>/#/i/${token}`)
        console.log(`    from the repo:   npx ${NAME} comments connect <this-url> --invite ${token}\n`)
      }
    }
  }

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
          return gate(res, meta, !!collab, 'Wrong canvas password - try again')
        })
        return
      }
      // the bundle is never sent pre-auth - a client-side gate would be theater.
      // Favicons and the app logo are the one exemption: the gate page itself wears
      // them, and they carry no design data. Match the DECODED path against strict
      // filenames (no traversal): the static handler decodes too, so a raw-encoded
      // `/__mv/favicon/%2f..%2f..%2findex.html` must not slip the gate as "cosmetic".
      let decoded = url.pathname
      try { decoded = decodeURIComponent(url.pathname) } catch { /* keep raw - it won't match below */ }
      const cosmetic = /^\/__mv\/favicon\/[\w-]+(?:\.[\w-]+)+$/.test(decoded) || /^\/__mv\/logo\.(?:svg|png)$/.test(decoded)
      // a member session opens the gate outright (account > shared secret)
      if (!authed(req) && !cosmetic && !sessionCheck?.(req)) {
        // bearer requests (dev proxy / agent CLI) may pierce the gate to the API,
        // but only a VALID session token counts - `Bearer garbage` must not read
        // comment bodies or subscribe to events
        const bearerOk = collab && url.pathname.startsWith('/__mv/api/') && (() => {
          const tok = /^Bearer ([\w-]+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
          return !!tok && !!bearerCheck?.(tok)
        })()
        // sign-in, claim, and the invite peek live IN FRONT of the gate - that's the
        // whole point of the member path (rate-limited + non-enumerating in collab.ts)
        const preGate = collab && (
          (req.method === 'POST' && (url.pathname === '/__mv/api/auth/signin' || url.pathname === '/__mv/api/auth/claim')) ||
          (req.method === 'GET' && url.pathname === '/__mv/api/invite-info'))
        if (!bearerOk && !preGate) return gate(res, meta, !!collab)
      }
    }

    // the collaboration API sits behind the gate, before static
    if (collab && url.pathname.startsWith('/__mv/api/')) {
      collab(req, res, url).then((handled) => {
        if (!handled) { res.statusCode = 404; res.end('not found') }
      }).catch(() => { res.statusCode = 500; res.end('error') })
      return
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
  // same condition as `dev`, same manners: a busy port is a message, not a stack trace
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[${NAME}] port ${port} is already in use - another \`${NAME} serve\` still running? Stop it, or pass --port <n>.`)
      process.exit(1)
    }
    throw err
  })
  server.listen(port, () => {
    console.log(`\n  ${NAME} serving design/.dist → http://localhost:${port}/`)
    console.log(verifier ? '  gate: ON (MARVER_PASSWORD set)\n' : '  gate: off - set MARVER_PASSWORD to require a password\n')
  })
  return server
}

/** The Marver logo mark (ParallelogramDuo, same as the shell's sidebar). */
const MARK_AT = (size: number) => `<svg viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden><path d="M239.29,59.28l-64.8,144a8,8,0,0,1-7.3,4.72H24a8,8,0,0,1-7.3-11.28l64.8-144A8,8,0,0,1,88.81,48H232A8,8,0,0,1,239.29,59.28Z" opacity=".1"/><path d="M245.43,47.31A15.94,15.94,0,0,0,232,40H88.81a16,16,0,0,0-14.59,9.43l-64.8,144A16,16,0,0,0,24,216H167.19a16,16,0,0,0,14.59-9.43l64.8-144A16,16,0,0,0,245.43,47.31ZM167.19,200H24L88.81,56H232Z"/></svg>`
const MARK = MARK_AT(17)
const MARK_LG = MARK_AT(24)

/** The gate: the canvas's own antechamber - light ground, dot grid, glass card in the
 *  shell's exact token language. Three doors, one credential each (SPEC-M3 gate v2):
 *  guests pay the canvas password, members sign in with their OWN password, and an
 *  invite link (#/i/<token>) opens straight into the claim. The member and claim
 *  states exist only on collaboration canvases - a static canvas keeps one field. */
function gate(res: any, meta: { name: string; branding: boolean; logo?: string }, collabOn: boolean, error?: string) {
  const name = meta.name ? meta.name[0].toUpperCase() + meta.name.slice(1) : 'Marver'
  // the app's own logo when the build found one; Marver's mark as the backup
  const appMark = meta.logo ? `<img src="${esc(meta.logo)}" alt="" width="24" height="24" />` : MARK_LG
  // The self-promotion balance: the tab truncates to the app's name, so the title's
  // tail only shows where it earns its keep - link previews and full-title surfaces.
  // The description explains what the link IS (app first, Marver second); noindex
  // because a private canvas spreads by people sharing it, not by crawlers.
  // Once through the gate, the shell's own titles take over (`<board> - Marver`).
  const title = meta.branding ? `${name} | Marver - Visualize your software` : name
  const desc = meta.branding
    ? `${name}, shared as a live Marver canvas - real screens and prototypes, built from the codebase. Marver is the agent-native design canvas.`
    : `${name} - a private design canvas.`
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#e7e9ef" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
${meta.branding ? '<meta property="og:site_name" content="Marver" />' : ''}
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary" />
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
  .card { width: 340px; padding: 24px; border-radius: 24px;
    background: rgba(255, 255, 255, .64); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(24, 24, 27, .1);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .65), 0 1px 2px rgba(24, 24, 27, .05), 0 4px 12px -6px rgba(24, 24, 27, .12) }
  section { display: none; flex-direction: column; gap: 14px }
  section.on { display: flex; animation: rise .24s cubic-bezier(.32, .72, .35, 1) }
  @keyframes rise { from { opacity: 0; transform: translateY(5px) } }
  header { display: flex; align-items: center; gap: 10px; padding: 4px 2px 4px 4px }
  header svg, header img { color: #0088ff; flex: none; border-radius: 6px }
  h1 { font-size: 17px; font-weight: 600; letter-spacing: -.01em }
  p { font-size: 12.5px; line-height: 1.5; color: rgba(24, 24, 27, .66); padding: 0 4px }
  input { height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid rgba(24, 24, 27, .14);
    background: #fff; color: #18181b; font: inherit; outline: none; width: 100%;
    transition: border-color .15s, box-shadow .15s }
  input::placeholder { color: rgba(24, 24, 27, .35) }
  input:focus { border-color: #0088ff; box-shadow: 0 0 0 3px rgba(0, 136, 255, .18) }
  .stack { display: flex; flex-direction: column; gap: 10px }
  .chip { height: 40px; padding: 0 16px; border-radius: 999px; background: rgba(24, 24, 27, .05);
    display: flex; align-items: center; justify-content: space-between; gap: 10px; overflow: hidden }
  .chip b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .chip span { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; color: rgba(24, 24, 27, .4); flex: none }
  .idrow { display: flex; align-items: center; gap: 10px }
  .pfp { width: 44px; height: 44px; border-radius: 50%; border: 1.5px dashed rgba(24, 24, 27, .3);
    background: #fff center/cover no-repeat; color: rgba(24, 24, 27, .4); font-size: 18px; flex: none;
    display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
    transition: border-color .15s, color .15s }
  .pfp:hover { border-color: #0088ff; color: #0088ff }
  .pfp.set { border-style: solid; border-color: rgba(24, 24, 27, .12); color: transparent }
  button.cta { height: 40px; border: 0; border-radius: 999px; background: #18181b; color: #fafafa;
    font: 600 13px -apple-system, system-ui, sans-serif; cursor: pointer; width: 100%;
    transition: background .18s, color .18s }
  button.cta:hover:not(:disabled) { background: #000 }
  button.cta:disabled { background: rgba(24, 24, 27, .35); cursor: default }
  .ctawrap { position: relative }
  .tip { display: none; position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    padding: 5px 10px; border-radius: 7px; background: #18181b; color: #fafafa;
    font: 600 11px -apple-system, system-ui, sans-serif; white-space: nowrap; pointer-events: none;
    animation: rise .18s cubic-bezier(.32, .72, .35, 1) }
  .ctawrap:hover button:disabled ~ .tip { display: block }
  .swap { text-align: center; padding-top: 2px }
  .swap a { font: 500 12px -apple-system, system-ui, sans-serif; color: rgba(24, 24, 27, .45);
    cursor: pointer; text-decoration: underline; text-underline-offset: 3px; transition: color .15s }
  .swap a:hover { color: #18181b }
  .err { font-size: 12px; color: #b42318; padding: 0 4px }
  .err:empty { display: none }
  footer a { display: inline-flex; align-items: center; gap: 7px; font: 600 12.5px -apple-system, system-ui, sans-serif;
    color: rgba(24, 24, 27, .55); text-decoration: none }
  footer a > svg:first-of-type { width: 20px; height: 20px; color: #0088ff }
  footer .md, footer .up { transition: color .15s, opacity .15s }
  footer a:hover .md { color: #0088ff; text-decoration: underline; text-underline-offset: 3px }
  footer .up { opacity: .45; margin-left: -3px }
  footer a:hover .up { opacity: 1; color: #0088ff }
</style></head>
<body><main>
  <div class="card">

    <section id="guest" class="on">
      <form method="post" action="/__mv/auth" style="display:flex;flex-direction:column;gap:14px">
        <header>${appMark}<h1>${esc(name)}</h1></header>
        <p>You're one step from the canvas. This space is private - enter the canvas password to step inside.</p>
        <div class="err">${error ? esc(error) : ''}</div>
        <input type="password" name="password" placeholder="Canvas password" autofocus autocomplete="current-password" />
        <input type="hidden" name="next" />
        <div class="ctawrap">
          <button class="cta" type="submit" disabled>Open the canvas</button>
          <span class="tip">Enter the canvas password first</span>
        </div>
        ${collabOn ? '<div class="swap"><span style="font:500 12px -apple-system,system-ui,sans-serif;color:rgba(24,24,27,.45)">Member? <a data-go="member">Sign in instead</a></span></div>' : ''}
      </form>
    </section>
${collabOn ? `
    <section id="member">
      <header>${appMark}<h1>${esc(name)}</h1></header>
      <p>Welcome back - sign in with your own password. Your account already covers reading.</p>
      <div class="err" id="member-err"></div>
      <div class="stack">
        <input type="email" id="m-email" placeholder="Email" autocomplete="email" />
        <input type="password" id="m-pass" placeholder="Password" autocomplete="current-password" />
      </div>
      <div class="ctawrap">
        <button class="cta" id="m-go" disabled>Sign in</button>
        <span class="tip">Fill in email and password</span>
      </div>
      <div class="swap"><span style="font:500 12px -apple-system,system-ui,sans-serif;color:rgba(24,24,27,.45)">Just viewing? <a data-go="guest">Enter with the canvas password</a></span></div>
    </section>

    <section id="claim">
      <header>${appMark}<h1>${esc(name)}</h1></header>
      <p>You're invited to comment on this canvas.<br />Pick how you'll appear - comments carry your name.</p>
      <div class="err" id="claim-err"></div>
      <div class="stack">
        <div class="chip" id="c-chip" hidden><b id="c-email"></b><span>INVITED</span></div>
        <input type="password" id="c-pass" placeholder="Choose a password" autocomplete="new-password" />
      </div>
      <div class="idrow">
        <button class="pfp" id="c-pfp" type="button" aria-label="Add a profile picture">+</button>
        <input type="file" id="c-file" accept="image/*" hidden />
        <input type="text" id="c-name" placeholder="Set a display name" autocomplete="nickname" style="flex:1" />
      </div>
      <div class="ctawrap">
        <button class="cta" id="c-go" disabled>Join the canvas</button>
        <span class="tip">Password and display name still needed</span>
      </div>
    </section>
` : ''}
  </div>
  <script>
  (() => {
    const $ = (id) => document.getElementById(id)
    const next = document.querySelector('[name=next]')
    if (next) next.value = location.hash
    // the guest CTA follows its field (server-side form, client-side gating)
    const gpass = document.querySelector('#guest input[type=password]')
    const gbtn = document.querySelector('#guest button.cta')
    gpass.addEventListener('input', () => { gbtn.disabled = !gpass.value })
    ${collabOn ? `
    const show = (id) => {
      for (const s of document.querySelectorAll('section')) s.classList.toggle('on', s.id === id)
      const f = document.querySelector('#' + id + ' input:not([hidden])')
      if (f) f.focus()
    }
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]')
      if (go) { e.preventDefault(); show(go.dataset.go) }
    })
    const api = (path, body) => fetch('/__mv/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))

    // member sign-in: their session IS gate passage - reload keeps the deep link
    const gate2 = (btn, fields, tipOk) => fields.forEach((f) => f.addEventListener('input', () => {
      btn.disabled = !fields.every((x) => x.value.trim())
    }))
    gate2($('m-go'), [$('m-email'), $('m-pass')])
    const signin = async () => {
      $('m-go').disabled = true
      const r = await api('auth/signin', { email: $('m-email').value.trim(), password: $('m-pass').value })
      if (r.ok) return location.reload()
      $('member-err').textContent = r.data.error || 'sign-in failed'
      $('m-go').disabled = false
    }
    $('m-go').addEventListener('click', signin)
    $('m-pass').addEventListener('keydown', (e) => e.key === 'Enter' && !$('m-go').disabled && signin())

    // invite link (#/i/<token>): straight into the claim - the token IS the credential.
    // A hash-only navigation onto an invite link never reloads the page - re-run then.
    addEventListener('hashchange', () => { if (/^#\\/i\\//.test(location.hash)) location.reload() })
    const inv = /^#\\/i\\/([\\w-]{8,128})$/.exec(location.hash)
    let avatar = ''
    if (inv) {
      show('claim')
      api('invite-info?token=' + encodeURIComponent(inv[1])).then((r) => {
        if (r.ok) { $('c-email').textContent = r.data.email; $('c-chip').hidden = false }
        else $('claim-err').textContent = r.data.error || 'this invite link is invalid'
      })
    }
    // avatar: pick, downscale to 128px client-side, preview in the circle
    $('c-pfp').addEventListener('click', () => $('c-file').click())
    $('c-file').addEventListener('change', () => {
      const file = $('c-file').files[0]
      if (!file) return
      const img = new Image()
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement('canvas')
        c.width = c.height = 128
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128)
        avatar = c.toDataURL('image/jpeg', .85)
        const p = $('c-pfp')
        p.classList.add('set'); p.style.backgroundImage = 'url(' + avatar + ')'; p.textContent = ''
        URL.revokeObjectURL(img.src)
      }
      img.src = URL.createObjectURL(file)
    })
    gate2($('c-go'), [$('c-pass'), $('c-name')])
    const claim = async () => {
      $('c-go').disabled = true
      const r = await api('auth/claim', { token: inv ? inv[1] : '', password: $('c-pass').value, name: $('c-name').value.trim(), avatar: avatar || undefined })
      if (r.ok) return location.href = location.pathname   // consumed invite leaves the URL
      $('claim-err').textContent = r.data.error || 'claim failed'
      $('c-go').disabled = false
    }
    $('c-go').addEventListener('click', claim)
    $('c-name').addEventListener('keydown', (e) => e.key === 'Enter' && !$('c-go').disabled && claim())
    ` : ''}
  })()
  </script>
  ${meta.branding ? `<footer><a href="https://marver.design" target="_blank" rel="noopener">${MARK} <span>Powered by <span class="md">Marver.design</span></span> <svg class="up" viewBox="0 0 256 256" width="11" height="11" fill="currentColor" aria-hidden><path d="M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z"/></svg></a></footer>` : ''}
</main></body></html>`)
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
