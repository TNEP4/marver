/**
 * Spec 32's main side of Home (src/main/home.ts, W3), in node with Electron mocked: a card's actions by id resolved in
 * main (D8.1 `cardOf`: Copy start command, Copy link, Copy path, Reveal in Finder), Recently here's exclusion set and
 * its republish (D6.4), a `marver:` link pasted on Home (D3), and the past shared links' ids (F1).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDeepLink } from '../../../src/shared/deep-link.ts'

const fx = vi.hoisted(() => ({ opened: [] as string[], copied: [] as string[], shown: [] as string[] }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getName: () => 'Marver Dev', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: async (p: string) => { fx.opened.push(p); return '' }, showItemInFolder: (p: string) => { fx.shown.push(p) } },
  clipboard: { writeText: (t: string) => { fx.copied.push(t) } },
}))

type Home = typeof import('../../src/main/home.ts')
type Cfg = typeof import('../../src/main/config.ts')
let h: Home
let cfg: Cfg
let base: string
let repos: string
const WS = (n: number) => n.toString(16).padStart(16, '0')

beforeEach(async () => {
  vi.resetModules()
  process.env.MARVER_APP_TEMP_DIRS = ''
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-home32-')))
  repos = join(base, 'repos')
  mkdirSync(repos)
  process.env.MARVER_HOME = join(base, 'home')
  cfg = await import('../../src/main/config.ts')
  h = await import('../../src/main/home.ts')
  fx.opened.length = 0; fx.copied.length = 0; fx.shown.length = 0
  cfg.ensureHome({ version: '0.1.0', dev: true }); cfg.loadFiles(); h.startHome()
})
afterEach(() => { h.setTabFacts(null); rmSync(base, { recursive: true, force: true }); delete process.env.MARVER_HOME; delete process.env.MARVER_APP_TEMP_DIRS })

const repo = (name: string) => { const p = join(repos, name); mkdirSync(p, { recursive: true }); return p }
const verified = (n: number, root: string, o: { slot?: number | null; port?: number } = {}) =>
  h.noteVerified({ ws: WS(n), root, name: `Canvas ${n}`, origin: `http://[::1]:${o.port ?? 4900 + n}`, slot: o.slot === undefined ? n : o.slot, port: o.port ?? 4900 + n })

describe('D8.1: a card\'s actions, by id, through cardOf', () => {
  it('a recent: Copy link copies buildDeepLink({ws: root}) - never the workspace id - and its explicit port; Copy path and Reveal its root', async () => {
    const a = repo('a'), b = repo('b')
    verified(1, a)                                // an automatic slot: no port kept
    verified(2, b, { slot: null, port: 5300 })    // an explicit --port
    expect(await h.homeAction({ action: 'copy-link', id: `r_${WS(1)}` })).toEqual({ ok: true })
    expect(await h.homeAction({ action: 'copy-link', id: `r_${WS(2)}` })).toEqual({ ok: true })
    expect(fx.copied).toEqual([buildDeepLink({ ws: a }), buildDeepLink({ ws: b, port: 5300 })])
    expect(fx.copied.join(' ')).not.toContain(WS(1))
    expect(await h.homeAction({ action: 'copy-path', id: `r_${WS(1)}` })).toEqual({ ok: true })
    expect(fx.copied.at(-1)).toBe(a)
    expect(await h.homeAction({ action: 'reveal', id: `r_${WS(2)}` })).toEqual({ ok: true })
    expect(fx.shown).toEqual([b])
  })

  it('a root buildDeepLink refuses (not absolute) answers missing and copies nothing', async () => {
    h.setTabFacts((id) => (id === 't1' ? { root: 'relative/folder', gone: true } : undefined))
    expect(await h.homeAction({ action: 'copy-link', id: 't1' })).toEqual({ ok: false, why: 'missing' })
    expect(fx.copied).toEqual([])
  })

  it('the deep-link-only card (no RecentEntry): Copy start, Copy link, Copy path and Reveal each resolve linked.root', async () => {
    const r = repo('never-ran')
    expect(h.showLinked(r, WS(7), true)).toBe(`r_${WS(7)}`)
    const id = `r_${WS(7)}`
    for (const action of ['copy-start', 'copy-link', 'copy-path', 'reveal'] as const) expect(await h.homeAction({ action, id }), action).toEqual({ ok: true })
    expect(fx.copied).toEqual([`cd '${r}' && npx marver dev`, buildDeepLink({ ws: r }), r])
    expect(fx.shown).toEqual([r])
    expect(h.cardOf(id)).toEqual({ ws: WS(7), root: r, link: buildDeepLink({ ws: r }) })
  })

  it('a gone tab: Copy start command passes --port only for an explicit-port start; its Copy link names its port either way', async () => {
    const r = repo('gone')
    h.setTabFacts((id) => ({
      auto: { ws: WS(3), root: r, port: 4903, link: buildDeepLink({ ws: r, port: 4903 })!, gone: true },
      explicit: { ws: WS(3), root: r, port: 5301, startPort: 5301, link: buildDeepLink({ ws: r, port: 5301 })!, gone: true },
    } as Record<string, import('../../src/main/home.ts').TabFacts>)[id])
    expect(await h.homeAction({ action: 'copy-start', id: 'auto' })).toEqual({ ok: true })
    expect(await h.homeAction({ action: 'copy-start', id: 'explicit' })).toEqual({ ok: true })
    expect(fx.copied).toEqual([`cd '${r}' && npx marver dev`, `cd '${r}' && npx marver dev --port 5301`])
    fx.copied.length = 0
    expect(await h.homeAction({ action: 'copy-link', id: 'auto' })).toEqual({ ok: true })
    expect(await h.homeAction({ action: 'copy-link', id: 'explicit' })).toEqual({ ok: true })
    expect(fx.copied).toEqual([buildDeepLink({ ws: r, port: 4903 }), buildDeepLink({ ws: r, port: 5301 })])
  })

  it('a running trusted tab copies its people link (the hook\'s); an untrusted one has none and answers missing; a remote tab its url', async () => {
    h.setTabFacts((id) => ({
      run: { ws: WS(1), root: '/r', port: 4806, link: 'http://localhost:4806/' },
      untrusted: { ws: WS(2), root: '/r', port: 4807 },
      remote: { link: 'https://pilot.example.com/' },
    } as Record<string, import('../../src/main/home.ts').TabFacts>)[id])
    expect(await h.homeAction({ action: 'copy-link', id: 'run' })).toEqual({ ok: true })
    expect(await h.homeAction({ action: 'copy-link', id: 'untrusted' })).toEqual({ ok: false, why: 'missing' })
    expect(await h.homeAction({ action: 'copy-link', id: 'remote' })).toEqual({ ok: true })
    expect(fx.copied).toEqual(['http://localhost:4806/', 'https://pilot.example.com/'])
    // a remote tab has no folder: Copy path and Reveal answer missing
    expect(await h.homeAction({ action: 'copy-path', id: 'remote' })).toEqual({ ok: false, why: 'missing' })
    expect(await h.homeAction({ action: 'reveal', id: 'remote' })).toEqual({ ok: false, why: 'missing' })
  })

  it('a past shared link: its id is s_ and 16 hex of sha256 over its origin; Copy link copies its url; an unknown id is missing', async () => {
    h.noteShared({ url: 'https://pilot.example.com/#/b/main', host: 'pilot.example.com' })
    const [l] = h.sharedLinks()
    expect(l.id).toMatch(/^s_[0-9a-f]{16}$/)
    expect(l.id).toBe(h.sharedId('https://pilot.example.com/other'))   // by origin
    expect(await h.homeAction({ action: 'copy-link', id: l.id })).toEqual({ ok: true })
    expect(fx.copied).toEqual(['https://pilot.example.com/#/b/main'])
    for (const id of ['s_0000000000000000', 'r_ffffffffffffffff', 'nope', 'x'.repeat(90)]) {
      for (const action of ['copy-link', 'copy-path', 'reveal', 'copy-start'] as const) expect(await h.homeAction({ action, id }), `${action} ${id}`).toEqual({ ok: false, why: 'missing' })
    }
  })

  it('with no tab hook every tab id resolves to nothing', async () => {
    h.setTabFacts(null)
    expect(h.cardOf('t1')).toBeUndefined()
    expect(await h.homeAction({ action: 'copy-path', id: 't1' })).toEqual({ ok: false, why: 'missing' })
  })
})

describe('D6.4: Recently here hides every excluded workspace; the quit stamps only the running ones', () => {
  it('recentViews(running, exclude): a gone tab\'s workspace has no recent card; flushRecent stamps only runningWorkspaces', async () => {
    verified(1, repo('a')); verified(2, repo('b'))
    const before = h.recentEntries().find((e) => e.workspace === WS(2))!.lastSeen
    expect(h.recentViews([], [WS(2)]).map((v) => v.id)).toEqual([`r_${WS(1)}`])
    await new Promise((r) => setTimeout(r, 5))
    h.flushRecent([WS(1)])
    const after = h.recentEntries()
    expect(after.find((e) => e.workspace === WS(2))!.lastSeen).toBe(before)   // the stopped canvas is not "Ran just now"
    expect(after.find((e) => e.workspace === WS(1))!.lastSeen).toBeGreaterThan(before)
  })

  it('no synthetic linked card for an excluded workspace (its gone tab\'s card survives instead, D6.5)', () => {
    const r = repo('linked')
    h.showLinked(r, WS(5), true)
    expect(h.recentViews([], []).map((v) => v.id)).toEqual([`r_${WS(5)}`])
    expect(h.recentViews([], [WS(5)])).toEqual([])
  })

  it('mountPages republishes recent when the excluded set changes - closing a gone tab brings its card back at once', async () => {
    verified(1, repo('a'))
    let excluded = [WS(1)]
    let changed = () => {}
    const sent: { ch: string; p: unknown }[] = []
    const ready = new Set<(c: { kind: string }) => void>()
    h.mountPages({ handle() {}, onReady(fn: (c: { kind: string }) => void) { ready.add(fn); return () => {} }, send(_t: string, ch: string, p: unknown) { sent.push({ ch, p }); return true } } as never, {
      running: () => [], onRunningChange: () => () => {}, homeExcluded: () => excluded, onHomeExcludedChange: (fn) => { changed = fn; return () => {} }, setFilesPill: () => {},
      linkPorts: { byPort: () => undefined, open: async () => ({ ok: true }), openRemote: async () => ({ ok: true }), deep: () => 'bad' },
    })
    for (const fn of ready) fn({ kind: 'home' })
    expect(sent.filter((s) => s.ch === 'recent').at(-1)!.p).toEqual([])
    excluded = []
    changed()
    expect(sent.filter((s) => s.ch === 'recent').at(-1)!.p).toEqual([expect.objectContaining({ id: `r_${WS(1)}` })])
    const n = sent.length
    changed()   // the same list: not sent again
    expect(sent.length).toBe(n)
  })
})

describe('D3: a marver: link on Home goes to main\'s deep-link handler', () => {
  const ports = (answer: 'bad' | 'home' | 'opened' | 'shown', seen: string[]) => ({
    byPort: () => undefined, open: async () => ({ ok: true as const }), openRemote: async () => ({ ok: true as const }),
    deep: (u: string) => { seen.push(u); return answer },
  })
  it('handed over as typed; the handler\'s bad is the field\'s bad, anything else ok; a malformed marver: link never reaches it', async () => {
    const seen: string[] = []
    const url = buildDeepLink({ ws: '/abs', port: 4806 })!
    for (const a of ['home', 'opened', 'shown'] as const) expect(await h.openLink({ url }, ports(a, seen))).toEqual({ ok: true })
    expect(await h.openLink({ url }, ports('bad', seen))).toEqual({ ok: false, why: 'bad' })
    expect(seen).toEqual([url, url, url, url])
    expect(await h.openLink({ url: 'marver://open?ws=relative' }, ports('home', seen))).toEqual({ ok: false, why: 'bad' })
    expect(seen).toHaveLength(4)
  })
})
