/**
 * The bridge's half of a notice's click (src/main/bridge.ts; spec 28 A4.6 #29), with Electron, the proof and the
 * navigation adapter mocked: `openItem` sends `mv:open { doc, item }` only to a tab's admitted, trusted document whose
 * instance lists `open`, the item checked and stripped as the preload checks it; `mv:opened` is accepted only from
 * that document, stamped with its `doc`, and journaled. And `settings:action`'s payload (bridge.test.ts) is checked
 * by the same open-item.ts rule's neighbour: only `open-notification-settings`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_CHANNELS, type OpenItem } from '../../../src/shared/app-api.ts'
import { checkOpened, checkOpenItem } from '../../src/shared/open-item.ts'

const m = vi.hoisted(() => ({
  on: new Map<string, (e: unknown, msg: unknown) => void>(),
  sent: [] as { ch: string; p: unknown }[],
  navFns: new Map<number, (e: unknown) => void>(),
  commits: 1,
  trusted: true,
  features: ['bridge', 'inset', 'live', 'open'] as string[],
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

const ITEM: OpenItem = { id: `ask:${'0'.repeat(20)}`, kind: 'ask', board: 'main', thread: 't1', msg: 'm1' }
const wc = { id: 7, isDestroyed: () => false, once: () => {}, on: () => {}, mainFrame: frame }

type Bridge = ReturnType<typeof import('../../src/main/bridge.ts')['installBridge']>
let bridge: Bridge
let journal: () => Promise<{ topic: string; data: Record<string, unknown> }[]>

beforeEach(async () => {
  vi.resetModules()
  process.env.MARVER_APP_TEST = '1'   // the journal (testing/index.ts) - a dev build's test mode
  m.on.clear(); m.sent.length = 0; m.navFns.clear(); m.commits = 1; m.trusted = true; m.features = ['bridge', 'inset', 'live', 'open']
  const t = await import('../../src/main/testing/index.ts')
  t.startTesting()
  journal = async () => (await t.callHook('log', {})) as { topic: string; data: Record<string, unknown> }[]
  bridge = (await import('../../src/main/bridge.ts')).installBridge()
  bridge.register(wc as never, 'canvas', 't1')
  m.navFns.get(7)!({ kind: 'commit', attributed: true })   // the trusted commit: admitted
  delete process.env.MARVER_APP_TEST
})

const docOf = () => (m.sent.find((s) => s.ch === CANVAS_CHANNELS.admit)!.p as { doc: string }).doc
const opens = () => m.sent.filter((s) => s.ch === CANVAS_CHANNELS.open).map((s) => s.p)

describe('mv:open (A4.6 #29)', () => {
  it('to the admitted, trusted document of an instance listing open: { doc, item }, the item stripped to its known fields', () => {
    expect(bridge.openItem('t1', { ...ITEM, title: 'never sent', at: 3 } as OpenItem)).toBe(true)
    expect(opens()).toEqual([{ doc: docOf(), item: ITEM }])
  })

  it('nothing to a tab with no document, an untrusted one, an instance without open, or for an item that fails the check', () => {
    expect(bridge.openItem('t2', ITEM)).toBe(false)
    m.features = ['bridge', 'inset', 'live']
    expect(bridge.openItem('t1', ITEM)).toBe(false)
    m.features = ['bridge', 'inset', 'live', 'open']
    expect(bridge.openItem('t1', { ...ITEM, id: 'ask:short' })).toBe(false)
    expect(bridge.openItem('t1', { ...ITEM, cards: Array.from({ length: 9 }, (_, i) => `c${i}`) })).toBe(false)
    m.trusted = false
    expect(bridge.openItem('t1', ITEM)).toBe(false)
    expect(opens()).toEqual([])
  })
})

describe('mv:opened (A4.6 #29)', () => {
  const event = (o: { frame?: unknown } = {}) => ({ sender: wc, senderFrame: o.frame ?? frame })
  it('accepted from the admitted document, stamped with its doc, and journaled; another doc, a subframe or a bad payload refused', async () => {
    process.env.MARVER_APP_TEST = '1'
    try {
      const on = m.on.get(CANVAS_CHANNELS.opened)!
      on(event(), { doc: docOf(), p: { id: ITEM.id, result: 'handled', more: 1 } })
      on(event(), { doc: 'B'.repeat(22), p: { id: ITEM.id, result: 'handled' } })
      on(event({ frame: { ...frame, routingId: 2 } }), { doc: docOf(), p: { id: ITEM.id, result: 'handled' } })
      on(event(), { doc: docOf(), p: { id: ITEM.id, result: 'done' } })
      on(event(), { doc: docOf(), p: { id: 'nope', result: 'stale' } })
      m.trusted = false
      on(event(), { doc: docOf(), p: { id: ITEM.id, result: 'stale' } })
      const lines = (await journal()).filter((l) => l.topic === 'bridge' && l.data.ch === 'opened').map((l) => [l.data.event, l.data.result ?? l.data.why])
      expect(lines).toEqual([['accepted', 'handled'], ['refused', 'not the admitted document'], ['refused', 'not the main frame'], ['refused', 'payload'], ['refused', 'payload'], ['refused', 'untrusted']])
    } finally { delete process.env.MARVER_APP_TEST }
  })
})

describe('the checks both sides use (open-item.ts)', () => {
  it('an item: its kind, the id pattern, the board and refs within bounds, at most 8 cards, whole gen and occ', () => {
    expect(checkOpenItem({ ...ITEM, gen: 0, occ: 3, cards: ['a'], batch: 'b', extra: 1 })).toEqual({ ...ITEM, gen: 0, occ: 3, cards: ['a'], batch: 'b' })
    for (const bad of [null, [], { ...ITEM, kind: 'stopped' }, { ...ITEM, id: `review:${'0'.repeat(20)}x` }, { ...ITEM, board: '' }, { ...ITEM, board: 'b'.repeat(129) },
      { ...ITEM, thread: '' }, { ...ITEM, msg: 'a\u0007' }, { ...ITEM, cards: 'c1' }, { ...ITEM, cards: [1] }, { ...ITEM, gen: -1 }, { ...ITEM, occ: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(checkOpenItem(bad), JSON.stringify(bad)).toBeNull()
    }
  })
  it('an answer: an id and one of the five results', () => {
    expect(checkOpened({ id: ITEM.id, result: 'dropped', x: 1 })).toEqual({ id: ITEM.id, result: 'dropped' })
    expect(checkOpened({ id: ITEM.id, result: 'ok' })).toBeNull()
    expect(checkOpened({ id: 'x', result: 'busy' })).toBeNull()
  })
})
