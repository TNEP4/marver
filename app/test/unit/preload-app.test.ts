/**
 * The app preload's wire format (src/preload/app.ts; spec 28 "Channels and who may use them", A2.14 #19): every
 * method of every page kind, called once, goes out as an invoke exactly when channels.ts's `INVOKES` names its
 * channel, and as a send otherwise - so the bridge, which mounts each channel from the same list, answers every one.
 * In node with Electron mocked; the real preload under a real renderer is test/pw/{strip,home,settings,tabpage}.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INVOKES, isInvoke, RECEIVES, SENDERS, type PageKind } from '../../src/shared/channels.ts'

const wire = vi.hoisted(() => ({
  sent: [] as { ch: string; args: unknown[] }[],
  invoked: [] as { ch: string; args: unknown[] }[],
  listened: [] as string[],
  exposed: null as Record<string, unknown> | null,
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, api: Record<string, unknown>) => { wire.exposed = api } },
  ipcRenderer: {
    send: (ch: string, ...args: unknown[]) => { wire.sent.push({ ch, args }) },
    invoke: (ch: string, ...args: unknown[]) => { wire.invoked.push({ ch, args }); return Promise.resolve({ ok: true }) },
    on: (ch: string) => { wire.listened.push(ch) },
  },
}))

type AppKind = Exclude<PageKind, 'canvas'>
async function load(kind: string): Promise<Record<string, unknown> | null> {
  vi.resetModules()
  wire.sent.length = wire.invoked.length = wire.listened.length = 0
  wire.exposed = null
  ;(globalThis as unknown as { location: unknown }).location = { protocol: 'marver-app:', host: kind }
  await import('../../src/preload/app.ts')
  return wire.exposed
}
afterEach(() => { delete (globalThis as unknown as { location?: unknown }).location })

/** Calls every method a page kind exposes (not its subscriptions), with plausible arguments. */
async function callAll(api: Record<string, unknown>): Promise<void> {
  const args: Record<string, unknown[]> = {
    ready: [], activate: ['t1'], close: ['t1'], tabMenu: ['t1', 1, 2], more: [{ ids: ['t2'], x: 1, y: 2 }],
    pillAction: [{ rev: 1, act: 'button' }], openLink: ['http://localhost:4806/'], action: [{ action: 'show-files' }],
    get: [], set: [{ file: 'config', key: 'restoreTabs', value: false }], reveal: [],
  }
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== 'function' || name.startsWith('on')) continue
    const a = name === 'action' && api.kind === 'tabpage' ? [1, 'retry'] : args[name]
    expect(a, `no arguments for ${String(api.kind)}.${name}`).toBeDefined()
    await (fn as (...x: unknown[]) => unknown)(...a!)
  }
}

describe('the app preload follows INVOKES', () => {
  for (const kind of ['strip', 'home', 'settings', 'tabpage'] as AppKind[]) {
    it(`${kind}: an invoke for INVOKES' channels, a send for the rest, each one a channel its kind may send`, async () => {
      const api = await load(kind)
      expect(api?.kind).toBe(kind)
      expect([...wire.listened].sort()).toEqual([...RECEIVES[kind]].sort())
      await callAll(api!)
      for (const { ch } of wire.invoked) expect(isInvoke(ch), `${ch} invoked`).toBe(true)
      for (const { ch } of wire.sent) expect(isInvoke(ch), `${ch} sent`).toBe(false)
      for (const { ch } of [...wire.invoked, ...wire.sent]) expect(SENDERS[ch], ch).toContain(kind)
    })
  }

  it('every invoke is reached by some page, and the list is the four that answer', async () => {
    const seen = new Set<string>()
    for (const kind of ['strip', 'home', 'settings', 'tabpage']) {
      await callAll((await load(kind))!)
      for (const { ch } of wire.invoked) seen.add(ch)
    }
    expect([...seen].sort()).toEqual([...INVOKES].sort())
    expect([...INVOKES].sort()).toEqual(['home:action', 'link:open', 'settings:get', 'settings:set'])
  })

  it('exposes nothing on another document', async () => {
    expect(await load('canvas')).toBeNull()
    ;(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'home' }
    vi.resetModules()
    wire.exposed = null
    await import('../../src/preload/app.ts')
    expect(wire.exposed).toBeNull()
  })
})
