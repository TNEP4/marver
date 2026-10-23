/**
 * Trust (spec 28 A2.3, A2.10's trust cases, A2.14 #8, #9, #11, #13; v1.12 r1 #1, v1.13 r2 #1) on the dev build under
 * Playwright, against fake canvases (test/harness/fake-canvas.ts) and plain servers: canvases bound on IPv6 and IPv4
 * verify; an impostor behind a stale slot file is cancelled and never trusted; a redirect authorizes nothing; the
 * bridge admits a trusted document and replays what the page said before, hello first; messages carrying another
 * document's doc, none, or sent from anywhere but the canvas's main frame are refused; trust lost while a document
 * lives makes it stale and tells it untrusted, and nothing reloads it; the page's own reload that beats the new slot
 * file is read again and trusted, never unverified; no service worker registers, in a partition opened at launch or
 * later, and the server never sees the script.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { proofHeaders } from '../../../src/server/proof.ts'
import { launchPW, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { startFakeCanvas, type FakeCanvas, type FakeOptions } from '../harness/fake-canvas.ts'
import { evalIn, inRegistry, journal, open, plainServer, sleep, tabState, trusted, until, type TabState } from '../harness/trust.ts'

const slotBase = runSlotBase()
let env: TestEnv
let run: AppRun
const fakes: FakeCanvas[] = []
const closers: (() => Promise<void> | void)[] = []

beforeAll(async () => {
  env = testEnv(slotBase)
  run = await launchPW(env)
})
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close()
  for (const c of closers.splice(0)) await c()
})
afterAll(async () => {
  await run?.close()
  env?.cleanup()
})

async function fake(o: Partial<FakeOptions>): Promise<FakeCanvas> {
  const f = await startFakeCanvas({ home: env.home, slotBase, ...o })
  fakes.push(f)
  await f.ready
  await inRegistry(run, f.port, 'ready')
  return f
}

/** The fake page's use of the bridge, as the 0.27.1 shell does at boot: hello first, then theme, busy and menu. */
const BRIDGE = `
  window.__states = []; window.__clicks = [];
  var A = window.marverApp;
  if (A) {
    A.onAppState(function (s) { window.__states.push(s) });
    A.onMenuClick(function (p) { window.__clicks.push(p.id) });
    A.hello({ version: '0.27.1', board: 'main', page: 'PAGE_0123456789' });
    A.theme({ dark: false });
    A.busy({ busy: false, unsaved: false, why: [] });
    A.menu([{ id: 'fit-all', group: 'view', label: 'Fit All', hint: '\\u21e71' }, { id: 'hide-ui', group: 'view', label: 'Hide UI', hint: 'H', checked: false }]);
  }`

describe('the proof', () => {
  it('an IPv6-bound canvas verifies; its document request carried a fresh nonce and its workspace', async () => {
    const f = await fake({ slot: 1, bind: '::1' })
    const id = await open(run, f.port)
    const s = await trusted(run, id)
    expect(s.url).toBe(`${f.origin}/`)
    expect(s.committed).toMatchObject({ attributed: true, instance: f.instance, lost: false })
    const doc = f.requests.filter((r) => r.path === '/')
    expect(doc).toHaveLength(1)
    expect(String(doc[0].headers['x-mv-nonce'])).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(doc[0].headers['x-mv-ws']).toBe(f.ws)
    expect(await evalIn(run, id, 'JSON.stringify([window.marverApp.v, window.marverApp.topInset, window.marverApp.reopen])')).toBe('[1,0,false]')
  })

  it('an IPv4-bound canvas verifies, loaded on the origin its slot file names', async () => {
    const f = await fake({ slot: 2, bind: '127.0.0.1' })
    const id = await open(run, f.port)
    const s = await trusted(run, id)
    expect(s.origin).toBe(`http://127.0.0.1:${f.port}`)
  })

  it('an impostor behind a stale slot file: the load is cancelled, nothing is trusted, its logo dropped', async () => {
    const port = slotBase + 3
    const imp = await plainServer(port)
    closers.push(() => imp.close())
    const running = join(env.home, 'running')
    mkdirSync(running, { recursive: true, mode: 0o700 })
    const file = join(running, 'slot-3.json')
    const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, state: 'ready', pid: process.pid, instance: randomUUID(), slot: 3, port, origin: `http://127.0.0.1:${port}`,
      url: `http://localhost:${port}/`, root: '/tmp/gone', name: 'Gone canvas', version: '0.27.1', features: ['bridge'], ws: randomBytes(8).toString('hex'), startedAt: 1,
      key: randomBytes(32).toString('base64url') }), { mode: 0o600 })
    renameSync(tmp, file)
    closers.push(() => rmSync(file, { force: true }))
    await inRegistry(run, port, 'ready')
    const id = await open(run, port)
    const s = await until('the impostor\'s load to fail', async () => { const x = await tabState(run, id); return x.events.some((e) => e.e.kind === 'fail') ? x : null })
    const fail = s.events.find((e) => e.e.kind === 'fail')!.e
    expect(fail).toMatchObject({ why: 'unverified', code: -20 })
    expect(s.trusted).toBe(false)
    expect(s.events.some((e) => e.e.kind === 'commit')).toBe(false)
    expect(imp.hits).toContain('GET /')
    expect(await run.call('trust:logo', { port })).toBe(null)
    expect(imp.hits).toContain('GET /__mv/logo')
    expect(await run.call('trust:admit', { id })).toBe(null)
  })

  it('a redirect to the signed document verifies; one to an unsigned document is cancelled', async () => {
    const redirect = (unsigned: boolean) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/') { res.writeHead(302, { location: '/index.html' }); res.end(); return true }
      if (unsigned && path === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>unsigned</title>'); return true }
      return false
    }
    const a = await fake({ slot: 4, onRequest: redirect(false) })
    const ida = await open(run, a.port)
    const sa = await trusted(run, ida)
    expect(sa.url).toBe(`${a.origin}/index.html`)
    expect(sa.events.map((e) => e.e.kind)).toContain('redirect')
    expect(a.requests.filter((r) => r.path === '/index.html')[0].headers['x-mv-nonce']).not.toBe(a.requests.filter((r) => r.path === '/')[0].headers['x-mv-nonce'])
    const b = await fake({ slot: 5, onRequest: redirect(true) })
    const idb = await open(run, b.port)
    const sb = await until('the unsigned redirect to fail', async () => { const x = await tabState(run, idb); return x.events.some((e) => e.e.kind === 'fail') ? x : null })
    expect(sb.events.find((e) => e.e.kind === 'fail')!.e).toMatchObject({ why: 'unverified', url: `${b.origin}/index.html` })
    expect(sb.trusted).toBe(false)
  })

  it('a response signed for another instance is refused after one fresh read; x-mv-elsewhere fails as elsewhere', async () => {
    let mode: 'wrong' | 'elsewhere' = 'wrong'
    const f = await fake({ slot: 12, onRequest: (req, res) => {
      if ((req.url ?? '/') !== '/') return false
      if (mode === 'elsewhere') { res.writeHead(409, { 'x-mv-elsewhere': '1', 'content-type': 'application/json' }); res.end('{}'); return true }
      res.writeHead(200, { 'content-type': 'text/html', ...proofHeaders({ instance: randomUUID(), key: randomBytes(32), port: slotBase + 12 }, req.headers['x-mv-nonce'])! })
      res.end('<title>x</title>')
      return true
    } })
    const id = await open(run, f.port)
    const s = await until('the load to fail', async () => { const x = await tabState(run, id); return x.events.find((e) => e.e.kind === 'fail') ? x : null })
    expect(s.events.find((e) => e.e.kind === 'fail')!.e.why).toBe('unverified')
    mode = 'elsewhere'
    await run.call('trust:reload', { id })
    const s2 = await until('the elsewhere failure', async () => { const x = await tabState(run, id); return x.events.filter((e) => e.e.kind === 'fail').length === 2 ? x : null })
    expect(s2.events.filter((e) => e.e.kind === 'fail')[1].e.why).toBe('elsewhere')
  })
})

describe('the bridge', () => {
  let f: FakeCanvas
  let id: string
  let s: TabState

  it('admits the trusted document: what the page said before the admit arrives once it lands, hello first, and busy makes it fresh', async () => {
    f = await startFakeCanvas({ home: env.home, slotBase, slot: 6, script: BRIDGE })
    await f.ready
    await inRegistry(run, f.port, 'ready')
    id = await open(run, f.port)
    await trusted(run, id)
    s = await until('the page\'s four reports', async () => { const x = await tabState(run, id); return x.current?.menu ? x : null })
    expect(s.current).toEqual({
      safety: 'fresh', hello: { version: '0.27.1', board: 'main', page: 'PAGE_0123456789' }, theme: { dark: false },
      busy: { busy: false, unsaved: false, why: [] }, menu: [{ id: 'fit-all', group: 'view', label: 'Fit All', hint: '⇧1' }, { id: 'hide-ui', group: 'view', label: 'Hide UI', hint: 'H', checked: false }],
    })
    const b = (await journal(run, 'bridge')).map((l) => l.data).filter((d) => d.wc === s.wc)
    const admit = b.findIndex((d) => d.event === 'admit')
    expect(admit).toBeGreaterThanOrEqual(0)
    expect(b.slice(0, admit).some((d) => d.event === 'accepted')).toBe(false)
    expect(b.filter((d) => d.event === 'accepted').map((d) => d.ch)).toEqual(['hello', 'theme', 'busy', 'menu'])
    // the safety went unknown (at the admit) -> fresh (at the busy)
    expect(s.reports.map((r) => r.r.safety)).toContain('unknown')
    expect(s.reports.at(-1)!.doc).toMatch(/^[A-Za-z0-9_-]{24}$/)
  })

  it('later messages go as they come; a busy whose why disagrees, or past its bounds, is refused', async () => {
    await evalIn(run, id, `marverApp.theme({ dark: true }); marverApp.busy({ busy: true, unsaved: true, why: ['board-unsaved'] })`)
    const x = await until('the new theme and busy', async () => { const t = await tabState(run, id); return t.current?.theme?.dark && t.current.busy?.unsaved ? t : null })
    expect(x.current!.busy).toEqual({ busy: true, unsaved: true, why: ['board-unsaved'] })
    await evalIn(run, id, `marverApp.busy({ busy: false, unsaved: false, why: ['typing'] }); marverApp.menu([{ id: 'BAD id', group: 'view', label: 'x' }]); marverApp.theme({ dark: 'yes' })`)
    await sleep(200)
    const y = await tabState(run, id)
    expect(y.current!.busy).toEqual({ busy: true, unsaved: true, why: ['board-unsaved'] })
    expect(y.current!.menu).toHaveLength(2)
    expect(y.current!.theme).toEqual({ dark: true })
    const refused = (await journal(run, 'bridge')).map((l) => l.data).filter((d) => d.wc === s.wc && d.event === 'refused')
    expect(refused.map((d) => `${d.ch}:${d.why}`)).toEqual(expect.arrayContaining(['busy:payload', 'menu:payload', 'theme:payload']))
  })

  it('refuses a message stamped with another doc, with none, from no frame, and an app channel from a canvas', async () => {
    const doc = (await tabState(run, id)).reports.at(-1)!.doc
    const before = (await tabState(run, id)).current!.theme
    await run.call('trust:ipc', { id, channel: 'mv:theme', msg: { doc: 'A'.repeat(24), p: { dark: !before!.dark } } })
    await run.call('trust:ipc', { id, channel: 'mv:theme', msg: { p: { dark: !before!.dark } } })
    await run.call('trust:ipc', { id, channel: 'mv:theme', msg: { doc, p: { dark: !before!.dark } }, frame: 'none' })
    expect((await tabState(run, id)).current!.theme).toEqual(before)
    const why = (await journal(run, 'bridge')).map((l) => l.data).filter((d) => d.wc === s.wc && d.event === 'refused' && d.ch === 'theme').map((d) => d.why)
    expect(why).toEqual(expect.arrayContaining(['not the admitted document', 'not the main frame']))
    // the same message, rightly stamped, from the main frame: accepted
    await run.call('trust:ipc', { id, channel: 'mv:theme', msg: { doc, p: { dark: !before!.dark } } })
    expect((await tabState(run, id)).current!.theme).toEqual({ dark: !before!.dark })
    await run.call('trust:handle', { channel: 'tab:activate' })
    await run.call('trust:ipc', { id, channel: 'tab:activate', msg: { id: 'home' } })
    expect(await run.call('trust:handled')).toEqual([])
    expect((await journal(run, 'bridge')).some((l) => l.data.event === 'page-refused' && l.data.channel === 'tab:activate' && l.data.kind === 'canvas')).toBe(true)
  })

  it('mv:app-state and mv:menu-click reach the admitted document, a click only for an item it offers', async () => {
    expect(await run.call('trust:app-state', { id, s: 'shown' })).toBe(true)
    expect(await run.call('trust:menu-click', { id, item: 'fit-all' })).toBe(true)
    expect(await run.call('trust:menu-click', { id, item: 'not-offered' })).toBe(false)
    await until('the page to hear them', async () => (await evalIn<string>(run, id, 'JSON.stringify([window.__states, window.__clicks])')) === '[["shown"],["fit-all"]]')
  })

  it('mv:doc answers reopen once after the app reloaded the tab after a crash, and nothing else', async () => {
    await run.call('trust:reopen-next', { id })
    await run.call('trust:reload', { id })
    await until('the reload', async () => (await tabState(run, id)).commits >= 2)
    await trusted(run, id)
    expect(await evalIn(run, id, 'window.marverApp.reopen')).toBe(true)
    await run.call('trust:reload', { id })
    await until('the second reload', async () => (await tabState(run, id)).commits >= 3)
    await trusted(run, id)
    expect(await evalIn(run, id, 'window.marverApp.reopen')).toBe(false)
  })

  it('a reload is a new document: admitted again with a new doc, its reports replayed under it, the old doc refused', async () => {
    const was = (await tabState(run, id)).reports.at(-1)!.doc
    await run.call('trust:reload', { id })
    const x = await until('a new doc with its reports', async () => { const t = await tabState(run, id); const r = t.reports.at(-1); return r && r.doc !== was && r.r.busy ? t : null })
    await run.call('trust:ipc', { id, channel: 'mv:theme', msg: { doc: was, p: { dark: true } } })
    expect((await tabState(run, id)).current!.theme).toEqual({ dark: false })
    expect(x.reports.at(-1)!.doc).not.toBe(was)
    await f.close()
  })
})

describe('frames', () => {
  it('a same-origin frame reaches the bridge through parent; a cross-origin frame never does', async () => {
    const other = await plainServer(0, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>other</title>') })
    closers.push(() => other.close())
    const f = await fake({ slot: 7, script: `${BRIDGE}
      var a = document.createElement('iframe'); a.srcdoc = '<p>same</p>'; document.body.appendChild(a);
      var b = document.createElement('iframe'); b.src = '${other.origin}/'; document.body.appendChild(b);` })
    const id = await open(run, f.port)
    await trusted(run, id)
    await until('the frames', async () => (await evalIn<number>(run, id, 'document.querySelectorAll("iframe").length')) === 2)
    await sleep(300)
    expect(await run.call('trust:frame-eval', { id, index: 0, js: `parent.marverApp.theme({ dark: true }); 'sent'` })).toBe('sent')
    await until('the frame\'s theme', async () => (await tabState(run, id)).current?.theme?.dark === true)
    expect(await run.call('trust:frame-eval', { id, index: 1, js: `(function () { try { parent.marverApp.theme({ dark: false }); return 'sent' } catch (e) { return 'blocked' } })()` })).toBe('blocked')
    await sleep(200)
    expect((await tabState(run, id)).current?.theme).toEqual({ dark: true })
  })
})

describe('trust lost, and won back', () => {
  it('a new instance under a live page: untrusted at once, stale, told untrusted, nothing reloaded; its reports refused', async () => {
    const ws = randomBytes(8).toString('hex')
    const a = await startFakeCanvas({ home: env.home, slotBase, slot: 8, ws, script: BRIDGE })
    await a.ready
    await inRegistry(run, a.port, 'ready')
    const id = await open(run, a.port)
    const s = await trusted(run, id)
    await until('fresh', async () => (await tabState(run, id)).current?.safety === 'fresh')
    await a.close()
    const b = await fake({ slot: 8, ws, script: BRIDGE })
    const x = await until('the old document stale', async () => { const t = await tabState(run, id); return t.current?.safety === 'stale' ? t : null })
    expect(x.trusted).toBe(false)
    expect(x.gen).toBe(s.gen)   // the app loaded nothing
    expect(x.commits).toBe(s.commits)
    await until('the page told untrusted', async () => (await evalIn<string[]>(run, id, 'window.__states')).includes('untrusted'))
    await evalIn(run, id, 'marverApp.theme({ dark: true })')
    await sleep(200)
    expect((await tabState(run, id)).current?.theme).toEqual({ dark: false })
    // the page's own reload is proved like any load, under the new instance
    await evalIn(run, id, 'location.reload()')
    const y = await until('trusted again', async () => { const t = await tabState(run, id); return t.trusted && t.committed?.instance === b.instance ? t : null })
    expect(y.events.some((e) => e.e.kind === 'fail')).toBe(false)
  })

  it('the page\'s own reload beats the new slot file: the registry is read again, and it is trusted - never unverified', async () => {
    const ws = randomBytes(8).toString('hex')
    const a = await startFakeCanvas({ home: env.home, slotBase, slot: 9, ws })
    await a.ready
    await inRegistry(run, a.port, 'ready')
    const id = await open(run, a.port)
    await trusted(run, id)
    const before = (await tabState(run, id)).events.length
    await a.close()
    const b = await startFakeCanvas({ home: env.home, slotBase, slot: 9, ws })
    fakes.push(b)
    await b.ready
    await evalIn(run, id, 'location.reload()')   // well inside the watch's 100 ms debounce
    const y = await until('trusted under the new instance', async () => { const t = await tabState(run, id); return t.trusted && t.committed?.instance === b.instance ? t : null })
    const after = y.events.slice(before)
    expect(after.some((e) => e.e.kind === 'fail')).toBe(false)
    expect(after.filter((e) => e.e.kind === 'commit').map((e) => e.e.attributed)).toEqual([true])
    expect(b.requests.filter((r) => r.path === '/')).toHaveLength(1)
    // the response named an instance the registry did not hold yet: read again once, then proved
    const proof = (await journal(run, 'proof')).map((l) => l.data).filter((d) => d.wc === y.wc)
    expect(proof.some((d) => d.event === 'reread' && d.instance === b.instance)).toBe(true)
  })

  it('a canvas that stops: untrusted at once, and no load or webContents comes from the registry for a tab never opened', async () => {
    const a = await fake({ slot: 13 })
    const c = await fake({ slot: 14 })   // never opened
    const id = await open(run, a.port)
    await trusted(run, id)
    const wcs = (await run.call<{ kind: string | null }[]>('trust:web-contents')).filter((w) => w.kind === 'canvas').length
    await a.close()
    await run.call('trust:reread')
    expect((await tabState(run, id)).trusted).toBe(false)
    await c.close()
    const d = await fake({ slot: 14 })
    void d
    await run.call('trust:reread')
    expect((await run.call<{ kind: string | null }[]>('trust:web-contents')).filter((w) => w.kind === 'canvas').length).toBe(wcs)
    expect(c.requests.filter((r) => r.path === '/')).toHaveLength(0)
    expect(d.requests.filter((r) => r.path === '/')).toHaveLength(0)
  })
})

describe('service workers', () => {
  const REGISTER = `
    window.__sw = 'pending';
    navigator.serviceWorker.register('/sw.js').then(function () { window.__sw = 'registered' }, function (e) { window.__sw = 'failed: ' + e.name });`
  it('a page\'s register() fails and the server never sees the script - also in a partition first opened after launch', async () => {
    for (const slot of [10, 11]) {
      const f = await fake({ slot, script: REGISTER, onRequest: (req, res) => {
        if ((req.url ?? '').startsWith('/sw.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('self.addEventListener("fetch", function () {})'); return true }
        return false
      } })
      const id = await open(run, f.port)
      await trusted(run, id)
      const state = await until('register() to settle', async () => { const v = await evalIn<string>(run, id, 'window.__sw'); return v !== 'pending' ? v : null })
      expect(state).toMatch(/^failed/)
      expect(f.requests.some((r) => r.path.startsWith('/sw.js'))).toBe(false)
      expect((await journal(run, 'proof')).some((l) => l.data.event === 'service-worker-refused' && String(l.data.url).startsWith(f.origin))).toBe(true)
    }
    const sessions = (await journal(run, 'session')).map((l) => l.data)
    expect(sessions.every((d) => d.swept === true)).toBe(true)
  })
})
