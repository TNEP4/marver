/**
 * A minimal CDP driver for suites that need a real browser - the same shape
 * gate-browser.test.ts uses, extracted so new suites do not re-grow it. Rides on the
 * server's own transport (src/server/cdp.ts): Chrome's debugging PIPE, so a browser a killed
 * vitest worker leaves behind dies with the worker instead of haunting the machine.
 * Chrome is optional on CI: `Browser.launch()` returns null when absent and
 * suites skip, exactly like the shot integration tests.
 */
import { Browser as Cdp, findChrome } from '../src/server/cdp.ts'

export class Browser {
  private cdp!: Cdp

  static async launch(): Promise<Browser | null> {
    if (!findChrome()) return null
    const b = new Browser()
    b.cdp = await Cdp.launch('mv-browser-')
    return b
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return this.cdp.send(method, params, sessionId)
  }

  private contexts = new Map<string, string>()   // sessionId -> browserContextId

  /** Grant browser permissions (e.g. clipboardReadWrite) to an origin in THIS tab's context -
   *  what a person's "Allow" click would have done. */
  grant(session: string, origin: string, permissions: string[]): Promise<void> {
    return this.send('Browser.grantPermissions', { origin, permissions, browserContextId: this.contexts.get(session) })
  }

  /** A trusted key press (CDP Input, not a synthetic DOM event) - it carries user activation,
   *  which clipboard writes require. `key` is the DOM key ('i', 'I'); shift adds the modifier. */
  async press(session: string, key: string, opts: { shift?: boolean } = {}): Promise<void> {
    const code = `Key${key.toUpperCase()}`
    const base = { key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: opts.shift ? 8 : 0 }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key }, session)
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, session)
  }

  /** A tab in its own browser context - an incognito window, effectively. */
  async tab(viewport?: { width: number; height: number }): Promise<string> {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: false })
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    this.contexts.set(sessionId, browserContextId)
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

  /** Ends the pipe (Chrome exits on EOF) and removes the profile once it has; callers need not await. */
  close() { void this.cdp.close() }
}
