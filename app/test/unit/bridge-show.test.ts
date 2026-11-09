/**
 * The bridge's half of spec 31 D1 and D3 (src/main/bridge.ts), with Electron, the proof and the navigation adapter
 * mocked: `showItem` sends `mv:show { doc, p }` only to a tab's admitted, trusted document whose instance lists `show`,
 * the target checked as the preload checks it (shared/deep-link.ts); `mv:front` - the shell showed a `marver show` - is
 * accepted only from that document, stamped with its `doc`, its instance listing `show`, at most once a second, and
 * handed to `onFront` with the tab main knows the sender by (never a tab the page names).
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
const shows = () => m.sent.filter((s) => s.ch === CANVAS_CHANNELS.show).map((s) => s.p)

describe('mv:show (spec 31 D1)', () => {
  it('to the admitted, trusted document of an instance listing show: { doc, p }, the target stripped to its known fields', () => {
    expect(bridge.showItem('t1', { board: 'main', f: ['demo/one'], n: ['demo/one@390'], extra: 'x' } as never)).toBe(true)
    expect(shows()).toEqual([{ doc: docOf(), p: { board: 'main', f: ['demo/one'], n: ['demo/one@390'] } }])
    // the canvas's own board: `p: null` on the wire
    expect(bridge.showItem('t1', 'landing')).toBe(true)
    expect(shows().at(-1)).toEqual({ doc: docOf(), p: null })
  })

  it('home:action copy-update is admitted with a tab id alone (E4) - what Home\'s button sends', async () => {
    const { checkPagePayload } = await import('../../src/main/bridge.ts')
    expect(checkPagePayload('home:action', { action: 'copy-update', id: 't3', root: '/etc' })).toEqual({ ok: true, value: { action: 'copy-update', id: 't3' } })
    expect(checkPagePayload('home:action', { action: 'copy-update', id: '../x' }).ok).toBe(false)
    expect(checkPagePayload('home:action', { action: 'copy-update' }).ok).toBe(false)
  })

  it('nothing to a tab with no document, an instance without show, an untrusted document, or for a target off the grammar', () => {
    expect(bridge.showItem('t2', { board: 'main' })).toBe(false)
    m.features = ['bridge', 'inset', 'live', 'open', 'capture']
    expect(bridge.showItem('t1', { board: 'main' })).toBe(false)
    m.features = ['bridge', 'inset', 'live', 'open', 'capture', 'show']
    for (const bad of [{ board: 'Main' }, { board: 'main', f: ['../x'] }, { board: 'main', c: '<b>' }, { board: 'main', f: 'demo/one' }]) expect(bridge.showItem('t1', bad as never), JSON.stringify(bad)).toBe(false)
    m.trusted = false
    expect(bridge.showItem('t1', { board: 'main' })).toBe(false)
    expect(shows()).toEqual([])
  })
})

describe('mv:front (spec 31 D3)', () => {
  const event = (o: { frame?: unknown } = {}) => ({ sender: wc, senderFrame: o.frame ?? frame })
  it('the admitted document, its instance listing show, once a second: onFront hears its own tab; anything else is refused', async () => {
    const heard: string[] = []
    bridge.onFront((tab) => { heard.push(tab) })
    process.env.MARVER_APP_TEST = '1'
    try {
      const on = m.on.get(CANVAS_CHANNELS.front)!
      on(event(), { doc: docOf(), tab: 't9' })
      on(event(), { doc: docOf() })                                   // within the second: refused
      on(event(), { doc: 'B'.repeat(22) })
      on(event({ frame: { ...frame, routingId: 2 } }), { doc: docOf() })
      m.features = ['bridge', 'inset', 'live', 'open', 'capture']
      on(event(), { doc: docOf() })
      m.features = ['bridge', 'inset', 'live', 'open', 'capture', 'show']
      m.trusted = false
      on(event(), { doc: docOf() })
      expect(heard).toEqual(['t1'])
      const lines = (await journal()).filter((l) => l.topic === 'bridge' && l.data.ch === 'front').map((l) => [l.data.event, l.data.why ?? l.data.tab])
      expect(lines).toEqual([['accepted', 't1'], ['refused', 'rate'], ['refused', 'not the admitted document'], ['refused', 'not the main frame'], ['refused', 'no show'], ['refused', 'untrusted']])
    } finally { delete process.env.MARVER_APP_TEST }
  })
})
