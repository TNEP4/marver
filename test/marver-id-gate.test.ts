import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
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
const built = existsSync(CLI)

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

const bundleServed = (html: string) => html.includes('id="root"') && html.includes('type="module"')

describe.skipIf(!built)('gate providers - three modes, one server each', () => {
  let open: Canvas, password: Canvas, identity: Canvas

  beforeAll(async () => {
    ;[open, password, identity] = await Promise.all([
      start({}, 4471),
      start({ MARVER_PASSWORD: 'hunter2', MARVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'mv-d1-')) }, 4472),
      start({
        MARVER_ID_ISSUER: 'https://id.example.test',
        MARVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'mv-d2-')),
        MARVER_OWNER_EMAIL: 'owner@example.test',
      }, 4473),
    ])
  }, 60_000)

  afterAll(() => [open, password, identity].forEach((c) => c && stop(c)))

  it('no gate configured: serves the canvas, as it always has', async () => {
    const html = await (await fetch(`http://localhost:${open.port}/`)).text()
    expect(bundleServed(html)).toBe(true)
  })

  it('password mode: the bundle is NEVER sent pre-auth', async () => {
    const html = await (await fetch(`http://localhost:${password.port}/`)).text()
    expect(bundleServed(html)).toBe(false)
    expect(html).toContain('name="password"')
  })

  it('password mode: the identity endpoints do not open a hole', async () => {
    // They must not exist here, and above all must not become a path that skips
    // the gate - a bypass is a bypass even when the handler behind it is absent.
    for (const p of ['/__mv/id/start', '/__mv/id/callback', '/__mv/id/anything']) {
      const html = await (await fetch(`http://localhost:${password.port}${p}`)).text()
      expect(bundleServed(html)).toBe(false)
    }
  })

  it('identity mode: the bundle is never sent pre-auth, and no password is asked for', async () => {
    const html = await (await fetch(`http://localhost:${identity.port}/`)).text()
    expect(bundleServed(html)).toBe(false)
    expect(html).not.toContain('name="password"')
    expect(html).toContain('id-go')
  })

  it('identity mode: /start issues a distinct nonce per request, bound to this canvas', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://localhost:${identity.port}/__mv/id/start`)
      expect(res.status).toBe(200)
      const { authorize } = (await res.json()) as { authorize: string }
      const u = new URL(authorize)
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

  it('identity mode: the refusal never says WHY', async () => {
    // "expired" vs "wrong audience" would turn this endpoint into a debugger for
    // whoever is probing it. The reason belongs in the operator's logs.
    const res = await fetch(`http://localhost:${identity.port}/__mv/id/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: 'a.b.c' }),
    })
    const body = await res.text()
    for (const leak of ['aud', 'iss', 'signature', 'nonce', 'expired']) {
      expect(body).not.toContain(leak)
    }
  })
})
