/**
 * The bridge's half of spec 32 C2 (src/main/bridge.ts), with Electron, the proof and the navigation adapter mocked, as
 * bridge-show.test.ts does: `mv:immersive`, immersive play's wish, is a fifth canvas report - admitted only from the tab's
 * admitted, trusted document on its origin, checked by `checkImmersive` (`on` a boolean, `n` an integer 1..2^31, unknown
 * fields stripped), held in `reports().immersive` and handed to `onReport`; `immersiveState` is main's one sender of
 * the answer, `mv:immersive-state { doc, n, on, end? }`, only to the document named while it is the tab's admitted,
 * trusted one - never another document, an untrusted one, or a tab with none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_CHANNELS } from '../../../src/shared/app-api.ts'

const m = vi.hoisted(() => ({
  on: new Map<string, (e: unknown, msg: unknown) => void>(),
  sent: [] as { ch: string; p: unknown }[],
  navFns: new Map<number, (e: unknown) => void>(),
  commits: 1,
  trusted: true,
  features: ['bridge', 'inset', 'live', 'open', 'capture', 'show'] as string[],
}))
const frame = { processId: 1, routingId: 1, isDestroyed: () => false, detached: false, parent: null, origin: 'http://[::1]:5301', url: 'http://[::1]:5301/', send: (ch: string, p: unknown) => { m.sent.push({ ch, p }) } }
vi.mock('electron', () => ({
  ipcMain: { on: (ch: string, fn: (e: unknown, msg: unknown) => void) => { m.on.set(ch, fn) }, handle: () => {} },
  webFrameMain: { fromId: () => frame },
  app: { getName: () => 'Marver Dev', getVersion: () => '0.3.0', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
}))
vi.mock('../../src/main/nav.ts', () => ({
  attachNav: (wc: { id: number }) => ({ on: (fn: (e: unknown) => void) => { m.navFns.set(wc.id, fn) } }),
  adapterFor: () => ({ commits: () => m.commits, frame: () => ({ processId: 1, routingId: 1 }) }),
}))
vi.mock('../../src/main/proof.ts', () => ({
  isTrusted: () => m.trusted,
  targetOf: () => ({ entry: { origin: 'http://[::1]:5301', features: m.features } }),
  unsafePrefs: () => null,
}))
vi.mock('../../src/main/registry.ts', () => ({ appRegistry: () => null }))

const wc = { id: 7, isDestroyed: () => false, once: () => {}, on: () => {}, mainFrame: frame }

type Bridge = ReturnType<typeof import('../../src/main/bridge.ts')['installBridge']>
let bridge: Bridge
let journal: () => Promise<{ topic: string; data: Record<string, unknown> }[]>

beforeEach(async () => {
  vi.resetModules()
  process.env.MARVER_APP_TEST = '1'   // the journal (testing/index.ts) - a dev build's test mode
  m.on.clear(); m.sent.length = 0; m.navFns.clear(); m.commits = 1; m.trusted = true; m.features = ['bridge', 'inset', 'live', 'open', 'capture', 'show']
  const t = await import('../../src/main/testing/index.ts')
  t.startTesting()
  journal = async () => (await t.callHook('log', {})) as { topic: string; data: Record<string, unknown> }[]
  bridge = (await import('../../src/main/bridge.ts')).installBridge()
  bridge.register(wc as never, 'canvas', 't1')
  m.navFns.get(7)!({ kind: 'commit', attributed: true })   // the trusted commit: admitted
  delete process.env.MARVER_APP_TEST
})

const docOf = () => (m.sent.find((s) => s.ch === CANVAS_CHANNELS.admit)!.p as { doc: string }).doc
const answers = () => m.sent.filter((s) => s.ch === CANVAS_CHANNELS.immersiveState).map((s) => s.p)
const event = (o: { frame?: unknown } = {}) => ({ sender: wc, senderFrame: o.frame ?? frame })

describe('checkImmersive (spec 32 C2)', () => {
  it('on a boolean, n an integer 1..2^31; unknown fields stripped; anything else refused', async () => {
    const { checkImmersive } = await import('../../src/main/bridge.ts')
    expect(checkImmersive({ on: true, n: 1, doc: 'x', end: true })).toEqual({ on: true, n: 1 })
    expect(checkImmersive({ on: false, n: 2 ** 31 })).toEqual({ on: false, n: 2 ** 31 })
    for (const bad of [null, [], {}, { on: true }, { n: 1 }, { on: 'true', n: 1 }, { on: 1, n: 1 }, { on: true, n: 0 }, { on: true, n: -1 }, { on: true, n: 1.5 }, { on: true, n: 2 ** 31 + 1 }, { on: true, n: '1' }, { on: true, n: Infinity }]) {
      expect(checkImmersive(bad), JSON.stringify(bad)).toBe(null)
    }
  })
})

describe('mv:immersive, the wish (spec 32 C2)', () => {
  it('a held report from the admitted, trusted document: stored whole, the latest kept, handed to onReport; anything else refused', async () => {
    const heard: unknown[] = []
    bridge.onReport((tab, doc, r) => { heard.push({ tab, doc, immersive: r.immersive }) })
    process.env.MARVER_APP_TEST = '1'
    try {
      const on = m.on.get(CANVAS_CHANNELS.immersive)!
      expect(on, 'the generic report handler admits it').toBeTypeOf('function')
      on(event(), { doc: docOf(), p: { on: true, n: 1, extra: 'x' } })
      expect(bridge.reports('t1')?.immersive).toEqual({ on: true, n: 1 })
      on(event(), { doc: docOf(), p: { on: false, n: 2 } })
      expect(bridge.reports('t1')?.immersive).toEqual({ on: false, n: 2 })
      on(event(), { doc: 'B'.repeat(22), p: { on: true, n: 3 } })                    // another document's
      on(event({ frame: { ...frame, routingId: 2 } }), { doc: docOf(), p: { on: true, n: 3 } })
      on(event(), { doc: docOf(), p: { on: true, n: 0 } })                         // past its bound
      m.trusted = false
      on(event(), { doc: docOf(), p: { on: true, n: 3 } })
      expect(bridge.reports('t1')?.immersive).toEqual({ on: false, n: 2 })
      expect(heard).toEqual([{ tab: 't1', doc: docOf(), immersive: { on: true, n: 1 } }, { tab: 't1', doc: docOf(), immersive: { on: false, n: 2 } }])
      const lines = (await journal()).filter((l) => l.topic === 'bridge' && l.data.ch === 'immersive').map((l) => [l.data.event, l.data.why ?? null])
      expect(lines).toEqual([['accepted', null], ['accepted', null], ['refused', 'not the admitted document'], ['refused', 'not the main frame'], ['refused', 'payload'], ['refused', 'untrusted']])
    } finally { delete process.env.MARVER_APP_TEST }
  })
  it('a new commit starts with no wish (the report resets with the document)', () => {
    m.on.get(CANVAS_CHANNELS.immersive)!(event(), { doc: docOf(), p: { on: true, n: 1 } })
    expect(bridge.reports('t1')?.immersive).toEqual({ on: true, n: 1 })
    m.commits = 2
    m.navFns.get(7)!({ kind: 'commit', attributed: true })
    expect(bridge.reports('t1')?.immersive).toBeUndefined()
  })
})

describe('immersiveState, the answer (spec 32 C2)', () => {
  it('to the document named while it is the admitted, trusted one: { doc, n, on } and `end` only when true', () => {
    expect(bridge.immersiveState('t1', docOf(), { n: 1, on: true })).toBe(true)
    expect(bridge.immersiveState('t1', docOf(), { n: 3, on: false, end: true })).toBe(true)
    expect(answers()).toEqual([{ doc: docOf(), n: 1, on: true }, { doc: docOf(), n: 3, on: false, end: true }])
  })
  it('nothing to another document, a tab with no document, an untrusted document, or a later document than the one named', () => {
    const was = docOf()
    expect(bridge.immersiveState('t1', 'B'.repeat(22), { n: 1, on: true })).toBe(false)
    expect(bridge.immersiveState('t2', was, { n: 1, on: true })).toBe(false)
    m.trusted = false
    expect(bridge.immersiveState('t1', was, { n: 1, on: true })).toBe(false)
    m.trusted = true
    m.commits = 2
    m.navFns.get(7)!({ kind: 'commit', attributed: true })   // a new document: the old doc's answer goes nowhere
    expect(bridge.immersiveState('t1', was, { n: 1, on: false })).toBe(false)
    expect(answers()).toEqual([])
  })
})
