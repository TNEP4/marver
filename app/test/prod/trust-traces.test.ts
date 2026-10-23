/**
 * The navigation adapter's event traces (spec 28 A2.14 #8, #31: proved in the first build, before any page work),
 * with the production switches - Playwright's loader turns the beforeunload check off. Each trace runs against a
 * fake canvas and checks its attribution: overlapping loads of one URL, a redirect, a late failure, a denied link,
 * a refused reload, a stop, a 204 and a download; the answers Chromium renders though they look like no document -
 * a 3xx with no Location or an empty one, a Content-Disposition it cannot parse - refused unless proved, so an
 * impostor's script never runs in the canvas's partition; and `disableDialogs` against the guard (#14): `alert`,
 * `confirm` and `prompt` answer at once and show nothing, while a page holding work still refuses its close.
 * Each trace's raw Electron events are printed, for the record.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proofHeaders } from '../../../src/server/proof.ts'
import { launchProd, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { pageHtml, startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { evalIn, inRegistry, journal, open, sleep, tabState, trusted, until, type TabState } from '../harness/trust.ts'

const slotBase = runSlotBase()
let env: TestEnv
let run: AppRun
let f: FakeCanvas
let me: { instance: string; key: Buffer; port: number } | null = null

const PAGE = pageHtml({ name: 'Traces', script: `
  window.__alert = (function () {
    var t = Date.now(), p;
    var a = alert('x'); var c = confirm('y');
    try { p = prompt('z') } catch (e) { p = 'threw: ' + e.message }
    return JSON.stringify({ a: String(a), c: c, p: p, ms: Date.now() - t })
  })();
  window.marverApp && marverApp.hello({ version: '0.27.1', board: null, page: 'PAGE_0123456789' });` })

function route(req: IncomingMessage, res: ServerResponse): boolean {
  const u = new URL(req.url ?? '/', 'http://x')
  if (!me || (u.pathname !== '/' && u.pathname !== '/index.html')) return false
  const signed = { 'content-type': 'text/html', 'cache-control': 'no-store', ...proofHeaders(me, req.headers['x-mv-nonce']) }
  const q = u.searchParams
  if (q.has('redirect')) { res.writeHead(302, { location: '/index.html?r' }); res.end(); return true }
  if (q.has('204')) { res.writeHead(204); res.end(); return true }
  if (q.has('304')) { res.writeHead(304, { etag: '"x"' }); res.end(); return true }
  if (q.has('download')) { res.writeHead(200, { ...signed, 'content-disposition': 'attachment; filename="x.html"' }); res.end(PAGE); return true }
  // an impostor's answers, unsigned, whose body Chromium renders: a 3xx with no Location or an empty one, and a
  // Content-Disposition whose type is not a token (Chromium reads it as inline)
  const IMPOSTOR = '<!doctype html><title>impostor</title><script>fetch("/pwned?" + encodeURIComponent(String(localStorage.getItem("k"))))</script>'
  if (q.has('noloc')) { res.writeHead(302, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(IMPOSTOR); return true }
  if (q.has('emptyloc')) { res.writeHead(302, { 'content-type': 'text/html', 'cache-control': 'no-store', location: '' }); res.end(IMPOSTOR); return true }
  if (q.has('attx')) { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-disposition': 'attachment x' }); res.end(IMPOSTOR); return true }
  if (q.has('att1')) { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-disposition': 'attachment=1' }); res.end(IMPOSTOR); return true }
  if (q.has('late')) {
    res.writeHead(200, signed)
    res.write('<!doctype html><html><body><p>half a page')
    setTimeout(() => res.socket?.destroy(), 150)
    return true
  }
  const slow = Number(q.get('slow') ?? 0)
  setTimeout(() => { if (!res.destroyed) { res.writeHead(200, signed); res.end(PAGE) } }, slow)
  return true
}

beforeAll(async () => {
  env = testEnv(slotBase)
  run = await launchProd(env)
  f = await startFakeCanvas({ home: env.home, slotBase, slot: 16, onRequest: route })
  me = { instance: f.instance, key: f.key, port: f.port }
  await f.ready
  await inRegistry(run, f.port, 'ready')
}, 60_000)
afterAll(async () => {
  await f?.close()
  await run?.close()
  env?.cleanup()
})

/** The raw Electron events of a webContents since a journal mark, as one line each. */
async function raw(wc: number, since: number): Promise<string[]> {
  return (await journal(run, 'nav')).slice(since).filter((l) => l.data.wc === wc && !String(l.data.event).startsWith('adapter:') && l.data.event !== 'response')
    .map((l) => [l.data.event, l.data.code, l.data.url ? String(l.data.url).replace(f.origin, '') : ''].filter((x) => x !== undefined && x !== '').join(' '))
}
const mark = async () => (await journal(run, 'nav')).length
async function fresh(path = '/'): Promise<TabState> {
  const id = await open(run, f.port, path)
  return await trusted(run, id)
}
const adapterSince = (s: TabState, n: number) => s.events.slice(n).map((e) => e.e)

describe('the adapter\'s traces', () => {
  it('overlapping loads of one URL: two requests, each with its own nonce; the later load commits, attributed, once', async () => {
    const { id } = await run.call<{ id: string }>('trust:open', { port: f.port, load: false })
    const m = await mark()
    const r0 = f.requests.length
    const url = `${f.origin}/?slow=300`
    await run.call('trust:load', { id, url })
    await sleep(80)
    await run.call('trust:load', { id, url })
    const s = await trusted(run, id)
    await sleep(500)   // the first request's answer has come and gone
    const t = await tabState(run, id)
    console.log('overlapping loads of one URL:', (await raw(s.wc, m)).join(' | '))
    const asked = f.requests.slice(r0).filter((r) => r.path === '/')
    expect(asked).toHaveLength(2)
    expect(asked[0].headers['x-mv-nonce']).not.toBe(asked[1].headers['x-mv-nonce'])
    const starts = t.events.filter((e) => e.e.kind === 'start')
    expect(starts).toHaveLength(2)
    expect(t.events.filter((e) => e.e.kind === 'commit').map((e) => e.e.attributed)).toEqual([true])
    expect(t.committed).toMatchObject({ url, attributed: true, gen: starts[1].e.gen })
    expect(t.events.some((e) => e.e.kind === 'fail')).toBe(false)
    expect(t.trusted).toBe(true)
  })

  it('a redirect: the final URL is proved and committed, attributed', async () => {
    const m = await mark()
    const s = await fresh('/?redirect')
    console.log('redirect:', (await raw(s.wc, m)).join(' | '))
    expect(s.committed).toMatchObject({ url: `${f.origin}/index.html?r`, attributed: true })
    expect(s.events.map((e) => e.e.kind)).toEqual(expect.arrayContaining(['start', 'redirect', 'response', 'commit']))
  })

  it('a late failure (the body cut after the commit): did-navigate, then did-fail-load -355, which takes the trust', async () => {
    const s = await fresh()
    const m = await mark()
    const n = s.events.length
    await run.call('trust:load', { id: s.id, url: `${f.origin}/?late` })
    const t = await until('the late failure', async () => { const x = await tabState(run, s.id); return adapterSince(x, n).some((e) => e.kind === 'fail') ? x : null })
    console.log('late failure:', (await raw(s.wc, m)).join(' | '), '| trusted after:', t.trusted)
    const after = adapterSince(t, n)
    expect(after.filter((e) => e.kind === 'commit').map((e) => e.attributed)).toEqual([true])
    expect(after.find((e) => e.kind === 'fail')).toMatchObject({ code: -355, url: `${f.origin}/?late` })
    expect(t.committed?.lost).toBe(true)
    expect(t.trusted).toBe(false)
  })

  it('a denied link: refused before anything commits; the shown document keeps its trust and its bridge', async () => {
    const s = await fresh()
    const m = await mark()
    const n = s.events.length
    await evalIn(run, s.id, `location.href = 'https://example.com/'`)
    await sleep(400)
    const t = await tabState(run, s.id)
    console.log('denied link:', (await raw(s.wc, m)).join(' | ') || '(no event)')
    expect(t.trusted).toBe(true)
    expect(t.committed?.gen).toBe(s.committed?.gen)
    expect(adapterSince(t, n).filter((e) => e.kind === 'commit' || e.kind === 'fail')).toEqual([])
    expect(await run.call<string[]>('trust:opened')).toContain('https://example.com/')
    await evalIn(run, s.id, `marverApp.theme({ dark: true })`)
    await until('the next theme accepted', async () => (await tabState(run, s.id)).current?.theme?.dark === true)
  })

  it('a refused reload (beforeunload after a gesture) starts no navigation and changes nothing; with no gesture it reloads', async () => {
    const s = await fresh()
    await evalIn(run, s.id, `window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = 'unsaved' }); 1`, true)
    const m = await mark()
    await run.call('trust:reload', { id: s.id })
    await sleep(600)
    const t = await tabState(run, s.id)
    console.log('refused reload:', (await raw(s.wc, m)).join(' | ') || '(no event)')
    expect(t.commits).toBe(s.commits)
    expect(t.gen).toBe(s.gen)
    expect(t.trusted).toBe(true)
    const u = await fresh()
    await evalIn(run, u.id, `window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = 'unsaved' }); 1`, false)
    await run.call('trust:reload', { id: u.id })
    const v = await until('the reload without a gesture', async () => { const x = await tabState(run, u.id); return x.commits > u.commits && x.trusted ? x : null })
    expect(v.committed?.attributed).toBe(true)
  })

  it('a stop: the attempt ends with no commit; the shown document keeps its trust', async () => {
    const s = await fresh()
    const n = s.events.length
    const m = await mark()
    await run.call('trust:load', { id: s.id, url: `${f.origin}/?slow=3000` })
    await sleep(200)
    await run.call('trust:stop', { id: s.id })
    await sleep(300)
    const t = await tabState(run, s.id)
    console.log('stop:', (await raw(s.wc, m)).join(' | '))
    expect(adapterSince(t, n).map((e) => e.kind)).toEqual(['start', 'abort'])
    expect(t.trusted).toBe(true)
    expect(t.committed?.gen).toBe(s.committed?.gen)
  })

  it('a 204: no commit, the shown document keeps its trust', async () => {
    const s = await fresh()
    const n = s.events.length
    const m = await mark()
    await run.call('trust:load', { id: s.id, url: `${f.origin}/?204` })
    await sleep(500)
    const t = await tabState(run, s.id)
    console.log('204:', (await raw(s.wc, m)).join(' | '))
    expect(adapterSince(t, n).map((e) => e.kind)).toEqual(['start', 'abort'])
    expect(t.trusted).toBe(true)
  })

  it('a 304 is not a redirect: refused like any answer without a proof', async () => {
    const s = await fresh()
    const n = s.events.length
    await run.call('trust:load', { id: s.id, url: `${f.origin}/?304` })
    const t = await until('the 304 refused', async () => { const x = await tabState(run, s.id); return adapterSince(x, n).some((e) => e.kind === 'fail') ? x : null })
    expect(adapterSince(t, n).find((e) => e.kind === 'fail')).toMatchObject({ why: 'unverified', code: -20 })
    expect(t.trusted).toBe(false)
  })

  it('a download, signed: proved like a page, then no commit; the shown document keeps its trust; the shell\'s document is never saved', async () => {
    const s = await fresh()
    const n = s.events.length
    const m = await mark()
    await run.call('trust:load', { id: s.id, url: `${f.origin}/?download` })
    await sleep(600)
    const t = await tabState(run, s.id)
    console.log('download:', (await raw(s.wc, m)).join(' | '))
    expect(adapterSince(t, n).map((e) => e.kind)).toEqual(['start', 'response', 'abort'])
    expect(t.trusted).toBe(true)
    // what the production handler decided, as the test build records it before it keeps the save sheet away
    expect((await journal(run, 'download')).map((l) => l.data)).toEqual([{ url: `${f.origin}/?download`, wc: s.wc, saved: false, why: 'the canvas\'s own document' }])
  })

  for (const [q, what] of [['noloc', 'a 302 with no Location'], ['emptyloc', 'a 302 with an empty Location'], ['attx', 'Content-Disposition: attachment x'], ['att1', 'Content-Disposition: attachment=1']] as const) {
    it(`${what}, unsigned: Chromium would render it - refused like any unproved answer, and its script never runs`, async () => {
      const s = await fresh()
      await evalIn(run, s.id, `localStorage.setItem('k', 'the canvas own'); 1`)
      const n = s.events.length
      const m = await mark()
      const r0 = f.requests.length
      await run.call('trust:load', { id: s.id, url: `${f.origin}/?${q}` })
      const t = await until(`${what} refused`, async () => { const x = await tabState(run, s.id); return adapterSince(x, n).some((e) => e.kind === 'fail') ? x : null })
      await sleep(300)
      const u = await tabState(run, s.id)
      console.log(`${what}:`, (await raw(s.wc, m)).join(' | '))
      expect(adapterSince(t, n).find((e) => e.kind === 'fail')).toMatchObject({ why: 'unverified', code: -20 })
      expect(adapterSince(u, n).some((e) => e.kind === 'commit')).toBe(false)
      expect(u.trusted).toBe(false)
      expect(f.requests.slice(r0).filter((r) => r.path === '/pwned')).toEqual([])
    })
  }
})

describe('dialogs (A2.14 #14)', () => {
  it('alert, confirm and prompt answer at once and show nothing; a page holding work still refuses its close', async () => {
    const s = await fresh()
    const a = JSON.parse(await evalIn<string>(run, s.id, 'window.__alert')) as { a: string; c: boolean; p: string | null; ms: number }
    console.log('dialogs at document start:', JSON.stringify(a))
    // Electron implements no prompt(): it throws, whatever disableDialogs says (A2.14 #14 said it answers null)
    expect(a).toMatchObject({ a: 'undefined', c: false, p: 'threw: prompt() is not supported.' })
    expect(a.ms).toBeLessThan(200)
    await evalIn(run, s.id, `window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = 'unsaved' }); 1`, true)
    await run.call('trust:eval', { id: s.id, js: '1' })
    const closed = await run.call<boolean>('trust:close-guarded', { id: s.id })
    expect(closed).toBe(false)
    expect((await tabState(run, s.id)).trusted).toBe(true)
  })
})
