/**
 * `marver://` links into the app (spec 31 D1): the scheme's parsing (shared/deep-link.ts, as main reads it), the routing
 * (src/main/deep-link.ts `routeDeepLink`: the real folder bound to a running canvas, the port hint's rule, an open tab
 * shown the place over the bridge and never loaded, a tab with no live document opened through openInTab, a canvas not
 * running sent to Home) and the cold-start queue - pure, no Electron.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDeepLink, deepLinkArg, parseDeepLink, type ShowTarget } from '../../../src/shared/deep-link.ts'
import { createLinkQueue, planDeepLink, routeDeepLink, workspaceOf, type LinkCanvas } from '../../src/main/deep-link.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-deep-')))
const A = join(base, 'acme'), B = join(base, 'other')
mkdirSync(A); mkdirSync(B)
symlinkSync(A, join(base, 'acme-link'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const real = (p: string): string | null => { try { return realpathSync(p) } catch { return null } }
const entry = (o: Partial<LinkCanvas> = {}): LinkCanvas => ({ ws: workspaceOf(A), root: A, port: 4806, slot: 2, state: 'ready', origin: 'http://[::1]:4806', name: 'Acme', ...o })

describe('the link (shared/deep-link.ts, as main reads it)', () => {
  it('round-trips through URLSearchParams: the hash\'s own # ? & travel percent-encoded inside `to`', () => {
    const link = buildDeepLink({ ws: A, to: '#/b/main?f=demo/one,demo/two&c=t1', port: 4806 })!
    expect(link.startsWith('marver://open?ws=')).toBe(true)
    expect(link).not.toMatch(/to=#/)
    expect(link).toContain('to=%23%2Fb%2Fmain%3Ff%3Ddemo%2Fone%2Cdemo%2Ftwo%26c%3Dt1')
    expect(parseDeepLink(link)).toEqual({ ws: A, to: { board: 'main', f: ['demo/one', 'demo/two'], c: 't1' }, port: 4806 })
  })

  it('a bad ws refuses the whole link: missing, relative, a control character, over 1 KB', () => {
    for (const ws of ['', 'relative/path', '/a\u0000b', '/a\nb', `/${'a'.repeat(1100)}`]) {
      expect(parseDeepLink(`marver://open?ws=${encodeURIComponent(ws)}&to=${encodeURIComponent('#/b/main')}`), ws.slice(0, 20)).toBeNull()
    }
    expect(parseDeepLink('marver://open?to=%23%2Fb%2Fmain')).toBeNull()
  })

  it('hostile `to` is dropped, never the link: another route, a URL, script, extra keys, bad values, an encoded traversal', () => {
    for (const to of [
      'javascript:alert(1)', 'https://evil.example/#/b/main', '#/f/demo/one', '#/p/main?at=demo/one', '#/i/abcdefgh12345678',
      '#/b/main?x=1', '#/b/main?f=a&f=b', '#/b/main?f=../../etc', '#/b/main?c=<script>', '#/b/Main', '#/b/main/extra',
      '#/b/%2e%2e', '#/b/main?n=a b', '/#/b/main', '#/b/main#again',
    ]) {
      const p = parseDeepLink(buildDeepLink({ ws: A, to }) ?? `marver://open?ws=${encodeURIComponent(A)}&to=${encodeURIComponent(to)}`)
      expect(p, to).toEqual({ ws: A, to: null })
    }
  })

  it('not this scheme, another action, a path, credentials, a fragment, repeated or unknown keys, or over 2 KB: nothing', () => {
    const ws = encodeURIComponent(A)
    for (const raw of [
      `https://open?ws=${ws}`, `marver://show?ws=${ws}`, `marver://open/x?ws=${ws}`, `marver://u:p@open?ws=${ws}`, `marver://open?ws=${ws}#/b/main`,
      `marver://open?ws=${ws}&ws=${ws}`, `marver://open?ws=${ws}&evil=1`, `marver://open?ws=${ws}&to=${encodeURIComponent(`#/b/main?f=${'a/'.repeat(1100)}`)}`, 42, null,
    ]) expect(parseDeepLink(raw), String(raw).slice(0, 40)).toBeNull()
    expect(buildDeepLink({ ws: A, to: `#/b/main?f=${'abc/'.repeat(600)}` })).toBeNull()
  })

  it('a port that is not one is ignored; a second launch\'s argv gives its first marver:// argument', () => {
    expect(parseDeepLink(`marver://open?ws=${encodeURIComponent(A)}&port=99999`)).toEqual({ ws: A, to: null })
    expect(parseDeepLink(`marver://open?ws=${encodeURIComponent(A)}&port=48a`)).toEqual({ ws: A, to: null })
    expect(deepLinkArg(['/Applications/Marver.app/Contents/MacOS/Marver', '--flag', 'MARVER://open?ws=%2Fx', 'marver://open?ws=%2Fy'])).toBe('MARVER://open?ws=%2Fx')
    expect(deepLinkArg(['--x', 'https://marver.design'])).toBeNull()
  })
})

describe('planDeepLink: the real folder, and the port hint only within it', () => {
  const link = (o: { ws?: string; port?: number } = {}) => ({ ws: o.ws ?? A, to: null, ...(o.port ? { port: o.port } : {}) })

  it('binds the realpath of ws to a running entry of that same folder; a symlinked folder is the same canvas', () => {
    const e = entry()
    expect(planDeepLink(link({ ws: join(base, 'acme-link') }), real(join(base, 'acme-link')), [e])).toEqual({ kind: 'canvas', entry: e })
  })

  it('a reused port: the hint names another canvas\'s port - never opened; Home for this folder instead', () => {
    const other = entry({ ws: workspaceOf(B), root: B, port: 4807, origin: 'http://[::1]:4807', name: 'Other' })
    expect(planDeepLink(link({ port: 4807 }), A, [other])).toEqual({ kind: 'home', root: A, ws: workspaceOf(A), exists: true })
    const mine = entry({ port: 4806 })
    expect(planDeepLink(link({ port: 4807 }), A, [other, mine])).toEqual({ kind: 'canvas', entry: mine })
  })

  it('the hint picks among this folder\'s canvases; else the first ready, else the first starting', () => {
    const one = entry({ port: 4806, state: 'starting', origin: null }), two = entry({ port: 4809, slot: 5, origin: 'http://[::1]:4809' }), three = entry({ port: 41000, slot: null, origin: 'http://[::1]:41000' })
    expect(planDeepLink(link({ port: 41000 }), A, [one, two, three])).toEqual({ kind: 'canvas', entry: three })
    expect(planDeepLink(link(), A, [one, two, three])).toEqual({ kind: 'canvas', entry: two })
    expect(planDeepLink(link(), A, [one])).toEqual({ kind: 'canvas', entry: one })
    expect(planDeepLink(link(), A, [entry({ state: 'closing' })]).kind).toBe('home')
  })

  it('a folder that does not resolve is Home, said not to exist', () => {
    expect(planDeepLink(link({ ws: join(base, 'gone') }), null, [entry()])).toEqual({ kind: 'home', root: join(base, 'gone'), ws: workspaceOf(join(base, 'gone')), exists: false })
  })
})

describe('routeDeepLink: an open tab is shown the place, never loaded', () => {
  interface T { id: string; live: boolean }
  const run = (raw: string, o: { entries?: LinkCanvas[]; tab?: T } = {}) => {
    const did: { show: [string, ShowTarget | 'landing'][]; open: [string, string | null, string][]; home: [string, string, boolean][]; focus: number } = { show: [], open: [], home: [], focus: 0 }
    const r = routeDeepLink<T>(raw, {
      entries: () => o.entries ?? [entry()], realpath: real, focus: () => { did.focus++ },
      tabFor: () => o.tab, live: (t) => t.live,
      show: (t, to) => { did.show.push([t.id, to]) }, open: (e, url, rest) => { did.open.push([e.origin ?? '', url, rest]) }, home: (root, ws, exists) => { did.home.push([root, ws, exists]) },
    })
    return { r, did }
  }
  const to = '#/b/main?f=demo/one'

  it('a tab with a live document: the navigation command over the bridge - no openInTab, no load, so no draft is lost', () => {
    const { r, did } = run(buildDeepLink({ ws: A, to })!, { tab: { id: 't3', live: true } })
    expect(r).toBe('shown')
    expect(did.show).toEqual([['t3', { board: 'main', f: ['demo/one'] }]])
    expect(did.open).toEqual([])
    expect(did.focus).toBe(1)
  })

  it('an open tab and a `to` it could not take: the canvas\'s own board, still over the bridge - never a load', () => {
    const { did } = run(`marver://open?ws=${encodeURIComponent(A)}&to=${encodeURIComponent('javascript:alert(1)')}`, { tab: { id: 't3', live: true } })
    expect([did.show, did.open]).toEqual([[['t3', 'landing']], []])
  })

  it('no tab yet, or one with no live document: opened at that place through openInTab, on the entry\'s bound origin', () => {
    expect(run(buildDeepLink({ ws: A, to })!).did.open).toEqual([['http://[::1]:4806', 'http://[::1]:4806/#/b/main?f=demo/one', '/#/b/main?f=demo/one']])
    expect(run(buildDeepLink({ ws: A, to })!, { tab: { id: 't3', live: false } }).did.open).toHaveLength(1)
    // a starting canvas: the place kept for its ready (url null)
    expect(run(buildDeepLink({ ws: A, to })!, { entries: [entry({ state: 'starting', origin: null })] }).did.open).toEqual([['', null, '/#/b/main?f=demo/one']])
    // a hostile `to`: the canvas's default board, never the hash it wrote
    expect(run(`marver://open?ws=${encodeURIComponent(A)}&to=${encodeURIComponent('javascript:alert(1)')}`).did.open).toEqual([['http://[::1]:4806', 'http://[::1]:4806/', '/']])
  })

  it('not running: Home with its card; a bad link: nothing at all, not even the window', () => {
    const { r, did } = run(buildDeepLink({ ws: B, to })!)
    expect([r, did.home]).toEqual(['home', [[B, workspaceOf(B), true]]])
    const bad = run('marver://open?ws=relative')
    expect([bad.r, bad.did.focus, bad.did.open, bad.did.show, bad.did.home]).toEqual(['bad', 0, [], [], []])
  })
})

describe('the cold-start queue', () => {
  it('holds links heard before ready, in order, at most eight (the newest kept), then handles each later one at once', () => {
    const q = createLinkQueue()
    for (let i = 0; i < 10; i++) q.push(`marver://open?ws=%2Fl${i}`)
    q.push(42); q.push('x'.repeat(5000))
    expect(q.held()).toEqual(Array.from({ length: 8 }, (_, i) => `marver://open?ws=%2Fl${i + 2}`))
    const seen: string[] = []
    q.ready((raw) => { seen.push(raw) })
    expect(seen).toEqual(Array.from({ length: 8 }, (_, i) => `marver://open?ws=%2Fl${i + 2}`))
    expect(q.held()).toEqual([])
    q.push('marver://open?ws=%2Flate')
    expect(seen.at(-1)).toBe('marver://open?ws=%2Flate')
  })

  it('a handler that throws costs that link alone', () => {
    const q = createLinkQueue()
    q.push('a'); q.push('b')
    const seen: string[] = []
    const err = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try { q.ready((raw) => { if (raw === 'a') throw new Error('boom'); seen.push(raw) }) } finally { process.stderr.write = err }
    expect(seen).toEqual(['b'])
  })
})
