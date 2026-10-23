/**
 * Home's main side (src/main/home.ts; spec 28 A2.7, A2.12, A2.14 #5, #24, v1.13 r2 #6): recent.json, the first-launch
 * marker, home:action and link:open - in node with Electron mocked.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkEntry, RecentEntry } from '../../src/main/home.ts'

const fx = vi.hoisted(() => ({ opened: [] as string[], copied: [] as string[] }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getName: () => 'Marver Dev', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: async (p: string) => { fx.opened.push(p); return '' } },
  clipboard: { writeText: (t: string) => { fx.copied.push(t) } },
}))

type Home = typeof import('../../src/main/home.ts')
type Cfg = typeof import('../../src/main/config.ts')
let h: Home
let cfg: Cfg
let base: string
let home: string
let repos: string

const WS = (n: number) => n.toString(16).padStart(16, '0')
const entry = (n: number, over: Partial<RecentEntry> = {}): RecentEntry => ({
  workspace: WS(n), root: join(repos, `repo${n}`), name: `Canvas ${n}`, origin: `http://[::1]:${4900 + n}`, lastSeen: 1000 + n, ...over,
})

beforeEach(async () => {
  vi.resetModules()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-home-')))
  home = join(base, 'home')
  repos = join(base, 'repos')
  mkdirSync(repos)
  process.env.MARVER_HOME = home
  cfg = await import('../../src/main/config.ts')
  h = await import('../../src/main/home.ts')
  fx.opened.length = 0
  fx.copied.length = 0
})
afterEach(() => { rmSync(base, { recursive: true, force: true }); delete process.env.MARVER_HOME })

const boot = () => { cfg.ensureHome({ version: '0.1.0', dev: true }); cfg.loadFiles(); h.startHome() }
const recentFile = () => join(home, 'state-dev', 'recent.json')

describe('checkRecent', () => {
  it('takes a good file and refuses a bad workspace, a relative root, an origin with a path or credentials', () => {
    mkdirSync(join(repos, 'repo1'))
    expect(h.checkRecent({ v: 1, canvases: [entry(1)] })).toBe(true)
    expect(h.checkRecent({ v: 1, canvases: [entry(1, { port: 5298 })] })).toBe(true)
    for (const bad of [
      entry(1, { workspace: '../../etc' }), entry(1, { workspace: 'ABCDEF0123456789' }), entry(1, { root: 'repos/x' }),
      entry(1, { root: '/a\0b' }), entry(1, { origin: 'http://[::1]:4901/x' }), entry(1, { origin: 'http://u:p@[::1]:4901' }),
      entry(1, { name: '' }), entry(1, { port: 0 }), entry(1, { lastSeen: Number.NaN }),
    ]) expect(h.checkRecent({ v: 1, canvases: [bad] }), JSON.stringify(bad)).toBe(false)
    expect(h.checkRecent({ v: 2, canvases: [] })).toBe(false)
    expect(h.checkRecent({ v: 1, canvases: Array.from({ length: 21 }, (_, i) => entry(i + 1)) })).toBe(false)
  })
})

describe('Recently here', () => {
  it('newest first, one per workspace, at most 20 - the oldest dropped', () => {
    const list = Array.from({ length: 21 }, (_, i) => entry(i + 1))
    const t = h.tidyRecent([...list, entry(3, { lastSeen: 1 })])
    expect(t).toHaveLength(20)
    expect(t[0].workspace).toBe(WS(21))
    expect(t.map((e) => e.workspace)).not.toContain(WS(1))
    expect(t.find((e) => e.workspace === WS(3))!.lastSeen).toBe(1003)
  })

  it('a running canvas is never listed; the folder with ~, the id main\'s, a hue by workspace', () => {
    const v = h.recentViewsOf([entry(1, { root: '/Users/nic/tms broker' }), entry(2)], [WS(2)], '/Users/nic')
    expect(v).toEqual([{ id: `r:${WS(1)}`, name: 'Canvas 1', folder: '~/tms broker', lastSeen: 1001, hue: expect.any(Number) }])
  })

  it('at launch: a cut-short recent.json goes aside and Recently here is empty; the next verify writes a fresh one', async () => {
    cfg.ensureHome({ version: '0.1.0', dev: true })
    writeFileSync(recentFile(), '{"v":1,"canvases":[{"works')
    cfg.loadFiles()
    h.startHome()
    expect(h.recentViews([])).toEqual([])
    expect(readFileSync(`${recentFile()}.bad`, 'utf8')).toBe('{"v":1,"canvases":[{"works')
    mkdirSync(join(repos, 'repo1'))
    h.noteVerified({ ws: WS(1), root: join(repos, 'repo1'), name: 'One', origin: 'http://[::1]:4901', slot: 1, port: 4901 })
    await new Promise((r) => setTimeout(r, 1100))
    expect(JSON.parse(readFileSync(recentFile(), 'utf8')).canvases).toEqual([expect.objectContaining({ workspace: WS(1), name: 'One' })])
  })

  it('at launch: an entry whose folder is gone is dropped', () => {
    cfg.ensureHome({ version: '0.1.0', dev: true })
    mkdirSync(join(repos, 'repo2'))
    writeFileSync(recentFile(), JSON.stringify({ v: 1, canvases: [entry(1), entry(2)] }))
    cfg.loadFiles()
    h.startHome()
    expect(h.recentViews([]).map((v) => v.name)).toEqual(['Canvas 2'])
  })

  it('a port of its own is kept for --port; a slot canvas keeps none; noteGone stamps the time', () => {
    boot()
    mkdirSync(join(repos, 'a'))
    h.noteVerified({ ws: WS(5), root: join(repos, 'a'), name: 'A', origin: 'http://127.0.0.1:5298', slot: null, port: 5298 })
    h.noteVerified({ ws: WS(6), root: join(repos, 'a'), name: 'B', origin: 'http://[::1]:4806', slot: 2, port: 4806 })
    const es = h.recentEntries()
    expect(es.find((e) => e.workspace === WS(5))!.port).toBe(5298)
    expect(es.find((e) => e.workspace === WS(6))).not.toHaveProperty('port')
    const before = es.find((e) => e.workspace === WS(5))!.lastSeen
    h.noteGone(WS(5))
    expect(h.recentEntries().find((e) => e.workspace === WS(5))!.lastSeen).toBeGreaterThanOrEqual(before)
  })

  it('refuses a verified record that would name a file badly', () => {
    boot()
    h.noteVerified({ ws: '../x', root: '/tmp', name: 'x', origin: 'http://[::1]:4901', slot: 1, port: 4901 })
    h.noteVerified({ ws: WS(1), root: 'relative', name: 'x', origin: 'http://[::1]:4901', slot: 1, port: 4901 })
    expect(h.recentEntries()).toEqual([])
  })

  it('the quit flush writes at once, running canvases stamped now', () => {
    boot()
    mkdirSync(join(repos, 'a'))
    h.noteVerified({ ws: WS(7), root: join(repos, 'a'), name: 'A', origin: 'http://[::1]:4807', slot: 3, port: 4807 })
    const t = Date.now()
    h.flushRecent([WS(7)])
    const f = JSON.parse(readFileSync(recentFile(), 'utf8'))
    expect(f.canvases[0].lastSeen).toBeGreaterThanOrEqual(t)
  })
})

describe('first launch', () => {
  it('welcome until state/launched exists; written once Home has shown; the welcome stays for the run', async () => {
    boot()
    expect(h.homeInfo()).toEqual({ welcome: true, writable: true })
    h.noteHomeShown()
    h.noteHomeShown()
    await new Promise((r) => setTimeout(r, 50))
    const marker = join(home, 'state-dev', 'launched')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ v: 1, app: '0.1.0' })
    expect(h.homeInfo().welcome).toBe(true)
    vi.resetModules()
    cfg = await import('../../src/main/config.ts')
    h = await import('../../src/main/home.ts')
    boot()
    expect(h.homeInfo().welcome).toBe(false)
  })

  it('running/ and prefer/ made by marver dev do not end the welcome (F2)', () => {
    mkdirSync(join(home, 'running'), { recursive: true })
    mkdirSync(join(home, 'prefer'), { recursive: true })
    boot()
    expect(h.homeInfo().welcome).toBe(true)
  })

  it('an unwritable home: no marker, and it says so', () => {
    mkdirSync(home, { mode: 0o500 })
    boot()
    expect(h.homeInfo()).toEqual({ welcome: true, writable: false })
    h.noteHomeShown()
    expect(existsSync(join(home, 'state-dev', 'launched'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('home:action', () => {
  it('copies main\'s own fixed commands by id', async () => {
    boot()
    for (const id of ['dev', 'init', 'update'] as const) expect(await h.homeAction({ action: 'copy', id })).toEqual({ ok: true })
    expect(fx.copied).toEqual(['npx marver dev', 'npm i -D @marver-design/marver && npx marver init', 'npm i -D @marver-design/marver@latest'])
  })

  it('copy-start: the recorded root, quoted whole, with --port for a port of its own', async () => {
    boot()
    mkdirSync(join(repos, "it's here"))
    h.noteVerified({ ws: WS(1), root: join(repos, "it's here"), name: 'A', origin: 'http://[::1]:4901', slot: 1, port: 4901 })
    h.noteVerified({ ws: WS(2), root: join(repos, "it's here"), name: 'B', origin: 'http://127.0.0.1:5298', slot: null, port: 5298 })
    expect(await h.homeAction({ action: 'copy-start', id: `r:${WS(1)}` })).toEqual({ ok: true })
    expect(await h.homeAction({ action: 'copy-start', id: `r:${WS(2)}` })).toEqual({ ok: true })
    const q = join(repos, "it'\\''s here")
    expect(fx.copied).toEqual([`cd '${q}' && npx marver dev`, `cd '${q}' && npx marver dev --port 5298`])
  })

  it('refuses what it does not hold: a recent id it has not, a command text, another action', async () => {
    boot()
    for (const a of [
      { action: 'copy-start', id: `r:${WS(9)}` }, { action: 'copy', id: 'rm -rf ~' }, { action: 'copy', id: 'toString' },
      { action: 'run', id: 'dev' }, null, 'copy',
    ]) expect(await h.homeAction(a), JSON.stringify(a)).toEqual({ ok: false })
    expect(fx.copied).toEqual([])
  })

  it('show-files opens the folder', async () => {
    boot()
    expect(await h.homeAction({ action: 'show-files' })).toEqual({ ok: true })
    expect(fx.opened).toEqual([home])
  })
})

describe('link:open', () => {
  const ready: LinkEntry = { state: 'ready', origin: 'http://[::1]:4806', port: 4806, ws: WS(1), name: 'TMS broker' }
  const run = (url: unknown, entries: LinkEntry[], answer: { ok: true } | { ok: false; why: 'refused' } = { ok: true }) => {
    const opened: { url: string | null; rest: string }[] = []
    return h.openLink({ url }, {
      byPort: (p) => entries.find((e) => e.port === p),
      open: async (_e, u, rest) => { opened.push({ url: u, rest }); return answer },
    }).then((a) => ({ a, opened }))
  }

  it('rebuilds a local link on the entry\'s bound origin, whatever host it wrote', async () => {
    const r = await run('http://127.0.0.1:4806/#/b/flow?f=x', [ready])
    expect(r).toEqual({ a: { ok: true }, opened: [{ url: 'http://[::1]:4806/#/b/flow?f=x', rest: '/#/b/flow?f=x' }] })
  })

  it('a port no canvas holds opens nothing; gone or closing counts as nothing', async () => {
    expect(await run('http://localhost:4807/', [ready])).toEqual({ a: { ok: false, why: 'nothing' }, opened: [] })
    expect(await run('http://localhost:4806/', [{ ...ready, state: 'closing' }])).toEqual({ a: { ok: false, why: 'nothing' }, opened: [] })
  })

  it('a starting canvas gets the path to load at ready (A2.14 #24)', async () => {
    expect(await run('localhost:4806/#/b/x', [{ ...ready, state: 'starting', origin: null }])).toEqual({ a: { ok: true }, opened: [{ url: null, rest: '/#/b/x' }] })
  })

  it('https is a later build; credentials, other hosts, 2 KB and non-strings are bad', async () => {
    expect((await run('https://pilot.example.com/', [ready])).a).toEqual({ ok: false, why: 'later' })
    for (const u of ['http://example.com/', 'http://u:p@localhost:4806/', `http://localhost:4806/#${'a'.repeat(2048)}`, 42, null]) {
      expect((await run(u, [ready])), String(u).slice(0, 40)).toEqual({ a: { ok: false, why: 'bad' }, opened: [] })
    }
  })

  it('passes the guard\'s refusal through', async () => {
    expect((await run('http://localhost:4806/?n=1', [ready], { ok: false, why: 'refused' })).a).toEqual({ ok: false, why: 'refused' })
  })
})
