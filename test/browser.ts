/**
 * A minimal CDP driver for suites that need a real browser - the same shape
 * gate-browser.test.ts uses, extracted so new suites do not re-grow it.
 * Chrome is optional on CI: `Browser.launch()` returns null when absent and
 * suites skip, exactly like the shot integration tests.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/server/shot.ts'

export class Browser {
  private ws!: WebSocket
  private proc!: ChildProcess
  private seq = 0
  private pending = new Map<number, (m: any) => void>()

  static async launch(): Promise<Browser | null> {
    const bin = findChrome()
    if (!bin) return null
    const b = new Browser()
    const profile = mkdtempSync(join(tmpdir(), 'mv-browser-'))
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
      }
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

  /** A tab in its own browser context - an incognito window, effectively. */
  async tab(viewport?: { width: number; height: number }): Promise<string> {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: false })
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    await this.send('Page.enable', {}, sessionId)
    await this.send('Runtime.enable', {}, sessionId)
    if (viewport) await this.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 500 }, sessionId)
    return sessionId
  }

  async go(session: string, url: string): Promise<void> {
    await this.send('Page.navigate', { url }, session)
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
      throw new Error(`page threw: ${d.exception?.description ?? d.exception?.value ?? d.text ?? 'page threw'}`)
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
