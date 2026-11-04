/**
 * `mv:menu-click`'s `in` on its way to the shell (spec 30 #51, app-api.ts `MenuClick`), with Electron, the proof and the
 * navigation adapter mocked: the bridge sends the menu it was told, and the canvas preload passes on `in` only when it is
 * one of `MENU_IN` - from app 1.0.0, or with anything else, the page hears `{ id }` and the shell records `in: 'app'`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_CHANNELS } from '../../../src/shared/app-api.ts'

const m = vi.hoisted(() => ({
  on: new Map<string, (e: unknown, msg: unknown) => void>(),
  sent: [] as { ch: string; p: unknown }[],
  navFns: new Map<number, (e: unknown) => void>(),
  answer: { reopen: false } as unknown,
  exposed: null as Record<string, unknown> | null,
}))
const frame = { processId: 1, routingId: 1, isDestroyed: () => false, detached: false, parent: null, origin: 'http://[::1]:5301', url: 'http://[::1]:5301/', send: (ch: string, p: unknown) => { m.sent.push({ ch, p }) } }
vi.mock('electron', () => ({
  ipcMain: { on: (ch: string, fn: (e: unknown, msg: unknown) => void) => { m.on.set(ch, fn) }, handle: () => {} },
  webFrameMain: { fromId: () => frame },
  app: { getName: () => 'Marver Dev', getVersion: () => '0.3.0', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
  contextBridge: { exposeInMainWorld: (_k: string, api: Record<string, unknown>) => { m.exposed = api } },
  ipcRenderer: { sendSync: () => m.answer, send: () => {}, invoke: async () => null, on: (ch: string, fn: (e: unknown, msg: unknown) => void) => { m.on.set(`r:${ch}`, fn) } },
}))
vi.mock('../../src/main/nav.ts', () => ({
  attachNav: (wc: { id: number }) => ({ on: (fn: (e: unknown) => void) => { m.navFns.set(wc.id, fn) } }),
  adapterFor: () => ({ commits: () => 1, frame: () => ({ processId: 1, routingId: 1 }) }),
}))
vi.mock('../../src/main/proof.ts', () => ({
  isTrusted: () => true,
  targetOf: () => ({ entry: { origin: 'http://[::1]:5301', features: ['bridge'] } }),
  unsafePrefs: () => null,
}))
vi.mock('../../src/main/registry.ts', () => ({ appRegistry: () => null }))

const wc = { id: 7, isDestroyed: () => false, once: () => {}, on: () => {}, mainFrame: frame }

describe('the bridge sends the menu it was told (#51)', () => {
  beforeEach(() => { m.sent.length = 0; m.navFns.clear() })
  it('with `where`, in `in`; without, no `in`', async () => {
    const bridge = (await import('../../src/main/bridge.ts')).installBridge()
    bridge.register(wc as never, 'canvas', 't1')
    m.navFns.get(7)!({ kind: 'commit', attributed: true })
    const doc = (m.sent.find((s) => s.ch === CANVAS_CHANNELS.admit)!.p as { doc: string }).doc
    m.sent.length = 0
    bridge.menuClick('t1', 'mark-all-seen', 'tab-menu')
    bridge.menuClick('t1', 'mark-all-seen', 'menu')
    bridge.menuClick('t1', 'mark-all-seen')
    expect(m.sent.map((s) => s.p)).toEqual([{ doc, id: 'mark-all-seen', in: 'tab-menu' }, { doc, id: 'mark-all-seen', in: 'menu' }, { doc, id: 'mark-all-seen' }])
  })
})

describe('the preload passes `in` through, checked against MENU_IN (#51)', () => {
  const DOC = 'A'.repeat(22)
  it('the page hears { id, in }; an unknown or absent `in` is not passed on', async () => {
    ;(globalThis as unknown as { location: unknown }).location = { origin: 'http://[::1]:5301' }
    await import('../../src/preload/canvas.ts')
    const api = m.exposed as unknown as { onMenuClick(fn: (p: unknown) => void): () => void }
    const heard: unknown[] = []
    api.onMenuClick((p) => heard.push(p))
    const main = (ch: string, msg: unknown) => m.on.get(`r:${ch}`)!({}, msg)
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    main(CANVAS_CHANNELS.menuClick, { doc: DOC, id: 'mark-all-seen', in: 'tab-menu' })
    main(CANVAS_CHANNELS.menuClick, { doc: DOC, id: 'fit-all', in: 'menu' })
    main(CANVAS_CHANNELS.menuClick, { doc: DOC, id: 'fit-all' })
    main(CANVAS_CHANNELS.menuClick, { doc: DOC, id: 'fit-all', in: 'somewhere' })
    expect(heard).toEqual([{ id: 'mark-all-seen', in: 'tab-menu' }, { id: 'fit-all', in: 'menu' }, { id: 'fit-all' }, { id: 'fit-all' }])
  })
})
