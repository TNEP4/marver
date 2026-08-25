import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest, createServer as createHttpServer } from 'node:http'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The gate, exercised as a real server on a real port.
 *
 * Unit tests cover whether a token verifies. These cover the thing unit tests
 * cannot: that adding a THIRD gate provider did not quietly change the two that
 * already existed. A canvas that starts serving its bundle pre-auth because of a
 * refactor is the worst bug this repo could ship, and it would not show up in
 * any test of marver-id.ts.
 *
 * Each mode gets its own server, its own data directory and its own port, so a
 * failure names exactly which configuration broke.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')

/**
 * Build the CLI if it is not there.
 *
 * These are the only tests that would catch a canvas serving its bundle
 * pre-auth, so they must never quietly skip. `describe.skipIf(!built)` on a
 * clean checkout would do exactly that - a green run that proved nothing, which
 * is worse than a red one.
 */
function ensureBuilt(): void {
  // Unconditionally. `dist/` is gitignored, so a stale build from an earlier
  // branch would happily test code that is not in this commit - a green run
  // proving something nobody asked about.
  execFileSync('npm', ['run', 'build'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'ignore',
    timeout: 120_000,
  })
  if (!existsSync(CLI)) throw new Error('build did not produce dist/cli.mjs - cannot verify the gate')
}

/** A minimal published canvas - enough for `serve` to agree to start. */
function fixture(branding = false): string {
  const root = mkdtempSync(join(tmpdir(), 'mv-gate-'))
  const dist = join(root, 'design', '.dist')
  mkdirSync(dist, { recursive: true })
  // The marker below stands in for the real bundle: if a response contains it,
  // the canvas was served, which pre-auth is exactly the failure we are hunting.
  writeFileSync(join(dist, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ name: 'Fixture', branding }))
  // A real asset, so cache headers can be checked on a file that EXISTS - the
  // gate's own no-store would otherwise mask a wrong header on real content.
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'assets', 'probe.js'), 'export const probe = 1\n')
  // A real favicon, so the cosmetic exemption has something legitimate to serve.
  mkdirSync(join(dist, '__mv', 'favicon'), { recursive: true })
  writeFileSync(join(dist, '__mv', 'favicon', 'favicon.ico'), 'x')
  return root
}

type Canvas = { port: number; root: string; proc: ChildProcess }

async function start(env: Record<string, string>, port: number, branding = false): Promise<Canvas> {
  const root = fixture(branding)
  const proc = spawn(process.execPath, [CLI, 'serve'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: 'ignore',
  })
  // Poll rather than sleep: a fixed wait is either flaky or slow.
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) })
      return { port, root, proc }
    } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  throw new Error(`canvas on ${port} never came up`)
}

function stop(c: Canvas) {
  c.proc.kill('SIGKILL')
  rmSync(c.root, { recursive: true, force: true })
}

/**
 * Where /start sends the tab.
 *
 * It used to answer JSON for a script to read; it is a redirect now, because the
 * whole flow happens in one tab and leaving needs no JavaScript. `redirect:
 * 'manual'` matters - let fetch follow it and the test wanders off to the
 * fixture issuer, which does not resolve.
 */
async function startedAuthorize(res: Response): Promise<URL> {
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location') ?? '')
}

const bundleServed = (html: string) => html.includes('id="root"') && html.includes('type="module"')

/**
 * A raw HTTP request, so a test can set headers `fetch` refuses to.
 *
 * `host` is a forbidden header name in the fetch spec: undici silently drops
 * it, which made an earlier version of the spoofing test pass without ever
 * spoofing anything. Header-injection tests have to speak HTTP directly.
 */
/**
 * A POST with headers a browser sets and script cannot.
 *
 * Sec-Fetch-* are forbidden header names, so fetch() silently drops them - which
 * is exactly why the approve route can rely on them, and exactly why a test of
 * that route cannot use fetch. Raw HTTP is the only way to describe what a real
 * navigation looks like.
 */
function rawPost(port: number, path: string, body: string, headers: Record<string, string> = {}):
  Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { out += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function raw(port: number, path: string, headers: Record<string, string> = {}):
  Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    // `hostname` for the connection, `headers.host` for the header. Passing
    // `host` in the options sets BOTH, so a spoofing test would send two Host
    // headers and the server would reset the connection on a malformed request.
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { connection: 'close', ...headers } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// Real servers, real ports, real scrypt. The default 5s budget is for unit
// tests; spawning three canvases and authenticating against them is not that.
describe('gate providers - three modes, one server each', { timeout: 30_000 }, () => {
  let open: Canvas, password: Canvas, identity: Canvas, behindTls: Canvas
  /** A password-gate cookie and an identity session, for authenticated probes. */
  let passwordCookie = ''
  let identitySession = ''
  let identityDataDir = ''

  beforeAll(async () => {
    ensureBuilt()
    identityDataDir = mkdtempSync(join(tmpdir(), 'mv-d2-'))
    ;[open, password, identity, behindTls] = await Promise.all([
      start({}, 4471),
      start({ MARVER_PASSWORD: 'hunter2', MARVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'mv-d1-')) }, 4472),
      start({
        MARVER_ID_ISSUER: 'https://id.example.test',
        MARVER_PUBLIC_ORIGIN: 'http://localhost:4473',
        MARVER_DATA_DIR: identityDataDir,
        MARVER_OWNER_EMAIL: 'owner@example.test',
      }, 4473),
      // The https branch, without needing a certificate. Cookie security follows
      // the canvas's own PUBLIC origin, which is what a deployment behind a TLS
      // terminator looks like: https to the world, plain http on the socket.
      start({
        MARVER_ID_ISSUER: 'https://id.example.test',
        MARVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'mv-d3-')),
        MARVER_OWNER_EMAIL: 'owner@example.test',
        MARVER_PUBLIC_ORIGIN: 'https://canvas.example.test',
      }, 4474),
    ])
  }, 120_000)

  beforeAll(async () => {
    // Authenticate against the password canvas the way a browser does.
    const res = await fetch(`http://localhost:${password.port}/__mv/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter2',
      redirect: 'manual',
    })
    passwordCookie = /mv_a=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''
    expect(passwordCookie).toBeTruthy()

    // And mint a real identity session by provisioning the bootstrap owner
    // directly - the assertion round trip needs a live identity service, which
    // these tests deliberately do not depend on.
    const { provisionFromMarverId } = await import('../src/server/auth.ts')
    const granted = provisionFromMarverId(
      identityDataDir,
      { email: 'owner@example.test', subject: 's1', issuer: 'https://id.example.test' },
      { ownerEmail: 'owner@example.test' },
    )
    identitySession = granted?.session ?? ''
    expect(identitySession).toBeTruthy()
  })

  afterAll(() => [open, password, identity, behindTls].forEach((c) => c && stop(c)))

  it('no gate configured: serves the canvas, as it always has', async () => {
    const html = await (await fetch(`http://localhost:${open.port}/`)).text()
    expect(bundleServed(html)).toBe(true)
  })

  it('password mode: the bundle is NEVER sent pre-auth, by ANY path', async () => {
    // Every shape a private file can be asked for, not just "/". The bundle
    // disclosure this suite exists to catch arrived through a path nobody had
    // thought to request - so requesting only the front door proves nothing.
    for (const p of ['/', '/index.html', '/assets/probe.js', '/board/anything', '/no-such-route']) {
      const res = await fetch(`http://localhost:${password.port}${p}`)
      const html = await res.text()
      expect(bundleServed(html), `bundle leaked at ${p}`).toBe(false)
      expect(html, `no gate at ${p}`).toContain('name="password"')
      // The fixture's own bytes must not appear either, whatever the wrapper.
      expect(html, `asset bytes leaked at ${p}`).not.toContain('export const probe')
    }
  })

  it('password mode: the identity endpoints do not open a hole', async () => {
    // They must not exist here, and above all must not become a path that skips
    // the gate - a bypass is a bypass even when the handler behind it is absent.
    for (const p of ['/__mv/id/start', '/__mv/id/callback', '/__mv/id/anything']) {
      const res = await fetch(`http://localhost:${password.port}${p}`)
      const html = await res.text()
      expect(bundleServed(html), `bundle leaked at ${p}`).toBe(false)
      // "not the bundle" is too weak on its own: an identity handler answering
      // JSON here would also pass it. In password mode these paths must be the
      // password gate and nothing else.
      expect(html, `${p} did not answer with the password gate`).toContain('name="password"')
      // "not the bundle" would also pass if an identity handler answered JSON
      // here, which is the accidental exposure worth catching. The gate page is
      // HTML and never hands out a transaction.
      expect(res.headers.get('content-type') ?? '', `${p} did not answer HTML`).toContain('text/html')
      expect(html, `${p} issued a transaction`).not.toContain('"nonce"')
    }
  })

  it('identity mode: the bundle is never sent pre-auth by ANY path, and no password is asked for', async () => {
    for (const p of ['/', '/index.html', '/assets/probe.js', '/board/anything', '/no-such-route']) {
      const res = await fetch(`http://localhost:${identity.port}${p}`)
      const html = await res.text()
      expect(bundleServed(html), `bundle leaked at ${p}`).toBe(false)
      expect(html, `asset bytes leaked at ${p}`).not.toContain('export const probe')
      // A password box here would mean the gate fell back to the other provider.
      expect(html, `password asked for at ${p}`).not.toContain('name="password"')
      expect(html, `no identity gate at ${p}`).toContain('id-go')
    }
  })

  it('identity mode: /start issues a distinct nonce per request, bound to this canvas', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://localhost:${identity.port}/__mv/id/start`, { redirect: 'manual' })
      const u = await startedAuthorize(res)
      expect(u.origin).toBe('https://id.example.test')
      // The canvas names ITSELF as the audience-to-be, port included.
      expect(u.searchParams.get('origin')).toBe(`http://localhost:${identity.port}`)
      seen.add(u.searchParams.get('nonce')!)
    }
    expect(seen.size).toBe(3)
  })

  it('identity mode: a junk callback fails closed and fast, without a session', async () => {
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: 'not.a.token' }),
      signal: AbortSignal.timeout(10_000),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mv_s=')
  })

  it('identity mode: a REAL asset is never marked publicly cacheable', async () => {
    // Found in review: cache headers keyed on the password verifier alone, so an
    // identity-gated canvas told every CDN its assets were public and immutable.
    //
    // Checked on a file that EXISTS and is reached with a session - an
    // unauthenticated request just gets the gate's own no-store, which would
    // pass even against the broken code.
    const res = await fetch(`http://localhost:${identity.port}/assets/probe.js`, {
      headers: { cookie: `mv_s=${identitySession}` },
    })
    expect(res.status).toBe(200)
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('no-store')
    expect(cc).not.toContain('public')
    expect(cc).not.toContain('immutable')
  })

  it('password mode: a REAL asset is never marked publicly cacheable either', async () => {
    const res = await fetch(`http://localhost:${password.port}/assets/probe.js`, {
      headers: { cookie: `mv_a=${passwordCookie}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control') ?? '').toContain('no-store')
  })

  it('an UNGATED canvas still caches its assets aggressively', async () => {
    // The optimisation must survive the fix - this is the case it exists for.
    const res = await fetch(`http://localhost:${open.port}/assets/probe.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control') ?? '').toContain('immutable')
  })

  it('a NON-EXISTENT cosmetic path 404s instead of leaking the bundle', async () => {
    // Pre-existing on main: /__mv/favicon/anything.png skipped the gate, missed
    // on disk, and fell through to the hash-routing fallback - handing the whole
    // private bundle to anyone who asked.
    for (const c of [password, identity]) {
      for (const p of ['/__mv/favicon/nope.png', '/__mv/favicon/a.b.c', '/__mv/logo.svg']) {
        const res = await fetch(`http://localhost:${c.port}${p}`)
        const body = await res.text()
        expect(bundleServed(body)).toBe(false)
        expect(res.status).toBe(404)
      }
    }
  })

  it('but a REAL favicon is still served - the gate page wears it', async () => {
    const res = await fetch(`http://localhost:${identity.port}/__mv/favicon/favicon.ico`)
    expect(res.status).toBe(200)
    // Status alone would pass if index.html were served under this name, which
    // is precisely the fallback that caused the disclosure. Check the bytes.
    expect(await res.text()).toBe('x')
  })

  it('identity mode: the password sign-in and invite-claim paths are NOT pre-gate', async () => {
    // Leaving them open would put a password-shaped door beside the identity
    // gate - exactly what choosing identity mode is meant to remove.
    for (const p of ['/__mv/api/auth/signin', '/__mv/api/auth/claim']) {
      const res = await fetch(`http://localhost:${identity.port}${p}`, { method: 'POST' })
      const html = await res.text()
      expect(bundleServed(html)).toBe(false)
      expect(html).toContain('id-go')   // the gate answered, not the API
    }
  })

  it('identity mode: a wrong-method call to an ID path hits the GATE', async () => {
    // Asserting merely "not the bundle" would pass if the ID handler answered
    // with its own JSON 404 - which would mean the path still skipped the gate.
    const html = await (await fetch(`http://localhost:${identity.port}/__mv/id/start`, { method: 'POST' })).text()
    expect(bundleServed(html)).toBe(false)
    expect(html).toContain('id-go')
  })

  it('identity mode: malformed JWT shapes REACH the verifier and are refused', async () => {
    // null / array / scalar are all valid JSON, and `null.alg` throws a TypeError
    // - which escaped verifyAssertion's contract and could take the process down.
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const shapes = [
      `${b(null)}.${b({ iss: 'x' })}.AA`,
      `${b({ alg: 'ES256' })}.${b(null)}.AA`,
      `${b([1, 2])}.${b({ iss: 'x' })}.AA`,
      `${b('str')}.${b(7)}.AA`,
    ]
    for (const token of shapes) {
      // A real browser handle, so the request gets PAST the cookie check and
      // actually exercises the parser. Without it these are rejected earlier and
      // the test would pass even against the throwing version.
      const start = await fetch(`http://localhost:${identity.port}/__mv/id/start`, { redirect: 'manual' })
      const mvb = /mv_b=([\w-]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1]
      expect(mvb).toBeTruthy()
      const res = await fetch(`http://localhost:${identity.port}/__mv/id/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `mv_b=${mvb}` },
        body: JSON.stringify({ assertion: token }),
        signal: AbortSignal.timeout(8000),
      })
      // 401 exactly, not "any 4xx". The verifier used to THROW on some of these
      // shapes; the route caught it and answered 500, and a >=400 assertion
      // called that a pass. A refusal and a crash must not look alike.
      expect(res.status, `${token.slice(0, 24)} was not refused as 401`).toBe(401)
    }
    // and the server is still alive afterwards
    expect((await fetch(`http://localhost:${identity.port}/__mv/id/start`, { redirect: 'manual' })).status).toBe(302)
  })

  it('identity mode: the refusal never says WHY', async () => {
    // "expired" vs "wrong audience" would turn this endpoint into a debugger for
    // whoever is probing it. The reason belongs in the operator's logs.
    //
    // This has to reach the verifier to mean anything. Without a browser cookie
    // the request is refused before any claim is examined, so every phrase we
    // check for is trivially absent and the test proves nothing. So: take a
    // real transaction, then present a well-formed assertion minted for a
    // DIFFERENT audience - a refusal with a specific, tempting reason behind it.
    const start = await fetch(`http://localhost:${identity.port}/__mv/id/start`, { redirect: 'manual' })
    const mvb = /mv_b=([\w-]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1]
    expect(mvb).toBeTruthy()
    const nonce = (await startedAuthorize(start)).searchParams.get('nonce')

    // Unsigned on purpose. The audience is checked BEFORE the signature is, so
    // this reaches the claim comparison without needing the fixture issuer's
    // private key - and the claim comparison is where the tempting reason is.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const wrongAudience = [
      b64({ alg: 'ES256', typ: 'marver-assertion+jwt', kid: 'k1' }),
      b64({
        iss: 'https://id.example.test',
        aud: 'https://somewhere-else.example',
        sub: 'user-1',
        email: 'someone@example.test',
        email_verified: true,
        nonce: nonce ?? 'x'.repeat(32),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
      Buffer.alloc(64).toString('base64url'),
    ].join('.')

    const res = await fetch(`http://localhost:${identity.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `mv_b=${mvb}` },
      body: JSON.stringify({ assertion: wrongAudience }),
      signal: AbortSignal.timeout(8000),
    })
    expect(res.status).toBe(401)

    const body = await res.text()
    for (const leak of ['aud', 'iss', 'signature', 'nonce', 'expired', 'audience', 'somewhere-else']) {
      expect(body, `the refusal named "${leak}"`).not.toContain(leak)
    }
  })

  /**
   * The browser handle binds a sign-in to the browser that began it. Without the
   * `__Host-` prefix a sibling on a shared parent domain can set one, which
   * means choosing somebody else's binding. The prefix makes the cookie
   * host-only and the BROWSER enforces it, which is the only place it can be -
   * a server cannot tell a tossed cookie from its own.
   */

  it('the browser handle is plain over http, where the prefix would be invalid', async () => {
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/start`, { redirect: 'manual' })
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/(^|[;,\s])mv_b=/)
    expect(setCookie).not.toContain('__Host-')
    // No Secure flag either, which would make the cookie unsendable over http.
    expect(setCookie).not.toContain('Secure')
  })

  it('and IS prefixed when the canvas is served over https', async () => {
    // Against a canvas whose public origin is https, which is what every real
    // deployment is. Asserting only the scheme-independent attributes on the
    // http server left the prefix shipping in a branch no test ever entered.
    const res = await fetch(`http://localhost:${behindTls.port}/__mv/id/start`, { redirect: 'manual' })
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__Host-mv_b=')
    // The prefix is only honoured with all three of these. Miss one and the
    // browser silently ignores the whole thing.
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).not.toContain('Domain=')
    expect(setCookie).toContain('HttpOnly')
  })

  it('and the prefixed handle is the one it reads back', async () => {
    // A canvas that WRITES the prefixed name and READS the plain one would set
    // a fresh transaction on every request, so nobody could ever finish signing
    // in. Pressing Continue twice has to land on the same attempt.
    const first = await fetch(`http://localhost:${behindTls.port}/__mv/id/start`, { redirect: 'manual' })
    const handle = /(__Host-mv_b=[\w-]+)/.exec(first.headers.get('set-cookie') ?? '')?.[1]
    expect(handle).toBeTruthy()
    const again = await fetch(`http://localhost:${behindTls.port}/__mv/id/start`, {
      headers: { cookie: handle! }, redirect: 'manual',
    })
    expect((await startedAuthorize(again)).searchParams.get('nonce'))
      .toBe((await startedAuthorize(first)).searchParams.get('nonce'))
  })

  /**
   * One tab, no opener.
   *
   * The popup design this replaced was dead on arrival for social sign-in:
   * Google serves Cross-Origin-Opener-Policy: same-origin, which severs the
   * popup's window.opener permanently. The assertion had nowhere to go, and the
   * gate sat on "Opening..." for ever. Nothing in the flow may depend on two
   * windows being able to talk to each other.
   */

  it('the gate leaves WITHOUT JavaScript - Continue is a plain form submit', async () => {
    // If leaving needs a script, it can be broken by a popup blocker, an
    // extension, or a CSP. A GET form cannot.
    const html = await (await fetch(`http://localhost:${identity.port}/`)).text()
    expect(html).toContain('action="/__mv/id/start"')
    expect(html).toMatch(/<button[^>]*id="id-go"[^>]*type="submit"/)
    // And the machinery that broke is gone, not merely unused.
    expect(html).not.toContain('window.open')
    expect(html).not.toContain('popup.closed')
    expect(html).not.toContain('postMessage')
  })

  it('identity mode: /finish is reachable before sign-in, and is the same bytes for everyone', async () => {
    // It has to answer somebody with no session - that is the entire point.
    // And since the assertion is in the fragment, this server never saw it, so
    // there is nothing here to template and nothing to escape.
    const a = await fetch(`http://localhost:${identity.port}/__mv/id/finish`)
    const b = await fetch(`http://localhost:${identity.port}/__mv/id/finish#anything-at-all`)
    expect(a.status).toBe(200)
    const [ha, hb] = [await a.text(), await b.text()]
    expect(ha).toBe(hb)
    expect(bundleServed(ha)).toBe(false)
    // It posts the assertion to our own origin - never anywhere else.
    expect(ha).toContain("fetch('/__mv/id/callback'")
    // Exactly one address off this canvas, and it is the configured issuer:
    // "use a different account" has to end the session over THERE, because a
    // canvas cannot reach across origins to do it. Anything else pointing out
    // is a bug.
    const external = [...ha.matchAll(/https?:\/\/[^"'\s]+/g)].map((m) => m[0])
    expect(external.every((u) => u.startsWith('https://id.example.test')), external.join(' ')).toBe(true)
    // And it names the refusal a person is most likely to hit. The wording moved
    // when the page was restyled; what must not move is that the sentence a
    // refused person reads is IN this page rather than fetched from anywhere.
    expect(ha).toContain("You haven't been invited")
    expect(ha).toContain('not on the invite list')
    // It wears the gate's ground, so a refusal does not look like an error page
    // from somewhere else.
    expect(ha).toContain('#e7e9ef')
  })

  it('identity mode: /finish is never cached and never leaks a referrer', async () => {
    // A cached finish page would replay somebody else's sign-in screen, and a
    // referrer would carry this canvas's address to wherever they click next.
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/finish`)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('branding:false strips Marver from the sign-in screens too, not just the gate', async () => {
    // This fixture sets branding:false, and the promise that setting makes is
    // "every Marver mention". The identity finish page was the exception nobody
    // noticed - the last screen of the flow, still wearing a footer an operator
    // had explicitly turned off.
    for (const path of ['/', '/__mv/id/finish', '/__mv/cli?code=ABCD-2345']) {
      const html = await (await fetch(`http://localhost:${identity.port}${path}`)).text()
      expect(html, `${path} still says "Powered by"`).not.toContain('Powered by')
      expect(html, `${path} still links to marver.design`).not.toContain('href="https://marver.design')
    }
  }, 30_000)

  it('password mode: /finish does not exist - a path is never open wider than the feature', async () => {
    const res = await fetch(`http://localhost:${password.port}/__mv/id/finish`)
    const html = await res.text()
    expect(bundleServed(html)).toBe(false)
    expect(html).toContain('name="password"')
  })

  it('identity mode: /start is never cached - a cached redirect is a spent nonce', async () => {
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/start`, { redirect: 'manual' })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  // ---- raw-socket tests last, deliberately ----

  /**
   * Moved down here with the raw-socket tests, and for the same reason.
   *
   * Refusing a 200KB body means answering before the body has been read, which
   * leaves bytes in flight and the connection unusable. Node's fetch keeps that
   * socket in its pool and hands it to the next request, which then dies with
   * ECONNRESET - a failure that looks like the NEXT test's bug and is not.
   */
  it('identity mode: an oversized body gets a bounded refusal, not a dead socket', async () => {
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: 'x'.repeat(200_000) }),
      signal: AbortSignal.timeout(8000),
    })
    expect(res.status).toBe(413)
  })

  //
  // These close their connections, and Node's fetch keeps a pool keyed by
  // origin: a later fetch would reuse a socket the server had already closed and
  // fail with ECONNRESET. Running them at the end means nothing follows them to
  // trip over it.
  it('identity mode: a spoofed Host NEVER becomes the audience', async () => {
    // Sent over a raw socket, because fetch() drops `host` and an earlier
    // version of this test therefore proved nothing at all.
    const res = await raw(identity.port, '/__mv/id/start', { host: 'evil.example.com' })
    // Either the canvas refuses to guess, or it names itself - never the
    // attacker's host. Both outcomes are safe; naming evil.example.com is not.
    expect(res.body).not.toContain('evil.example.com')
    expect(String(res.headers.location ?? '')).not.toContain('evil.example.com')
  })

  it('identity mode: the audience is the pinned origin, whatever a caller asserts', async () => {
    // The canvas used to infer its own origin when both socket addresses were
    // loopback. That did not survive the ordinary self-hosted shape: nginx's
    // documented `proxy_pass http://localhost:PORT` rewrites Host to the
    // upstream and adds no X-Forwarded-* at all, so a request from the open
    // internet is indistinguishable from a local one - and the inference would
    // have handed its caller an http://localhost audience and a cookie with no
    // Secure flag. There is no signal a proxy cannot erase, so the origin is
    // now configuration and these headers are simply ignored.
    const res = await raw(identity.port, '/__mv/id/start', {
      'x-forwarded-host': 'attacker.test',
      'x-forwarded-proto': 'https',
    })
    expect(res.status).toBe(302)
    const named = new URL(String(res.headers.location)).searchParams.get('origin')!
    expect(named).toBe(`http://localhost:${identity.port}`)
    expect(res.body).not.toContain('attacker.test')
  })

})

/**
 * The whole path, once, for real: /start -> a signed assertion -> a session.
 *
 * Everything else in this file proves a REFUSAL - wrong audience, spent nonce,
 * uninvited address. Nothing proved the success case end to end, and the gap was
 * not academic: the callback issued `mv_s` without its `mv_c` double-submit
 * partner, so every identity user got a canvas they could read and never write
 * to - no comments, no profile, no invites, all 403 - and the entire suite
 * stayed green. A test that only ever watches the door slam does not notice the
 * key snapping off in the lock.
 *
 * This needs a real issuer, because the signature is checked against fetched
 * keys. So it stands one up: a P-256 keypair, a JWKS endpoint, and assertions
 * signed the way the identity service signs them.
 */
describe('identity mode: the successful path, end to end', () => {
  const KID = 'e2e-1'
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const OWNER = 'owner@example.test'

  let issuer: import('node:http').Server
  let issuerUrl = ''
  let canvas: Canvas

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

  /** An assertion shaped exactly like the identity service's. */
  function assertionFor(opts: { aud: string; nonce: string; email?: string; sub?: string }): string {
    const now = Math.floor(Date.now() / 1000)
    const h = b64({ alg: 'ES256', typ: 'marver-assertion+jwt', kid: KID })
    const p = b64({
      iss: issuerUrl, aud: opts.aud, nonce: opts.nonce,
      sub: opts.sub ?? 'subject-e2e', email: opts.email ?? OWNER, email_verified: true,
      iat: now, nbf: now, exp: now + 300,
    })
    const s = createSign('SHA256')
    s.update(`${h}.${p}`)
    s.end()
    const sig = s.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
    return `${h}.${p}.${sig.toString('base64url')}`
  }

  beforeAll(async () => {
    const jwk = publicKey.export({ format: 'jwk' })
    const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] })
    issuer = createHttpServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.setHeader('content-type', 'application/json')
        return res.end(body)
      }
      res.statusCode = 404
      res.end('no')
    })
    await new Promise<void>((r) => issuer.listen(0, '127.0.0.1', r))
    const port = (issuer.address() as import('node:net').AddressInfo).port
    // http on loopback is the one non-https issuer normalizeIssuer allows, and
    // it exists precisely so the protocol can be developed and tested locally.
    issuerUrl = `http://localhost:${port}`

    canvas = await start({
      MARVER_ID_ISSUER: issuerUrl,
      MARVER_PUBLIC_ORIGIN: 'http://localhost:4788',
      MARVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'mv-e2e-')),
      MARVER_OWNER_EMAIL: OWNER,
      // Branding ON here, so the powered-by links have something to assert.
    }, 4788, true)
  }, 180_000)

  afterAll(async () => {
    canvas?.proc.kill()
    if (!issuer) return
    issuer.closeAllConnections?.()
    await new Promise<void>((r) => issuer.close(() => r()))
  })

  it('turns a signed assertion into a session that can actually WRITE', async () => {
    // 1. Start: a nonce, and the handle that owns it.
    const started = await fetch(`http://localhost:${canvas.port}/__mv/id/start`, { redirect: 'manual' })
    expect(started.status).toBe(302)
    const to = new URL(String(started.headers.get('location')))
    const nonce = to.searchParams.get('nonce')!
    expect(nonce).toBeTruthy()
    const handle = /(?:^|;\s*)mv_b=([\w-]+)/.exec(started.headers.getSetCookie().join('; '))?.[1]
    expect(handle, 'the browser handle must be issued by /start').toBeTruthy()

    // 2. The audience is this canvas, exactly as it named itself.
    const aud = to.searchParams.get('origin')!

    // 3. Callback: the assertion, from the browser that started it.
    const done = await fetch(`http://localhost:${canvas.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `mv_b=${handle}` },
      body: JSON.stringify({ assertion: assertionFor({ aud, nonce }) }),
    })
    expect(done.status, await done.text().catch(() => '')).toBe(200)

    const set = done.headers.getSetCookie().join('\n')
    expect(set, 'a session must be issued').toMatch(/(^|\n)mv_s=[\w.-]+/)
    // The regression this test exists for. Without mv_c the session is
    // read-only: collab.ts refuses every mutation that carries mv_s and no
    // matching x-mv-c.
    expect(set, 'mv_c must ride along, or every mutation 403s').toMatch(/(^|\n)mv_c=[\w-]+/)
    // It has to be readable by script - the browser echoes it back itself.
    const mvc = /(?:^|\n)mv_c=[^\n]*/.exec(set)![0]
    expect(mvc).not.toMatch(/HttpOnly/i)
    // And the handle is spent, not left lying around.
    expect(set).toMatch(/mv_b=;/)

    // Now actually WRITE, which is the thing the cookies are for and the thing
    // that was broken. Inspecting Set-Cookie proves the header; it does not
    // prove the session resolves, that the double-submit compare accepts the
    // pair, or that a mutation gets past collab.ts. Those were the three ways
    // this could still have been dead with both cookies present.
    const mvS = /(?:^|\n)mv_s=([^;]+)/.exec(set)![1]
    const mvC = /(?:^|\n)mv_c=([^;]+)/.exec(set)![1]
    const wrote = await fetch(`http://localhost:${canvas.port}/__mv/api/profile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `mv_s=${mvS}; mv_c=${mvC}`,
        'x-mv-c': mvC,
      },
      body: JSON.stringify({ name: 'Renamed By Test' }),
    })
    // Read the body ONCE - the failure message and the assertion both want it,
    // and a Response cannot be consumed twice.
    const wroteBody = await wrote.text()
    expect(wrote.status, wroteBody).toBe(200)
    expect(JSON.parse(wroteBody).user?.name).toBe('Renamed By Test')

    // The same mutation WITHOUT the echoed header must still be refused - the
    // CSRF check has to be doing its job, not merely be satisfiable.
    const forged = await fetch(`http://localhost:${canvas.port}/__mv/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `mv_s=${mvS}; mv_c=${mvC}` },
      body: JSON.stringify({ name: 'Should Not Apply' }),
    })
    expect(forged.status).toBe(403)
  }, 60_000)

  it('lets an identity-signed-in owner authorize a CLI, and then invite somebody', async () => {
    // The gap this closes. Managing people is a CLI job, the CLI used to sign in
    // with a password, and identity mode has no passwords - so an owner could
    // enter their own canvas and never add anybody to it. The device flow is the
    // answer, and it has to work HERE, on a canvas with no password at all.

    // Sign in the way a person does, and keep the session.
    const started = await fetch(`http://localhost:${canvas.port}/__mv/id/start`, { redirect: 'manual' })
    const to = new URL(String(started.headers.get('location')))
    const handle = /(?:^|;\s*)mv_b=([\w-]+)/.exec(started.headers.getSetCookie().join('; '))?.[1]
    const done = await fetch(`http://localhost:${canvas.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `mv_b=${handle}` },
      body: JSON.stringify({ assertion: assertionFor({ aud: to.searchParams.get('origin')!, nonce: to.searchParams.get('nonce')! }) }),
    })
    expect(done.status).toBe(200)
    const set = done.headers.getSetCookie().join('\n')
    const mvS = /(?:^|\n)mv_s=([^;]+)/.exec(set)![1]
    const mvC = /(?:^|\n)mv_c=([^;]+)/.exec(set)![1]

    // A terminal asks to be let in. No session, and it reaches this in front of
    // the gate - which is the entire point of it.
    const startRes = await fetch(`http://localhost:${canvas.port}/__mv/api/cli/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(startRes.status, 'a waiting CLI has no session and must still be able to ask').toBe(200)
    const start = await startRes.json() as any
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const poll = () => fetch(`http://localhost:${canvas.port}/__mv/api/cli/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    })
    expect((await poll()).status, 'nothing is granted until a person approves').toBe(202)

    // The device code alone must not be redeemable by knowing the SHORT code -
    // the one that travels in a URL and can be read over a shoulder.
    const guess = await fetch(`http://localhost:${canvas.port}/__mv/api/cli/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: start.userCode }),
    })
    expect(guess.status, 'the user code is not a device code').toBe(410)

    // A fetch cannot approve, even holding the right session. Authored frames
    // run same-origin, so anything fetch() can do, a frame can do silently -
    // and what it would walk away with here is a thirty-day bearer token.
    const byFetch = await fetch(`http://localhost:${canvas.port}/__mv/api/cli/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `mv_s=${mvS}; mv_c=${mvC}`, 'x-mv-c': mvC },
      body: new URLSearchParams({ code: start.userCode }).toString(),
    })
    expect(byFetch.status, 'a fetch must never approve').toBe(403)

    // The browser half: a real form submission from the approval page, which is
    // what the Sec-Fetch headers below describe. They are written by the
    // browser and cannot be set by page script, which is the whole point.
    const approved = await rawPost(
      canvas.port, '/__mv/api/cli/approve',
      new URLSearchParams({ code: start.userCode }).toString(),
      {
        cookie: `mv_s=${mvS}; mv_c=${mvC}`,
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
      },
    )
    expect(approved.status, approved.body).toBe(303)
    expect(String(approved.headers.location)).toContain('done=1')

    const got = await poll()
    expect(got.status).toBe(200)
    const { token, user } = await got.json() as any
    expect(user.email).toBe(OWNER)
    expect(token).toBeTruthy()

    // Spent - a device code redeems once.
    expect((await poll()).status).toBe(410)

    // And now the thing that was impossible: invite somebody, from the CLI's
    // own credential, on a canvas with no password.
    const invited = await fetch(`http://localhost:${canvas.port}/__mv/api/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'teammate@example.test' }),
    })
    const invitedBody = await invited.text()
    expect(invited.status, invitedBody).toBe(200)
    expect(JSON.parse(invitedBody).token, 'an invite link must come back').toBeTruthy()

    // Approval is ONE-SHOT. Last-writer-wins meant a second person approving
    // the same code before the terminal's next poll silently replaced the
    // first, and the terminal took whichever session landed last.
    const second = await fetch(`http://localhost:${canvas.port}/__mv/api/cli/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const s2 = await second.json() as any
    const approve = () => rawPost(
      canvas.port, '/__mv/api/cli/approve',
      new URLSearchParams({ code: s2.userCode }).toString(),
      {
        cookie: `mv_s=${mvS}; mv_c=${mvC}`,
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
      },
    )
    expect(String((await approve()).headers.location)).toContain('done=1')
    expect(String((await approve()).headers.location), 'a code cannot be approved twice').toContain('err=used')

    // Revocation too - the other half an owner needs.
    const revoked = await fetch(`http://localhost:${canvas.port}/__mv/api/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'teammate@example.test' }),
    })
    expect(revoked.status).toBe(200)
  }, 60_000)

  it('every powered-by badge is a real link, tagged with its own placement', async () => {
    // The finish page's footer was plain text - the mark and the words, linking
    // nowhere at all. Every other surface links to marver.design with
    // attribution, and a badge that is a link on three screens and inert on a
    // fourth is the sort of gap nobody notices until the numbers are wrong.
    const placements = new Set<string>()
    for (const [path, want] of [
      ['/', 'gate'],
      ['/__mv/id/finish', 'sign-in'],
      ['/__mv/cli?code=ABCD-2345', 'authorize-device'],
    ] as const) {
      const html = await (await fetch(`http://localhost:${canvas.port}${path}`)).text()
      const href = /href="(https:\/\/marver\.design\/\?[^"]*)"/.exec(html)?.[1]
      expect(href, `${path} must carry a real powered-by link`).toBeTruthy()
      const q = new URL(href!.replace(/&amp;/g, '&')).searchParams
      expect(q.get('utm_medium'), path).toBe('powered-by')
      expect(q.get('utm_source'), path).toBe('published-canvas')
      expect(q.get('utm_content'), path).toBe(want)
      placements.add(q.get('utm_content')!)
    }
    // Distinct placements, or attribution cannot tell the surfaces apart -
    // which is the entire reason utm_content exists.
    expect(placements.size).toBe(3)
  }, 30_000)

  it('the finish page waits quietly, and only speaks when something is wrong', async () => {
    // Painting the card first meant every successful sign-in flashed a panel
    // naming the canvas and its address on the way past - a screen nobody
    // needs, appearing and vanishing. Getting in says itself by the canvas
    // appearing; the card is for when there is something to READ.
    const html = await (await fetch(`http://localhost:${canvas.port}/__mv/id/finish`)).text()

    // BOTH ship hidden. The usual case is one POST, and a spinner that appears
    // and vanishes inside 200ms is a flicker rather than feedback - so the fast
    // path shows only the dotted ground, which is the ground the canvas itself
    // is drawn on.
    expect(html).toMatch(/<div class="card" id="card" hidden>/)
    expect(html).toMatch(/<div class="wait" id="wait"[^>]*hidden>/)
    // ...and the spinner is revealed on a timer, not immediately.
    expect(html).toMatch(/setTimeout\(function \(\) \{ wait\.hidden = false \}, 1500\)/)
    // A failure inside that window must cancel it, or the card arrives with a
    // spinner blinking on beside it.
    expect(html).toContain('clearTimeout(slow)')
    // Nothing pre-written into the state line - it used to say "Signing you
    // in..." in the markup, which is the flash even before any script runs.
    expect(html).toMatch(/<p class="state" id="s"><\/p>/)
    // And every path that shows the card goes through the same door.
    expect(html).toMatch(/function speak\(\)/)
    expect(html).toContain('wait.hidden = true')
  }, 30_000)

  it('refuses to be framed - the approval page and the finish page both', async () => {
    // An attacker starts a device flow of their own, frames the approval URL
    // under an unrelated button, and polls their device code once the victim
    // clicks. SameSite=Lax is no defence: a framed page on the same site still
    // carries its cookies. The only thing that stops it is refusing the frame.
    for (const path of ['/__mv/cli?code=ABCD-2345', '/__mv/id/finish']) {
      const res = await fetch(`http://localhost:${canvas.port}${path}`)
      expect(res.headers.get('x-frame-options'), path).toBe('DENY')
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'")
    }
  }, 30_000)

  it('refuses a second use of the same nonce', async () => {
    const started = await fetch(`http://localhost:${canvas.port}/__mv/id/start`, { redirect: 'manual' })
    const to = new URL(String(started.headers.get('location')))
    const nonce = to.searchParams.get('nonce')!
    const aud = to.searchParams.get('origin')!
    const handle = /(?:^|;\s*)mv_b=([\w-]+)/.exec(started.headers.getSetCookie().join('; '))?.[1]
    const send = () => fetch(`http://localhost:${canvas.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `mv_b=${handle}` },
      body: JSON.stringify({ assertion: assertionFor({ aud, nonce }) }),
    })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(401)
  }, 60_000)
})
