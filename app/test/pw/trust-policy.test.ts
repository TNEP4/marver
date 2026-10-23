/**
 * Sessions, permissions and the navigation policy (spec 28 A2.5, A2.10, A2.14 #4, #11, #13) on the dev build under
 * Playwright with a fake microphone (`--use-fake-device-for-media-stream` alone: the fake-UI switch would approve a
 * stream without asking the app's handler). A trusted canvas's main frame gets the microphone, never the camera, and
 * nothing once its trust goes; a frame, notifications and geolocation get nothing; app pages get nothing. A canvas's
 * main frame stays on its shell document: a refused path opens the people link outside, a same-origin window.open of
 * the shell goes to the canvas's own tab, everything else leaves through openOutside's checks; subframes navigate
 * freely. App pages are pinned, serve only their manifest's files with A2.5's CSP, and a page showing another document
 * loses its channels.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { launchPW, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { startFakeCanvas, type FakeCanvas, type FakeOptions } from '../harness/fake-canvas.ts'
import { evalIn, inRegistry, journal, open, plainServer, sleep, tabState, trusted, until } from '../harness/trust.ts'

const slotBase = runSlotBase()
let env: TestEnv
let run: AppRun
const fakes: FakeCanvas[] = []
const closers: (() => Promise<void> | void)[] = []

beforeAll(async () => {
  env = testEnv(slotBase)
  run = await launchPW(env, { args: ['--use-fake-device-for-media-stream'] })
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
const GUM = (c: string) => `navigator.mediaDevices.getUserMedia(${c}).then(function (s) { var k = s.getTracks().map(function (t) { return t.kind }).join(','); s.getTracks().forEach(function (t) { t.stop() }); return 'ok:' + k }, function (e) { return 'refused:' + e.name })`
const opened = () => run.call<string[]>('trust:opened')
/** openOutside lets one URL out a second: cases that expect one to leave wait it out first */
const spaced = () => sleep(1100)

describe('permissions', () => {
  it('a trusted canvas\'s main frame gets the microphone, never the camera; a frame, notifications and geolocation get nothing', async () => {
    const f = await fake({ slot: 1, script: `var i = document.createElement('iframe'); i.srcdoc = '<p>frame</p>'; document.body.appendChild(i);` })
    const id = await open(run, f.port)
    await trusted(run, id)
    expect(await evalIn(run, id, GUM('{ audio: true }'))).toBe('ok:audio')
    expect(await evalIn(run, id, GUM('{ video: true }'))).toBe('refused:NotAllowedError')
    expect(await evalIn(run, id, GUM('{ audio: true, video: true }'))).toBe('refused:NotAllowedError')
    expect(await run.call('trust:frame-eval', { id, index: 0, js: GUM('{ audio: true }') })).toBe('refused:NotAllowedError')
    expect(await evalIn(run, id, 'Notification.requestPermission()')).toBe('denied')
    expect(await evalIn(run, id, `new Promise(function (r) { navigator.geolocation.getCurrentPosition(function () { r('ok') }, function (e) { r('refused:' + e.code) }, { timeout: 3000 }) })`)).toBe('refused:1')
    const p = (await journal(run, 'permission')).map((l) => l.data).filter((d) => d.how === 'request')
    expect(p.filter((d) => d.permission === 'media').map((d) => d.ok)).toEqual([true, false, false, false])
  })

  it('the microphone goes with the trust: a new instance under the live page, and the next request is refused', async () => {
    const ws = randomBytes(8).toString('hex')
    const a = await startFakeCanvas({ home: env.home, slotBase, slot: 2, ws })
    await a.ready
    await inRegistry(run, a.port, 'ready')
    const id = await open(run, a.port)
    await trusted(run, id)
    expect(await evalIn(run, id, GUM('{ audio: true }'))).toBe('ok:audio')
    await a.close()
    await fake({ slot: 2, ws })
    await until('untrusted', async () => !(await tabState(run, id)).trusted)
    expect(await evalIn(run, id, GUM('{ audio: true }'))).toBe('refused:NotAllowedError')
  })

  it('an app page gets nothing', async () => {
    const { id } = await run.call<{ id: string }>('trust:open-app', { page: 'home' })
    await until('Home loaded', async () => (await run.call<string | null>('trust:app-url', { id })) === 'marver-app://home/')
    await sleep(200)
    expect(await run.call('trust:app-eval', { id, js: GUM('{ audio: true }') })).toBe('refused:NotAllowedError')
    expect(await run.call('trust:app-eval', { id, js: 'Notification.requestPermission()' })).toBe('denied')
  })
})

describe('every view\'s preferences', () => {
  it('a canvas view made without disableDialogs gets no channel, no admission and no document', async () => {
    const f = await fake({ slot: 7 })
    const { id } = await run.call<{ id: string }>('trust:open', { port: f.port, unsafe: true })
    const s = await until('the load refused', async () => { const x = await tabState(run, id); return x.events.some((e) => e.e.kind === 'fail') ? x : null })
    expect(s.events.find((e) => e.e.kind === 'fail')!.e).toMatchObject({ why: 'unverified', code: -20 })
    expect(s.trusted).toBe(false)
    expect((s as unknown as { kind: string | null }).kind ?? null).toBe(null)
    expect(f.requests.filter((r) => r.path === '/')).toHaveLength(0)
    expect((await journal(run, 'bridge')).some((l) => l.data.event === 'unsafe-view' && l.data.why === 'dialogs not disabled')).toBe(true)
  })
})

describe('the navigation policy', () => {
  it('a same-origin path the policy refuses opens the canvas\'s people link outside; the page stays, trusted', async () => {
    const f = await fake({ slot: 3 })
    const id = await open(run, f.port)
    const s = await trusted(run, id)
    await spaced()
    await evalIn(run, id, `location.href = '/__mv/frame/?id=x#k'`)
    await until('the people link opened', async () => (await opened()).includes(`http://localhost:${f.port}/__mv/frame/?id=x#k`))
    const t = await tabState(run, id)
    expect(t.trusted).toBe(true)
    expect(t.url).toBe(s.url)
    expect(f.requests.some((r) => r.path.startsWith('/__mv/frame'))).toBe(false)
  })

  it('a same-origin window.open of the shell goes to the canvas\'s own tab, rebuilt on its bound origin - no second window', async () => {
    const f = await fake({ slot: 4 })
    const id = await open(run, f.port)
    await trusted(run, id)
    const before = (await run.call<unknown[]>('trust:web-contents')).length
    const out = (await opened()).length
    expect(await evalIn(run, id, `String(window.open('/index.html?x=1#/b/flow'))`)).toBe('null')
    await until('the tab asked to go there', async () => (await run.call<{ url: string }[]>('trust:same-canvas')).some((c) => c.url === `${f.origin}/index.html?x=1#/b/flow`))
    expect((await run.call<unknown[]>('trust:web-contents')).length).toBe(before)
    expect((await opened()).length).toBe(out)
  })

  it('window.open elsewhere leaves through openOutside: https opens, file:, javascript:, credentials and 2049 characters do not, and one a second', async () => {
    const f = await fake({ slot: 5 })
    const id = await open(run, f.port)
    await trusted(run, id)
    await spaced()
    const n = (await opened()).length
    await evalIn(run, id, `window.open('https://example.com/a'); window.open('https://example.com/b'); 1`)
    await sleep(200)
    expect((await opened()).slice(n)).toEqual(['https://example.com/a'])
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.com/', `https://example.com/${'x'.repeat(2049 - 20)}`]) {
      await spaced()
      await evalIn(run, id, `window.open(${JSON.stringify(u)}); 1`)
    }
    await sleep(200)
    expect((await opened()).slice(n)).toEqual(['https://example.com/a'])
    await spaced()
    await evalIn(run, id, `window.open('/elsewhere?q=1'); 1`)
    await until('the people link', async () => (await opened()).includes(`http://localhost:${f.port}/elsewhere?q=1`))
    expect((await tabState(run, id)).trusted).toBe(true)
  })

  it('a subframe navigates freely, to another origin too', async () => {
    const other = await plainServer(0, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>elsewhere</title>') })
    closers.push(() => other.close())
    const f = await fake({ slot: 6, script: `var i = document.createElement('iframe'); i.srcdoc = '<p>frame</p>'; document.body.appendChild(i);` })
    const id = await open(run, f.port)
    await trusted(run, id)
    await sleep(200)
    await run.call('trust:frame-eval', { id, index: 0, js: `location.href = '${other.origin}/x'; 1` })
    await until('the frame there', () => other.hits.includes('GET /x'))
    expect((await tabState(run, id)).trusted).toBe(true)
  })
})

describe('app pages', () => {
  it('are pinned: location, a link and window.open change nothing and open nothing', async () => {
    const { id } = await run.call<{ id: string }>('trust:open-app', { page: 'home' })
    await until('Home loaded', async () => (await run.call<string | null>('trust:app-url', { id })) === 'marver-app://home/')
    await spaced()
    const n = (await opened()).length
    for (const js of [
      `location.href = 'https://example.com/'`, `location.href = 'marver-app://settings/'`, `location.href = 'marver-app://home/?x'`,
      `String(window.open('https://example.com/'))`,
      `(function () { var a = document.createElement('a'); a.href = 'https://example.com/'; document.body.appendChild(a); a.click(); return 1 })()`,
    ]) {
      await run.call('trust:app-eval', { id, js })
      await sleep(250)
      expect(await run.call('trust:app-url', { id }), js).toBe('marver-app://home/')
    }
    expect((await opened()).length).toBe(n)
  })

  it('serve only their manifest\'s files, with A2.5\'s CSP: no .., no file the build did not list', async () => {
    const home = await run.call<{ status: number; csp: string; nosniff: string; type: string }>('trust:app-fetch', { url: 'marver-app://home/' })
    expect(home).toMatchObject({ status: 200, nosniff: 'nosniff', type: 'text/html; charset=utf-8' })
    expect(home.csp).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'")
    expect((await run.call<{ status: number }>('trust:app-fetch', { url: 'marver-app://home/main.js' })).status).toBe(200)
    expect((await run.call<{ status: number }>('trust:app-fetch', { url: 'marver-app://home/tokens.css' })).status).toBe(200)
    for (const u of ['marver-app://tabpage/../home/', 'marver-app://home/nope.js', 'marver-app://home/main.js.map', 'marver-app://nope/', 'marver-app://__proto__/', 'marver-app://home/%2e%2e/strip/main.js']) {
      expect((await run.call<{ status: number }>('trust:app-fetch', { url: u })).status, u).toBe(404)
    }
  })

  it('a page showing another document loses its channels', async () => {
    await run.call('trust:handle', { channel: 'home:action' })
    const { id } = await run.call<{ id: string }>('trust:open-app', { page: 'home' })
    await until('Home loaded', async () => (await run.call<string | null>('trust:app-url', { id })) === 'marver-app://home/')
    await run.call('trust:ipc', { id, channel: 'home:action', msg: { action: 'show-files' } })
    await run.call('trust:ipc', { id, channel: 'home:action', msg: { action: 'copy', id: 'rm -rf' } })
    expect(await run.call('trust:handled')).toEqual([{ channel: 'home:action', kind: 'home', payload: { action: 'show-files' } }])
    await run.call('trust:app-load', { id, url: 'data:text/html,<p>not Home</p>' })
    await until('the other document', async () => String(await run.call('trust:app-url', { id })).startsWith('data:'))
    await run.call('trust:ipc', { id, channel: 'home:action', msg: { action: 'show-files' } })
    expect(await run.call<unknown[]>('trust:handled')).toHaveLength(1)
    // a channel Home may not send
    await run.call('trust:handle', { channel: 'pill:action' })
    const b = await run.call<{ id: string }>('trust:open-app', { page: 'home' })
    await until('Home loaded', async () => (await run.call<string | null>('trust:app-url', { id: b.id })) === 'marver-app://home/')
    await run.call('trust:ipc', { id: b.id, channel: 'pill:action', msg: { rev: 1, act: 'button' } })
    expect(await run.call<unknown[]>('trust:handled')).toHaveLength(1)
  })

  it('get nothing before they say app:ready, everything once they do, and must say it again after a reload', async () => {
    await run.call('trust:on-ready')
    const { id } = await run.call<{ id: string }>('trust:open-app', { page: 'settings' })
    await until('Settings loaded', async () => (await run.call<string | null>('trust:app-url', { id })) === 'marver-app://settings/')
    expect(await run.call('trust:send', { kind: 'settings', channel: 'status', payload: { rev: 1 } })).toBe(false)
    await run.call('trust:ipc', { id, channel: 'app:ready', msg: null })
    expect(await run.call('trust:readied')).toEqual(['settings'])
    expect(await run.call('trust:send', { kind: 'settings', channel: 'status', payload: { rev: 2 } })).toBe(true)
    await run.call('trust:app-reload', { id })
    await until('the reload', async () => (await run.call<boolean>('trust:send', { kind: 'settings', channel: 'status', payload: { rev: 3 } })) === false)
    await run.call('trust:ipc', { id, channel: 'app:ready', msg: null })
    expect(await run.call('trust:readied')).toEqual(['settings', 'settings'])
    expect(await run.call('trust:send', { kind: 'settings', channel: 'status', payload: { rev: 4 } })).toBe(true)
  })
})
