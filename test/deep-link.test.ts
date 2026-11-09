import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  appTakesLink, buildDeepLink, checkAppLive, checkShowTarget, hashOfTarget, newerVersion, parseDeepLink, targetFromHash,
} from '../src/shared/deep-link.ts'
import { linkFor } from '../src/cli/link.ts'
import { showPlan, showWords } from '../src/cli/show.ts'
import { updateStatus } from '../src/server/update.ts'
import { CLI } from './dev-server.ts'

/**
 * Spec 31 D1-D3's shared rules and the CLI around them, without a browser:
 * - the hash grammar a show target travels in (shared/deep-link.ts): only `#/b/<board>` with `f`, `s`, `n`, `c`, every
 *   value of its characters - a hostile hash is refused whole;
 * - `marver link` chooses the app's `marver://` link only while app-live.json says the app is in use with this canvas
 *   open (a live pid, under 90 s, `scheme: 1`), else localhost; `--web` forces localhost - end to end through the CLI
 *   against a stand-in dev server on a port of this stream's (5642);
 * - `marver show`'s plan (one board, a board alone, a thread) and its words;
 * - `GET /__mv/api/update` always answers (E4): `{ current, latest, checkedAt, state }`.
 */

const run = promisify(execFile)

describe('the show target and the link hash', () => {
  it('a target: the board, its keys\' grammars, de-duplicated; unknown fields stripped; a bad value refuses the whole', () => {
    expect(checkShowTarget({ board: 'main', f: ['demo/one', 'demo/one'], n: ['demo/one@390'], s: ['demo'], c: 't-1', x: 1 }))
      .toEqual({ board: 'main', f: ['demo/one'], n: ['demo/one@390'], s: ['demo'], c: 't-1' })
    expect(checkShowTarget({ board: '~unplaced' })).toEqual({ board: '~unplaced' })
    for (const bad of [null, [], { board: 'Main' }, { board: 'main', f: 'demo/one' }, { board: 'main', f: ['../etc'] }, { board: 'main', s: ['a/b'] },
      { board: 'main', n: ['a b'] }, { board: 'main', c: 'a/b' }, { board: 'main', f: Array.from({ length: 65 }, (_, i) => `s/f${i}`) }, { board: `b${'a'.repeat(64)}` }]) {
      expect(checkShowTarget(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull()
    }
  })

  it('the hash: only #/b/<board> and f, s, n, c, each once - anything else, whole, is null; written back canonical', () => {
    expect(targetFromHash('#/b/main?f=demo/one,demo/two&s=shop&n=demo/one@390&c=t1')).toEqual({ board: 'main', f: ['demo/one', 'demo/two'], s: ['shop'], n: ['demo/one@390'], c: 't1' })
    expect(targetFromHash('#/b/main')).toEqual({ board: 'main' })
    for (const bad of ['#/', '#/f/demo/one', '#/p/main?at=x', '#/b/main?at=x', '#/b/main?f=a&f=b', '#/b/main?f=..%2Fx', 'javascript:1', 'https://x/#/b/main', '#/b/main?c=a%20b', '#/b/main/x', `#/b/main?f=${'a/'.repeat(1100)}`]) {
      expect(targetFromHash(bad), bad.slice(0, 40)).toBeNull()
    }
    const t = { board: 'flow', n: ['k1'], f: ['shop/pay'], s: ['shop'], c: 'th' }
    expect(hashOfTarget(t)).toBe('#/b/flow?n=k1&f=shop/pay&s=shop&c=th')
    expect(targetFromHash(hashOfTarget(t))).toEqual(t)
  })

  it('the deep link carries the hash URLSearchParams-encoded, and reads back the same', () => {
    const link = buildDeepLink({ ws: '/Users/nic/tms broker', to: '#/b/main?f=demo/one&c=t1', port: 4806 })!
    expect(link).toBe('marver://open?ws=%2FUsers%2Fnic%2Ftms+broker&to=%23%2Fb%2Fmain%3Ff%3Ddemo%2Fone%26c%3Dt1&port=4806')
    expect(parseDeepLink(link)).toEqual({ ws: '/Users/nic/tms broker', to: { board: 'main', f: ['demo/one'], c: 't1' }, port: 4806 })
  })

  it('versions: strictly newer x.y.z only', () => {
    expect([newerVersion('0.31.0', '0.30.1'), newerVersion('0.30.1', '0.30.1'), newerVersion('0.30.0', '0.30.1'), newerVersion('1.0.0-rc.1', '0.9.0'), newerVersion(null, '1.0.0')]).toEqual([true, false, false, false, false])
  })
})

describe('marver link: the app\'s link only while the app is in use with this canvas open (D2)', () => {
  let base = '', root = '', home = '', server: Server | null = null
  const PORT = 5642
  const TOKEN = 'tok-r31-link'
  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mv-r31-link-')))
    root = join(base, 'repo')
    home = join(base, 'home')
    mkdirSync(join(root, 'design', 'scenes', 'demo'), { recursive: true })
    mkdirSync(join(root, 'design', 'boards'), { recursive: true })
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(root, 'design', 'scenes', 'demo', 'one.tsx'), 'export default () => null\n')
    writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n1', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }] }))
    // a stand-in for `marver dev`: dev.json, and /__mv/api/work answering with the token
    writeFileSync(join(root, 'design', '.local', 'dev.json'), JSON.stringify({ port: PORT, token: TOKEN, pid: process.pid }))
    server = createServer((req, res) => {
      const ok = req.url?.startsWith('/__mv/api/work') && req.headers['x-mv-work'] === TOKEN
      res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(ok ? '{"frames":[]}' : '{}')
    })
    await new Promise<void>((r) => server!.listen(PORT, 'localhost', () => r()))
  })
  afterAll(async () => {
    await new Promise((r) => server?.close(r))
    rmSync(base, { recursive: true, force: true })
  })
  const live = (o: Partial<{ pid: number; at: number; scheme: 1 | undefined; workspaces: string[] }> = {}) =>
    writeFileSync(join(home, 'state', 'app-live.json'), JSON.stringify({ v: 1, pid: process.pid, version: '1.1.0', scheme: 1, at: Date.now(), workspaces: [root], ...o }))
  const link = async (...args: string[]) => (await run(process.execPath, [CLI, 'link', 'demo/one', '--root', root, ...args], { env: { ...process.env, MARVER_HOME: home }, timeout: 30_000 })).stdout.trim()
  const deep = () => `marver://open?ws=${encodeURIComponent(root)}&to=${encodeURIComponent('#/b/main?f=demo/one')}&port=${PORT}`

  it('the app in use, this canvas open in it: the marver:// link, its hash and port written with URLSearchParams', async () => {
    live()
    expect(await link()).toBe(deep())
    expect(parseDeepLink(await link())).toEqual({ ws: root, to: { board: 'main', f: ['demo/one'] }, port: PORT })
  }, 60_000)

  it('--web: localhost whatever the app says', async () => {
    live()
    expect(await link('--web')).toBe(`http://localhost:${PORT}/#/b/main?f=demo/one`)
  }, 60_000)

  it('a stale file, a pid that is gone, an older app (no scheme), or this canvas not open there: localhost', async () => {
    for (const o of [{ at: Date.now() - 91_000 }, { pid: 2 ** 22 + 12345 }, { scheme: undefined }, { workspaces: [join(base, 'other')] }]) {
      live(o)
      expect(await link(), JSON.stringify(o)).toBe(`http://localhost:${PORT}/#/b/main?f=demo/one`)
    }
    rmSync(join(home, 'state', 'app-live.json'))
    expect(await link()).toBe(`http://localhost:${PORT}/#/b/main?f=demo/one`)
  }, 120_000)

  it('linkFor and the file rule, as functions', () => {
    expect(linkFor(root, `http://localhost:${PORT}/`, '#/b/main', { app: true })).toBe(`marver://open?ws=${encodeURIComponent(root)}&to=${encodeURIComponent('#/b/main')}&port=${PORT}`)
    expect(linkFor(root, `http://localhost:${PORT}/`, '#/b/main', { app: true, web: true })).toBe(`http://localhost:${PORT}/#/b/main`)
    expect(checkAppLive({ v: 1, pid: 1, version: 'x', at: 1, workspaces: ['relative'] })).toBeNull()
    expect(appTakesLink(checkAppLive({ v: 1, pid: 1, version: 'x', at: 1, workspaces: ['/a'], scheme: 2 }), '/a', 1, () => true)).toBe(false)
  })

  it('show\'s plan: frames on one board; a board name alone; a thread; frames on two boards refused, each board named', () => {
    writeFileSync(join(root, 'design', 'scenes', 'demo', 'two.tsx'), 'export default () => null\n')
    writeFileSync(join(root, 'design', 'boards', 'side.json'), JSON.stringify({ version: 1, name: 'side', order: 1, auto: false, nodes: [{ key: 'n2', frame: 'demo/two', x: 0, y: 0, w: 390, h: 844 }] }))
    expect(showPlan(root, ['demo/one']).target).toEqual({ board: 'main', f: ['demo/one'] })
    expect(showPlan(root, ['side']).target).toEqual({ board: 'side' })
    expect(showPlan(root, ['demo/one'], { thread: 't-9' }).target).toEqual({ board: 'main', f: ['demo/one'], c: 't-9' })
    expect(() => showPlan(root, ['demo/one', 'demo/two'])).toThrow(/2 boards - show one board at a time[\s\S]*main[\s\S]*side/)
    expect(() => showPlan(root, ['demo/one'], { thread: '../x' })).toThrow(/not a thread id/)
    expect(() => showPlan(root, [])).toThrow(/name what to show/)
    expect([showWords(null), showWords({ shown: 0, notice: 0 }), showWords({ shown: 2, notice: 0 }), showWords({ shown: 1, notice: 1 })]).toEqual([
      'no open tab', 'no open tab', 'shown in 2 tabs', 'shown in 1 tab; 1 tab holds words not yet sent - it shows a notice to go there instead',
    ])
  })
})

describe('GET /__mv/api/update always answers (E4)', () => {
  let root = ''
  const was = process.env.MARVER_NO_UPDATE_CHECK
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mv-r31-update-')); mkdirSync(join(root, 'design', '.local'), { recursive: true }) })
  afterAll(() => { rmSync(root, { recursive: true, force: true }); if (was === undefined) delete process.env.MARVER_NO_UPDATE_CHECK; else process.env.MARVER_NO_UPDATE_CHECK = was })
  const cache = (o: object) => writeFileSync(join(root, 'design', '.local', 'update-check.json'), JSON.stringify(o))

  it('current or not, offline or disabled: { current, latest, checkedAt, state }, read under the daily TTL', async () => {
    delete process.env.MARVER_NO_UPDATE_CHECK
    const at = Date.now() - 1000
    cache({ checkedAt: at, latest: '0.0.1', ok: true })        // older than this package: still said
    expect(await updateStatus(root)).toEqual({ current: expect.stringMatching(/^\d+\.\d+\.\d+$/), latest: '0.0.1', checkedAt: at, state: 'ok' })
    cache({ checkedAt: at, latest: '99.0.0' })                  // a cache from before 0.31: a latest it holds was an answer
    expect(await updateStatus(root)).toMatchObject({ latest: '99.0.0', state: 'ok' })
    cache({ checkedAt: at, latest: null, ok: false })
    expect(await updateStatus(root)).toMatchObject({ latest: null, checkedAt: at, state: 'offline' })
    process.env.MARVER_NO_UPDATE_CHECK = '1'
    expect(await updateStatus(root)).toMatchObject({ latest: null, checkedAt: null, state: 'disabled' })
  })
})
