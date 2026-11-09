/**
 * Spec 31's Home (Part E) and app-live.json (Part D2), in node with Electron mocked:
 * - E1: Recently here hides canvases in temp folders;
 * - E2: a recent card keeps the logo its tab proved and fetched (logos.ts, `<state>/logos/`), sniffed again when read;
 * - E3: a shared canvas's name and logo (canvas-fetch.ts `fetchSite`: meta.json alone, no redirect, 64 KB, the logo
 *   same-origin and sniffed), kept by origin only on success;
 * - E4: a running canvas's update (canvas-fetch.ts `fetchUpdate`), and its copy command in its own folder;
 * - D1's Home half: a link to a canvas not running leads Recently here, highlighted, with its start command;
 * - D2: app-live.json written, refreshed and removed - and read back by `marver link`'s own rule.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appTakesLink, checkAppLive } from '../../../src/shared/deep-link.ts'
import type { RecentEntry } from '../../src/main/home.ts'

const fx = vi.hoisted(() => ({ copied: [] as string[] }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.1.0', getName: () => 'Marver Dev', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: async () => '' },
  clipboard: { writeText: (t: string) => { fx.copied.push(t) } },
}))

type Home = typeof import('../../src/main/home.ts')
let h: Home
let base: string
let home: string
let repos: string

// a 1x1 PNG, and an SVG: real logos the sniff takes
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')
const WS = (n: number) => n.toString(16).padStart(16, '0')

beforeEach(async () => {
  vi.resetModules()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-r31-')))
  home = join(base, 'home')
  repos = join(base, 'repos')
  mkdirSync(repos)
  process.env.MARVER_HOME = home
  process.env.MARVER_APP_TEMP_DIRS = ''
  const cfg = await import('../../src/main/config.ts')
  h = await import('../../src/main/home.ts')
  cfg.ensureHome({ version: '1.1.0', dev: true })
  cfg.loadFiles()
  h.startHome()
  fx.copied.length = 0
})
afterEach(() => { rmSync(base, { recursive: true, force: true }); delete process.env.MARVER_HOME; delete process.env.MARVER_APP_TEMP_DIRS })

const state = () => join(home, 'state-dev')
const verify = (n: number, root = join(repos, `repo${n}`)) => {
  mkdirSync(root, { recursive: true })
  h.noteVerified({ ws: WS(n), root, name: `Canvas ${n}`, origin: `http://[::1]:${4900 + n}`, slot: n, port: 4900 + n })
  return root
}

describe('E1: Recently here hides canvases in temp folders', () => {
  const entry = (n: number, root: string): RecentEntry => ({ workspace: WS(n), root, name: `C${n}`, origin: `http://[::1]:${4900 + n}`, lastSeen: 1000 + n })

  it('os.tmpdir() (and its real path), /tmp, /private/tmp, /var/folders - and nothing outside them', () => {
    delete process.env.MARVER_APP_TEMP_DIRS
    const temps = h.tempFolders()
    for (const d of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', realpathSync(tmpdir())]) expect(temps, d).toContain(d)
    const list = [
      entry(1, '/Users/nic/acme'), entry(2, join(realpathSync(tmpdir()), 'mv-x')), entry(3, '/private/tmp/sbux'), entry(4, '/tmp/robo'),
      entry(5, '/var/folders/ab/T/x'), entry(6, '/Users/nic/tmp-notes'), entry(7, '/private/tmpx/y'),
    ]
    expect(h.recentViewsOf(list, [], '/Users/nic').map((v) => v.name)).toEqual(['C7', 'C6', 'C1'])
  })

  it('the same list through recentViews: a temp canvas is not drawn, but stays recorded', () => {
    delete process.env.MARVER_APP_TEMP_DIRS
    verify(1)                                  // under the temp folder
    expect(h.recentViews([]).map((v) => v.name)).toEqual([])
    expect(h.recentEntries().map((e) => e.name)).toEqual(['Canvas 1'])
  })
})

describe('E2: a recent card keeps its logo', () => {
  it('the logo the tab proved is kept by workspace in state/logos/ and drawn once the canvas stops; only for a recorded canvas', async () => {
    verify(1)
    h.noteLogo(WS(1), PNG_URL)
    h.noteLogo(WS(2), PNG_URL)                 // never verified: not kept
    await new Promise((r) => setTimeout(r, 50))
    expect(readdirSync(join(state(), 'logos'))).toEqual([`ws-${WS(1)}.png`])
    expect(h.recentViews([])[0]).toMatchObject({ name: 'Canvas 1', logo: PNG_URL })
    expect(h.recentViews([WS(1)])).toEqual([])   // running: its live card is the one drawn
  })

  it('read back at the next launch, sniffed again: a file that is not a logo is as if absent; a canvas no longer listed loses its file', async () => {
    verify(1); verify(2)
    h.noteLogo(WS(1), PNG_URL)
    await new Promise((r) => setTimeout(r, 50))
    h.flushRecent([])
    writeFileSync(join(state(), 'logos', `ws-${WS(2)}.png`), '<html>not a png</html>')
    writeFileSync(join(state(), 'logos', `ws-${WS(9)}.svg`), SVG)   // no such canvas
    vi.resetModules()
    const cfg = await import('../../src/main/config.ts')
    h = await import('../../src/main/home.ts')
    cfg.ensureHome({ version: '1.1.0', dev: true })
    cfg.loadFiles()
    h.startHome()
    const views = h.recentViews([])
    expect(views.find((v) => v.name === 'Canvas 1')?.logo).toBe(PNG_URL)
    expect(views.find((v) => v.name === 'Canvas 2')?.logo).toBeUndefined()
    expect(existsSync(join(state(), 'logos', `ws-${WS(9)}.svg`))).toBe(false)
  })

  it('a data URL whose bytes are not what it says is never kept', async () => {
    const { fromDataUrl } = await import('../../src/main/logos.ts')
    expect(fromDataUrl(PNG_URL)?.type).toBe('png')
    expect(fromDataUrl(`data:image/svg+xml;base64,${PNG.toString('base64')}`)).toBeNull()
    expect(fromDataUrl(`data:image/png;base64,${Buffer.from('<script>').toString('base64')}`)).toBeNull()
    expect(fromDataUrl('https://x.example/logo.png')).toBeNull()
  })
})

describe('E3: shared canvases\' name and logo', () => {
  type Call = { url: string; init: RequestInit }
  const res = (body: string | Buffer, o: { status?: number; url?: string } = {}) => Object.assign(new Response(body, { status: o.status ?? 200 }), o.url ? { url: o.url } : {})
  const fake = (routes: Record<string, () => Response | Promise<Response>>) => {
    const calls: Call[] = []
    return { calls, fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); const r = routes[url]; if (!r) throw new Error('nothing'); return r() } }
  }
  const O = 'https://pilot.example.com'

  it('meta.json alone, no redirect followed, then the repo\'s logo on the same origin, sniffed', async () => {
    const { fetchSite } = await import('../../src/main/canvas-fetch.ts')
    const f = fake({ [`${O}/meta.json`]: () => res(JSON.stringify({ name: 'acme-studio', logo: '/__mv/logo.svg', rights: {} })), [`${O}/__mv/logo.svg`]: () => res(SVG) })
    const site = await fetchSite(f.fetch, O)
    expect(site).toEqual({ name: 'Acme Studio', logo: `data:image/svg+xml;base64,${SVG.toString('base64')}` })
    expect(f.calls.map((c) => c.url)).toEqual([`${O}/meta.json`, `${O}/__mv/logo.svg`])
    expect(f.calls.every((c) => c.init.redirect === 'error' && c.init.cache === 'no-store' && !!c.init.signal)).toBe(true)
  })

  it('a logo path that is not the repo\'s, bytes that are not a logo, or a body past 64 KB: no logo, or nothing at all', async () => {
    const { fetchSite } = await import('../../src/main/canvas-fetch.ts')
    expect(await fetchSite(fake({ [`${O}/meta.json`]: () => res(JSON.stringify({ name: 'x', logo: 'https://evil.example/l.svg' })) }).fetch, O)).toEqual({ name: 'X' })
    expect(await fetchSite(fake({ [`${O}/meta.json`]: () => res(JSON.stringify({ name: 'x', logo: '/__mv/logo.png' })), [`${O}/__mv/logo.png`]: () => res('<script>alert(1)</script>') }).fetch, O)).toEqual({ name: 'X' })
    expect(await fetchSite(fake({ [`${O}/meta.json`]: () => res(JSON.stringify({ name: 'x', pad: 'a'.repeat(70 * 1024) })) }).fetch, O)).toBeNull()
    expect(await fetchSite(fake({ [`${O}/meta.json`]: () => res('{}', { status: 302 }) }).fetch, O)).toBeNull()
    expect(await fetchSite(fake({ [`${O}/meta.json`]: () => res(JSON.stringify({ name: '\u0007bell' })) }).fetch, O)).toBeNull()
    expect(await fetchSite(fake({}).fetch, O)).toBeNull()   // a redirect refused throws: nothing kept
  })

  it('kept by origin only on success: Home\'s shared links wear the name and logo; a failure keeps nothing', async () => {
    h.noteShared({ url: `${O}/#/b/main`, host: 'pilot.example.com' })
    expect(h.sharedLinks()[0]).toEqual({ url: `${O}/#/b/main`, host: 'pilot.example.com', lastSeen: expect.any(Number) })
    h.noteSite(O, 'Acme Studio', PNG_URL)
    h.noteSite('http://pilot.example.com', 'Nope', undefined)   // not https: never
    expect(h.sharedLinks()[0]).toMatchObject({ name: 'Acme Studio', logo: PNG_URL })
    h.flushShared()
    expect(JSON.parse(readFileSync(join(state(), 'sites.json'), 'utf8'))).toMatchObject({ v: 1, sites: [{ origin: O, name: 'Acme Studio' }] })
    expect(readdirSync(join(state(), 'logos')).filter((f) => f.startsWith('site-'))).toHaveLength(1)
  })
})

describe('E4: a running canvas\'s update', () => {
  it('fetchUpdate: through the session it is given, no redirect, 4 KB at most; "available" only for a strictly newer x.y.z', async () => {
    const { fetchUpdate, updateOf } = await import('../../src/main/canvas-fetch.ts')
    const calls: RequestInit[] = []
    const answer = (b: unknown) => async (_u: string, init: RequestInit) => { calls.push(init); return new Response(typeof b === 'string' ? b : JSON.stringify(b)) }
    expect(await fetchUpdate(answer({ current: '0.30.1', latest: '0.31.0', checkedAt: 1, state: 'ok' }), 'http://[::1]:4806')).toEqual({ current: '0.30.1', latest: '0.31.0' })
    expect(calls[0]).toMatchObject({ redirect: 'error', cache: 'no-store' })
    expect(await fetchUpdate(answer({ current: '0.31.0', latest: '0.31.0', state: 'ok' }), 'http://[::1]:4806')).toBeNull()
    expect(await fetchUpdate(answer({ current: '0.31.0', latest: null, state: 'offline' }), 'http://[::1]:4806')).toBeNull()
    expect(await fetchUpdate(answer({ current: '0.30.1', latest: '0.31.0', pad: 'x'.repeat(5000) }), 'http://[::1]:4806')).toBeNull()
    expect(updateOf({ current: '0.30.1', latest: '0.31.0-beta.1' })).toBeNull()
    expect(updateOf({ current: '0.30.1', latest: '<b>9.9.9</b>' })).toBeNull()
  })

  it('copy-update: the update command in that tab\'s own folder, from main\'s record - never a path from Home', async () => {
    h.setUpdateRoots((id) => (id === 't3' ? "/Users/nic/tms broker's" : undefined))
    expect(await h.homeAction({ action: 'copy-update', id: 't3' })).toEqual({ ok: true })
    expect(fx.copied).toEqual([`cd '/Users/nic/tms broker'\\''s' && npm i -D @marver-design/marver@latest && npx marver init`])
    expect(await h.homeAction({ action: 'copy-update', id: 't4' })).toEqual({ ok: false })
    expect(await h.homeAction({ action: 'copy-update', id: '/etc' })).toEqual({ ok: false })
  })
})

describe('D1, Home: a link to a canvas not running', () => {
  it('its Recently here card leads, highlighted, with its start command', async () => {
    verify(1); verify(2)
    expect(h.showLinked(join(repos, 'repo1'), WS(1), true)).toBe(`r_${WS(1)}`)
    const v = h.recentViews([])
    expect(v.map((x) => [x.name, !!x.linked])).toEqual([['Canvas 1', true], ['Canvas 2', false]])
    expect(await h.homeAction({ action: 'copy-start', id: `r_${WS(1)}` })).toEqual({ ok: true })
    expect(fx.copied.at(-1)).toBe(`cd '${join(repos, 'repo1')}' && npx marver dev`)
    // running now: its live card is the one, no linked card
    expect(h.recentViews([WS(1)]).some((x) => x.linked)).toBe(false)
  })

  it('a folder that never ran here: a card of its own, named by its folder, with its start command; a folder that does not exist: none', async () => {
    const root = join(repos, 'fresh-repo')
    mkdirSync(root)
    expect(h.showLinked(root, WS(7), true)).toBe(`r_${WS(7)}`)
    expect(h.recentViews([])[0]).toMatchObject({ id: `r_${WS(7)}`, name: 'fresh-repo', linked: true, lastSeen: 0 })
    expect(await h.homeAction({ action: 'copy-start', id: `r_${WS(7)}` })).toEqual({ ok: true })
    expect(fx.copied.at(-1)).toBe(`cd '${root}' && npx marver dev`)
    expect(h.showLinked(join(repos, 'nowhere'), WS(8), false)).toBeNull()
    expect(h.recentViews([]).some((x) => x.linked)).toBe(false)
  })
})

describe('D2: app-live.json', () => {
  it('written whole at start, again soon after a change, removed at quit; marver link\'s rule reads it', async () => {
    const { startAppLive } = await import('../../src/main/app-live.ts')
    const dir = join(base, 'state')
    mkdirSync(dir)
    let open = ['/Users/nic/acme']
    let now = 1_000_000
    const live = startAppLive({ dir: () => dir, pid: process.pid, version: '1.1.0', scheme: () => true, workspaces: () => open, now: () => now, every: 60_000 })
    await live.write()
    const read = () => checkAppLive(JSON.parse(readFileSync(join(dir, 'app-live.json'), 'utf8')))
    expect(read()).toEqual({ v: 1, pid: process.pid, version: '1.1.0', scheme: 1, at: now, workspaces: ['/Users/nic/acme'] })
    const alive = (pid: number) => pid === process.pid
    expect(appTakesLink(read(), '/Users/nic/acme', now + 1000, alive)).toBe(true)
    expect(appTakesLink(read(), '/Users/nic/other', now + 1000, alive)).toBe(false)     // that canvas is not open here
    expect(appTakesLink(read(), '/Users/nic/acme', now + 91_000, alive)).toBe(false)    // stale
    expect(appTakesLink(read(), '/Users/nic/acme', now - 60_000, alive)).toBe(false)    // a stamp from the future
    expect(appTakesLink(read(), '/Users/nic/acme', now, () => false)).toBe(false)       // its pid is gone
    open = ['/Users/nic/acme', '/Users/nic/other']
    now += 5000
    live.changed()
    await new Promise((r) => setTimeout(r, 1300))
    expect(read()?.workspaces).toEqual(['/Users/nic/acme', '/Users/nic/other'])
    live.stop()
    expect(existsSync(join(dir, 'app-live.json'))).toBe(false)
  })

  it('an app that does not take the scheme says so: no `scheme`, and marver link gives localhost', async () => {
    const { appLiveFile } = await import('../../src/main/app-live.ts')
    const f = appLiveFile({ pid: 1, version: '1.1.0', scheme: false, workspaces: ['/a', '/a'], at: 5 })
    expect(f).toEqual({ v: 1, pid: 1, version: '1.1.0', at: 5, workspaces: ['/a'] })
    expect(appTakesLink(f, '/a', 5, () => true)).toBe(false)
  })
})
