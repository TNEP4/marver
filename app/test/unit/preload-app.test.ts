/**
 * The app preload's wire format (src/preload/app.ts; spec 28 "Channels and who may use them", A2.14 #19): every
 * method of every page kind, called once, goes out as an invoke exactly when channels.ts's `INVOKES` names its
 * channel, and as a send otherwise - so the bridge, which mounts each channel from the same list, answers every one.
 * In node with Electron mocked; the real preload under a real renderer is test/pw/{strip,home,settings,tabpage}.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INVOKES, isInvoke, RECEIVES, SENDERS, type AppPageKind, type PageKind } from '../../src/shared/channels.ts'

const wire = vi.hoisted(() => ({
  sent: [] as { ch: string; args: unknown[] }[],
  invoked: [] as { ch: string; args: unknown[] }[],
  listened: [] as string[],
  /** each channel's ipcRenderer.on handler, so a test can play main sending it */
  handlers: new Map<string, (e: unknown, payload: unknown) => void>(),
  exposed: null as Record<string, unknown> | null,
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, api: Record<string, unknown>) => { wire.exposed = api } },
  ipcRenderer: {
    send: (ch: string, ...args: unknown[]) => { wire.sent.push({ ch, args }) },
    invoke: (ch: string, ...args: unknown[]) => { wire.invoked.push({ ch, args }); return Promise.resolve({ ok: true }) },
    on: (ch: string, fn: (e: unknown, payload: unknown) => void) => { wire.listened.push(ch); wire.handlers.set(ch, fn) },
  },
}))

type AppKind = AppPageKind
async function load(kind: string): Promise<Record<string, unknown> | null> {
  vi.resetModules()
  wire.sent.length = wire.invoked.length = wire.listened.length = 0
  wire.handlers.clear()
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
    // spec 32 B2: the strip's menu
    menuPick: [{ rev: 1, id: null }], menuShown: [{ rev: 1 }],
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

describe('spec 32: the strip\'s menu and Home\'s own inputs (B2, D8.8)', () => {
  const sends = (ch: string) => wire.sent.filter((x) => x.ch === ch).map((x) => x.args[0])
  type Fn = (...a: unknown[]) => unknown
  it('the strip: onTabMenu hears tab-menu; tabMenu and more carry MenuAsk only as booleans, absent when not given; the pick and the shown ack', async () => {
    const api = (await load('strip'))! as Record<string, Fn>
    expect(Object.keys(api).filter((k) => typeof api[k] === 'function').sort()).toEqual(
      ['activate', 'close', 'menuPick', 'menuShown', 'more', 'onPageFocus', 'onPill', 'onTabMenu', 'onTabs', 'onWindow', 'openLink', 'pillAction', 'ready', 'tabMenu'])
    expect(wire.listened).toContain('tab-menu')
    api.tabMenu('t1', 1, 2)
    api.tabMenu('t1', 1, 2, { key: true, hadFocus: false })
    api.tabMenu('t1', 1, 2, { key: 'yes', hadFocus: 1 })
    expect(sends('tab:menu')).toEqual([{ id: 't1', x: 1, y: 2 }, { id: 't1', x: 1, y: 2, key: true, hadFocus: false }, { id: 't1', x: 1, y: 2 }])
    api.more({ ids: ['t2'], x: 1, y: 2 })
    api.more({ ids: ['t2'], x: 1, y: 2, key: false, hadFocus: true })
    expect(sends('tabs:more')).toEqual([{ ids: ['t2'], x: 1, y: 2 }, { ids: ['t2'], x: 1, y: 2, key: false, hadFocus: true }])
    api.menuPick({ rev: 3, id: 'close' })
    api.menuPick({ rev: 3, id: null })
    api.menuPick({ rev: 3 })
    api.menuShown({ rev: 3, extra: 1 })
    expect(sends('tab:menu-pick')).toEqual([{ rev: 3, id: 'close' }, { rev: 3, id: null }, { rev: 3, id: null }])
    expect(sends('tab:menu-shown')).toEqual([{ rev: 3 }])
    // the strip's activate stays the shared one: `{ id, via }` only
    api.activate('t1', 'key', { cancel: true, keys: 'Enter' })
    expect(sends('tab:activate')).toEqual([{ id: 't1', via: 'key' }])
  })
  it('the strip: onTabMenu delivers what main sends on tab-menu - a menu, then null - and nothing from tabs; its off stops it', async () => {
    const api = (await load('strip'))! as Record<string, Fn>
    const got: unknown[] = []
    const tabsGot: unknown[] = []
    const off = api.onTabMenu((v: unknown) => { got.push(v) }) as () => void
    api.onTabs((v: unknown) => { tabsGot.push(v) })
    const emit = (ch: string, v: unknown) => wire.handlers.get(ch)!({ sender: 'main' }, v)
    const menu = { rev: 1, x: 10, y: 20, kind: 'tab', rows: [{ kind: 'item', id: 'close', label: 'Close Tab', enabled: true }, { kind: 'sep' }] }
    emit('tab-menu', menu)
    emit('tab-menu', null)
    emit('tabs', { rev: 1, tabs: [] })
    expect(got).toEqual([menu, null])
    expect(tabsGot).toEqual([{ rev: 1, tabs: [] }])
    off()
    emit('tab-menu', { ...menu, rev: 2 })
    expect(got).toEqual([menu, null])
  })
  it('Home has no tabMenu; its activate sends cancel and keys only when given and valid', async () => {
    const api = (await load('home'))! as Record<string, Fn>
    expect(api.tabMenu).toBeUndefined()
    expect(api.menuPick).toBeUndefined()
    api.activate('t1', 'key', { cancel: true })
    api.activate('t1', 'key', { keys: 'Enter' })
    api.activate('t1', 'key', { keys: 'Space' })
    api.activate('t1', 'key', { keys: 'Escape' })
    api.activate('t1', 'key', { cancel: 'yes' })
    api.activate('t1', 'key', { cancel: false })
    api.activate('t1')
    expect(sends('tab:activate')).toEqual([
      { id: 't1', via: 'key', cancel: true }, { id: 't1', via: 'key', keys: 'Enter' }, { id: 't1', via: 'key', keys: 'Space' },
      { id: 't1', via: 'key' }, { id: 't1', via: 'key' }, { id: 't1', via: 'key' }, { id: 't1' },
    ])
  })
  it('Home\'s openLink and action: via key with its key', async () => {
    const api = (await load('home'))! as Record<string, Fn>
    await api.openLink('https://x.example/', 'key', 'Space')
    await api.openLink('https://x.example/', 'click', 'Space')
    await api.openLink('https://x.example/')
    await api.action({ action: 'copy-path', id: 't1', via: 'key', keys: 'Enter' })
    await api.action({ action: 'reveal', id: 't1', keys: 'Enter' })
    await api.action({ action: 'copy-link', id: 's_0123456789abcdef', via: 'key', keys: 'Tab' })
    expect(wire.invoked.map((x) => [x.ch, x.args[0]])).toEqual([
      ['link:open', { url: 'https://x.example/', via: 'key', keys: 'Space' }],
      ['link:open', { url: 'https://x.example/', via: 'click' }],
      ['link:open', { url: 'https://x.example/' }],
      ['home:action', { action: 'copy-path', id: 't1', via: 'key', keys: 'Enter' }],
      ['home:action', { action: 'reveal', id: 't1' }],
      ['home:action', { action: 'copy-link', id: 's_0123456789abcdef', via: 'key' }],
    ])
  })
})
