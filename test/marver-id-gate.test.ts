import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
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
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mv-gate-'))
  const dist = join(root, 'design', '.dist')
  mkdirSync(dist, { recursive: true })
  // The marker below stands in for the real bundle: if a response contains it,
  // the canvas was served, which pre-auth is exactly the failure we are hunting.
  writeFileSync(join(dist, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ name: 'Fixture', branding: false }))
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

async function start(env: Record<string, string>, port: number): Promise<Canvas> {
  const root = fixture()
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
    expect(ha).not.toContain('https://')
    // And it names the refusal a person is most likely to hit.
    expect(ha).toContain('has not been invited')
  })

  it('identity mode: /finish is never cached and never leaks a referrer', async () => {
    // A cached finish page would replay somebody else's sign-in screen, and a
    // referrer would carry this canvas's address to wherever they click next.
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/finish`)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

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

  it('identity mode: forwarded headers cannot change the audience', async () => {
    const res = await raw(identity.port, '/__mv/id/start', {
      'x-forwarded-host': 'attacker.test',
      'x-forwarded-proto': 'https',
    })
    expect(res.status).toBe(302)
    // The origin is this canvas on the port we actually reached it on - whichever
    // loopback spelling the client used - and never anything a caller asserted.
    const named = new URL(String(res.headers.location)).searchParams.get('origin')!
    expect(named).toMatch(new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${identity.port}$`))
    expect(res.body).not.toContain('attacker.test')
  })

})
