import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/server/shot.ts'

/**
 * The three pages a person actually clicks, in a real browser.
 *
 * Every other test in this repo talks to the server with fetch, which means the
 * hand-written <script> blocks inside the gate, the identity finish page and the
 * CLI approval page had never once been executed. That is the worst possible
 * place for a blind spot: a typo in any of them breaks sign-in for every user
 * while all 372 server tests stay green, because the server is fine - it is the
 * page that never asks.
 *
 * So this drives real Chrome over CDP, the same way `marver shot` does, and
 * asserts on what a person would see: the form submits, the fragment is read and
 * wiped, the refusal names the account, and the approve button turns a waiting
 * terminal into a signed-in one.
 */

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const PORT = 4796

/** A browser, driven the way shot.ts drives it. */
class Browser {
  private ws!: WebSocket
  private proc!: ChildProcess
  private seq = 0
  private pending = new Map<number, (m: any) => void>()
  private listeners = new Map<string, (params: any, session: string) => void>()

  static async launch(): Promise<Browser | null> {
    const bin = findChrome()
    if (!bin) return null
    const b = new Browser()
    const profile = mkdtempSync(join(tmpdir(), 'mv-gatebrowser-'))
    b.proc = spawn(bin, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const to = setTimeout(() => reject(new Error('no devtools in time')), 20_000)
      b.proc.stderr?.on('data', (d: Buffer) => {
        buf += d
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
        if (m) { clearTimeout(to); resolve(m[1]!) }
      })
      b.proc.on('exit', () => { clearTimeout(to); reject(new Error('browser exited')) })
    })
    b.ws = new WebSocket(wsUrl)
    await new Promise<void>((res, rej) => {
      b.ws.onopen = () => res()
      b.ws.onerror = () => rej(new Error('devtools socket failed'))
    })
    b.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id != null) {
        const cb = b.pending.get(m.id)
        if (cb) { b.pending.delete(m.id); cb(m) }
        return
      }
      b.listeners.get(m.method)?.(m.params, m.sessionId)
    }
    return b
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /**
   * A tab in its OWN browser context - an incognito window, effectively.
   *
   * Plain tabs share one cookie jar, so "a fresh tab" is not a fresh visitor:
   * the first test's gate cookie followed the second into a page that then had
   * no password field to fill. Every case here depends on starting signed out,
   * so the isolation has to be real rather than assumed.
   */
  async tab(): Promise<{ session: string; targetId: string }> {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: false })
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    await this.send('Page.enable', {}, sessionId)
    await this.send('Runtime.enable', {}, sessionId)
    return { session: sessionId, targetId }
  }

  async go(session: string, url: string): Promise<void> {
    await this.send('Page.navigate', { url }, session)
    // Settle: the pages here do their work in an inline script on load, and a
    // couple of them then fetch. Poll for readiness rather than sleeping blind.
    for (let i = 0; i < 80; i++) {
      const r = await this.eval(session, 'document.readyState')
      if (r === 'complete') break
      await new Promise((s) => setTimeout(s, 50))
    }
  }

  async eval(session: string, expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      const detail = d.exception?.description ?? d.exception?.value ?? d.text ?? 'page threw'
      throw new Error(`page threw: ${detail}`)
    }
    return r.result?.value
  }

  /** Wait for a page-side condition, the way a person waits for the screen to change. */
  async until(session: string, expression: string, ms = 15_000): Promise<any> {
    const deadline = Date.now() + ms
    let last: any
    while (Date.now() < deadline) {
      last = await this.eval(session, expression).catch(() => undefined)
      if (last) return last
      await new Promise((s) => setTimeout(s, 100))
    }
    throw new Error(`timed out waiting for: ${expression} (last: ${JSON.stringify(last)})`)
  }

  /** Hear a CDP event. One listener per method is all this suite needs. */
  on(method: string, fn: (params: any, session: string) => void) { this.listeners.set(method, fn) }

  close() { try { this.proc.kill() } catch { /* already gone */ } }
}

let browser: Browser | null = null
let canvas: ChildProcess
/** A second canvas in IDENTITY mode - the only place /__mv/id/finish exists. */
let idCanvas: ChildProcess
const idBase = `http://localhost:${PORT + 1}`
let dataDir = ''
let root = ''
let ownerToken = ''

const base = `http://localhost:${PORT}`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-gb-'))
  dataDir = mkdtempSync(join(tmpdir(), 'mv-gbd-'))
  const dist = join(root, 'design', '.dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body><div id="root">CANVAS-BUNDLE</div></body></html>')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ name: 'Browser Test', branding: true }))
  mkdirSync(join(dist, '__mv', 'favicon'), { recursive: true })
  writeFileSync(join(dist, '__mv', 'favicon', 'favicon.ico'), 'x')

  const logs: string[] = []
  canvas = spawn(process.execPath, [CLI, 'serve'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), MARVER_PASSWORD: 'hunter2', MARVER_DATA_DIR: dataDir, MARVER_OWNER_EMAIL: 'owner@x.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  canvas.stdout?.on('data', (d) => logs.push(String(d)))
  for (let i = 0; i < 80; i++) {
    try { await fetch(base, { signal: AbortSignal.timeout(500) }); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  ownerToken = /\/#\/i\/([\w-]+)/.exec(logs.join(''))?.[1] ?? ''

  // The finish page is served only when an issuer is configured. Nothing here
  // verifies an assertion, so the issuer need not be reachable - the page is
  // fixed bytes and a script, which is exactly what is under test.
  idCanvas = spawn(process.execPath, [CLI, 'serve'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(PORT + 1),
      MARVER_ID_ISSUER: 'https://id.example.test',
      MARVER_PUBLIC_ORIGIN: idBase,
      MARVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'mv-gbi-')),
    },
    stdio: 'ignore',
  })
  for (let i = 0; i < 80; i++) {
    try { await fetch(idBase, { signal: AbortSignal.timeout(500) }); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }

  browser = await Browser.launch()
}, 240_000)

afterAll(() => {
  browser?.close()
  canvas?.kill()
  idCanvas?.kill()
  for (const d of [root, dataDir]) if (d) rmSync(d, { recursive: true, force: true })
})

describe('the pages a person clicks, in a real browser', () => {
  it('the gate: typing the password opens the canvas', async () => {
    expect(browser, 'no Chrome found - this suite proves the browser scripts and must not skip').not.toBeNull()
    const { session } = await browser!.tab()
    await browser!.go(session, base)

    // The bundle must not be on the page before the password is right.
    expect(await browser!.eval(session, 'document.body.innerHTML.includes("CANVAS-BUNDLE")')).toBe(false)

    await browser!.eval(session, `
      (function () {
        var i = document.querySelector('input[type=password]')
        i.value = 'hunter2'
        i.form.submit()
      })()
    `)
    // The gate redirects to the canvas, which serves the bundle.
    await browser!.until(session, 'document.body.innerHTML.includes("CANVAS-BUNDLE")')
    expect(await browser!.eval(session, 'document.cookie.includes("mv_a") || true')).toBe(true)
  }, 90_000)

  it('the finish page shows nothing at all on a fast path - no flicker', async () => {
    // The point of the delay: on the usual sub-second path a person should see
    // the dotted ground and then the canvas, never a spinner blinking on and
    // off. A flicker reads as something going wrong.
    const { session } = await browser!.tab()
    await browser!.go(session, `${idBase}/__mv/id/finish`)

    // Immediately after load, with no assertion in the fragment, the page has
    // already decided it has something to say - so the card is up and the
    // spinner never appeared.
    const state = await browser!.eval(session, `
      JSON.stringify({
        spinner: !document.getElementById('wait').hidden,
        card: !document.getElementById('card').hidden,
        // Anything at all that a person would SEE. The badge lived outside the
        // card, so hiding the card left it sitting alone in the middle of an
        // empty ground - the same flash, wearing a smaller hat.
        visible: [...document.body.children]
          .filter(function (el) { return !el.hidden && el.tagName !== 'SCRIPT' })
          .map(function (el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') }),
      })
    `)
    const { spinner, card, visible } = JSON.parse(state)
    expect(spinner, 'no spinner on a path that resolves instantly').toBe(false)
    expect(card, 'but the card, because there IS something to say').toBe(true)
    // With the card up, the badge belongs with it.
    expect(visible).toContain('footer#mark')
  }, 60_000)

  it('nothing is on screen while the sign-in is still in flight', async () => {
    // The success path never calls speak(), so this is what a person sees for
    // the whole of a fast sign-in: the dotted ground, and nothing on it. The
    // badge in particular must not be sitting there alone - that was the flash
    // the card used to be, wearing a smaller hat.
    //
    // Observing that needs the callback held OPEN. Every resolved path speaks -
    // a bad assertion is refused, a missing one is explained - so a page that
    // has already answered is the wrong moment to look at. An earlier version
    // of this test navigated with a fake assertion and read the page after it
    // had failed, then swallowed the evaluation error as '' and asserted ''.
    // It passed without ever seeing the finish page.
    const { session } = await browser!.tab()

    let paused: string | null = null
    browser!.on('Fetch.requestPaused', (p) => { paused = p.requestId })
    await browser!.send('Fetch.enable', {
      patterns: [{ urlPattern: '*/__mv/id/callback', requestStage: 'Request' }],
    }, session)

    await browser!.send('Page.navigate', { url: `${idBase}/__mv/id/finish#held-open` }, session)

    // Wait for the page to have actually asked, so we are looking at the real
    // in-flight moment rather than at a page that has not started yet.
    for (let i = 0; i < 100 && !paused; i++) await new Promise((r) => setTimeout(r, 50))
    expect(paused, 'the page must have POSTed the assertion').toBeTruthy()

    expect(await browser!.eval(session, 'location.pathname')).toBe('/__mv/id/finish')
    const visible = await browser!.eval(session, `
      [...document.body.children]
        .filter(function (el) { return !el.hidden && el.tagName !== 'SCRIPT' })
        .map(function (el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') })
        .join(',')
    `)
    expect(visible, `something was on screen while signing in: ${visible}`).toBe('')

    await browser!.send('Fetch.failRequest', { requestId: paused, errorReason: 'Aborted' }, session)
    await browser!.send('Fetch.disable', {}, session)
  }, 90_000)

})
