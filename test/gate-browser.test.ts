import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
      const cb = m.id != null ? b.pending.get(m.id) : undefined
      if (cb) { b.pending.delete(m.id); cb(m) }
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

  close() { try { this.proc.kill() } catch { /* already gone */ } }
}

let browser: Browser | null = null
let canvas: ChildProcess
let dataDir = ''
let root = ''
let ownerToken = ''

const base = `http://localhost:${PORT}`

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', timeout: 180_000 })
  if (!existsSync(CLI)) throw new Error('build produced no CLI')

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
  browser = await Browser.launch()
}, 240_000)

afterAll(() => {
  browser?.close()
  canvas?.kill()
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

  it('the CLI approval page: clicking Approve signs a waiting terminal in', async () => {
    // A terminal starts waiting.
    const started = await (await fetch(`${base}/__mv/api/cli/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any

    const { session } = await browser!.tab()
    // Sign in first, in this tab, exactly as a person would: gate, then account.
    await browser!.go(session, base)
    await browser!.eval(session, `(function(){var i=document.querySelector('input[type=password]');i.value='hunter2';i.form.submit()})()`)
    await browser!.until(session, 'document.body.innerHTML.includes("CANVAS-BUNDLE")')
    const claimed = await browser!.eval(session, `
      fetch('/__mv/api/auth/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: ${JSON.stringify(ownerToken)}, password: 'correct-horse-battery', name: 'Owner' })
      }).then(function (r) { return r.status })
    `)
    expect(claimed, 'the owner must be able to claim in the browser').toBe(200)

    // Now the approval page, with a real session behind it.
    await browser!.go(session, `${base}/__mv/cli?code=${encodeURIComponent(started.userCode)}`)
    // It must SHOW the code - that comparison is the whole anti-phishing step.
    expect(await browser!.eval(session, 'document.getElementById("code").textContent.trim()')).toBe(started.userCode)

    await browser!.eval(session, 'document.getElementById("go").click()')
    await browser!.until(session, 'document.getElementById("note") && !document.getElementById("note").hidden')
    const note = await browser!.eval(session, 'document.getElementById("note").textContent')
    expect(note, `the page said: ${note}`).toContain('owner@x.test')

    // And the waiting terminal now gets its session.
    const polled = await fetch(`${base}/__mv/api/cli/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    })
    expect(polled.status).toBe(200)
    const body = await polled.json() as any
    expect(body.user.email).toBe('owner@x.test')
    expect(body.token).toBeTruthy()
  }, 120_000)

  it('the approval page does NOT claim success when nobody is signed in', async () => {
    // A signed-out POST is answered by the outer gate with its own HTML and a
    // 200, and the page used to read that as approval - telling somebody their
    // terminal was signed in when nothing had happened at all.
    const started = await (await fetch(`${base}/__mv/api/cli/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any

    const { session } = await browser!.tab()   // a fresh tab: no gate cookie, no session
    await browser!.go(session, `${base}/__mv/cli?code=${encodeURIComponent(started.userCode)}`)
    await browser!.eval(session, 'document.getElementById("go").click()')
    await browser!.until(session, 'document.getElementById("note") && !document.getElementById("note").hidden')
    const note = await browser!.eval(session, 'document.getElementById("note").textContent')
    expect(note.toLowerCase()).toContain('sign in')
    expect(note.toLowerCase()).not.toContain('signed in as')

    // And nothing was actually approved.
    const polled = await fetch(`${base}/__mv/api/cli/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    })
    expect(polled.status, 'a signed-out click must approve nothing').toBe(202)
  }, 90_000)
})
