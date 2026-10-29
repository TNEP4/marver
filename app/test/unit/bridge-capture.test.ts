/**
 * The bridge's `mv:capture` invoke (spec 28 A4.6 #35), its own code with Electron, the adapter and the proof mocked:
 * an ask is admitted as the reports are - a canvas main frame, the admitted `doc`, trusted, on the canvas's origin - and
 * only for an instance that lists `capture`, else `untrusted` with no handler called; the rect inside the view and
 * rounded out, else `bounds`; an accepted ask reaches `onCapture`'s handler with the tab, the doc and a `still()` that
 * runs the same admission again; without a handler, `hidden`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CANVAS_CHANNELS, type CaptureRect } from '../../../src/shared/app-api.ts'

const w = vi.hoisted(() => ({
  handles: new Map<string, (e: unknown, msg: unknown) => unknown>(),
  nav: new Map<number, (e: unknown) => void>(),
  trusted: true,
  features: ['bridge', 'inset', 'capture'],
  origin: 'http://[::1]:5301',
  view: { width: 1280, height: 800 } as { width: number; height: number } | null,
}))
vi.mock('electron', () => ({
  app: {},
  ipcMain: { handle: (ch: string, fn: (e: unknown, msg: unknown) => unknown) => { w.handles.set(ch, fn) }, on: () => {} },
  webFrameMain: { fromId: () => undefined },
}))
vi.mock('../../src/main/nav.ts', () => {
  const adapters = new Map<number, unknown>()
  return {
    adapterFor: (id: number) => adapters.get(id),
    attachNav: (wc: { id: number }) => {
      const a = { on: (fn: (e: unknown) => void) => { w.nav.set(wc.id, fn); return () => {} }, commits: () => 1, frame: () => ({ processId: 1, routingId: 1 }) }
      adapters.set(wc.id, a)
      return a
    },
  }
})
vi.mock('../../src/main/proof.ts', () => ({
  isTrusted: () => w.trusted,
  targetOf: () => ({ entry: { instance: 'i1', origin: w.origin, features: w.features }, gen: () => 1 }),
  unsafePrefs: () => null,
}))
vi.mock('../../src/main/registry.ts', () => ({ appRegistry: () => null }))

import { installBridge, type Bridge } from '../../src/main/bridge.ts'

/** a fake frame and webContents: the canvas's main frame, the admit it was sent */
const frame = (processId = 1, routingId = 1) => {
  const f = { processId, routingId, origin: w.origin, parent: null, detached: false, sent: [] as unknown[], isDestroyed: () => false, send(_ch: string, m: unknown) { f.sent.push(m) } }
  return f
}
const contents = (id: number, main = frame()) => ({ id, mainFrame: main, isDestroyed: () => false, once() {}, on() {} })

let bridge: Bridge
let doc = ''
const main = frame()
const wc = contents(7, main)
const RECT = { x: 10.4, y: 20.7, width: 100.1, height: 50.5 }
const ask = (msg: unknown, sender: unknown = wc, senderFrame: unknown = main) => w.handles.get(CANVAS_CHANNELS.capture)!({ sender, senderFrame }, msg)

beforeAll(() => {
  bridge = installBridge({ viewSize: () => w.view })
  bridge.register(wc as never, 'canvas', 't1')
  w.nav.get(7)!({ kind: 'commit', gen: 1, url: `${w.origin}/`, attributed: true, instance: 'i1' })
  doc = (main.sent[0] as { doc: string }).doc
})

describe('mv:capture in the bridge (A4.6 #35)', () => {
  it('an accepted ask reaches the handler with its tab, doc and rect rounded out; still() runs the admission again', async () => {
    expect(doc).toMatch(/^[\w-]{20,}$/)
    let got: { tab: string; doc: string; rect: CaptureRect; still: () => boolean } | null = null
    bridge.onCapture(async (tab, d, rect, still) => { got = { tab, doc: d, rect, still }; return { ok: true, png: new Uint8Array([1]), width: 1, height: 1 } })
    expect(await ask({ doc, p: { rect: RECT } })).toEqual({ ok: true, png: new Uint8Array([1]), width: 1, height: 1 })
    expect(got!).toMatchObject({ tab: 't1', doc, rect: { x: 10, y: 20, width: 101, height: 52 } })
    expect(got!.still()).toBe(true)
    w.trusted = false
    expect(got!.still()).toBe(false)
    w.trusted = true
    w.features = ['bridge', 'inset']
    expect(got!.still()).toBe(false)
    w.features = ['bridge', 'inset', 'capture']
    expect(got!.still()).toBe(true)
  })

  it('refused untrusted, the handler never called: another doc, untrusted, an instance without capture, another frame, another origin, a view main did not make', async () => {
    let calls = 0
    bridge.onCapture(async () => { calls++; return { ok: false, why: 'empty' } })
    const untrusted = { ok: false, why: 'untrusted' }
    expect(await ask({ doc: 'B'.repeat(24), p: { rect: RECT } })).toEqual(untrusted)
    expect(await ask({ p: { rect: RECT } })).toEqual(untrusted)
    expect(await ask(null)).toEqual(untrusted)
    w.trusted = false
    expect(await ask({ doc, p: { rect: RECT } })).toEqual(untrusted)
    w.trusted = true
    w.features = ['bridge', 'inset', 'live', 'open']
    expect(await ask({ doc, p: { rect: RECT } })).toEqual(untrusted)
    w.features = ['bridge', 'inset', 'capture']
    expect(await ask({ doc, p: { rect: RECT } }, wc, frame(1, 2))).toEqual(untrusted)                 // a subframe
    expect(await ask({ doc, p: { rect: RECT } }, wc, { ...frame(), origin: 'http://evil.test' })).toEqual(untrusted)
    expect(await ask({ doc, p: { rect: RECT } }, contents(99))).toEqual(untrusted)                    // never registered
    expect(calls).toBe(0)
    expect(await ask({ doc, p: { rect: RECT } })).toEqual({ ok: false, why: 'empty' })
    expect(calls).toBe(1)
  })

  it('a rect outside the view, or of no size: bounds, the handler never called; no handler: hidden', async () => {
    let calls = 0
    bridge.onCapture(async () => { calls++; return { ok: false, why: 'empty' } })
    for (const rect of [{ x: 1200, y: 0, width: 81, height: 10 }, { x: -1, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 'a', y: 0, width: 1, height: 1 }]) {
      expect(await ask({ doc, p: { rect } }), JSON.stringify(rect)).toEqual({ ok: false, why: 'bounds' })
    }
    w.view = null
    expect(await ask({ doc, p: { rect: RECT } })).toEqual({ ok: false, why: 'bounds' })
    w.view = { width: 1280, height: 800 }
    expect(calls).toBe(0)
    bridge.onCapture(null)
    expect(await ask({ doc, p: { rect: RECT } })).toEqual({ ok: false, why: 'hidden' })
    // a handler that throws answers empty, never an invoke error
    bridge.onCapture(async () => { throw new Error('boom') })
    expect(await ask({ doc, p: { rect: RECT } })).toEqual({ ok: false, why: 'empty' })
  })
})
