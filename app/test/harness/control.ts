/**
 * One client for the app's test hooks (src/main/testing/), whichever harness launched it:
 * - the production-switch harness: newline-delimited JSON over the control socket (testing/control.ts);
 * - Playwright: `electronApp.evaluate` into `globalThis.__mvTest.call` in the main process.
 */
import { connect, type Socket } from 'node:net'
import type { ElectronApplication } from 'playwright-core'

export interface Control {
  call<T = unknown>(name: string, args?: unknown): Promise<T>
  close(): void
}

export function socketControl(path: string): Promise<Control> {
  return new Promise((ok, fail) => {
    const sock: Socket = connect(path)
    const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
    let next = 1
    let buf = ''
    let closed = false
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        const res = JSON.parse(line) as { id: number; ok: boolean; value?: unknown; error?: string }
        const w = waiting.get(res.id)
        waiting.delete(res.id)
        if (res.ok) w?.ok(res.value)
        else w?.fail(new Error(res.error))
      }
    })
    sock.on('close', () => { closed = true; for (const w of waiting.values()) w.fail(new Error('the control socket closed')); waiting.clear() })
    sock.once('error', fail)
    sock.once('connect', () => {
      sock.off('error', fail)
      sock.on('error', () => { /* reported through close */ })
      ok({
        call<T>(name: string, args?: unknown) {
          const id = next++
          if (closed) return Promise.reject(new Error('the control socket closed'))
          return new Promise<T>((res, rej) => {
            waiting.set(id, { ok: res as (v: unknown) => void, fail: rej })
            sock.write(JSON.stringify({ id, call: name, args: args ?? null }) + '\n')
          })
        },
        close: () => sock.end(),
      })
    })
  })
}

export function playwrightControl(app: ElectronApplication): Control {
  return {
    call<T>(name: string, args?: unknown) {
      return app.evaluate(async (_electron, [n, a]) => {
        const t = (globalThis as unknown as { __mvTest?: { call(n: string, a: unknown): Promise<unknown> } }).__mvTest
        if (!t) throw new Error('no test hooks: launch the dev build with MARVER_APP_TEST=1')
        return await t.call(n as string, a)
      }, [name, args ?? null] as const) as Promise<T>
    },
    close() {},
  }
}
