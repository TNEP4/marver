/**
 * A service worker planted in a canvas's storage before launch (spec 28 A2.3, A2.10, A2.14 #31: S12's page registered
 * again after the clear, so this case is what proves the sweep). A first launch with MARVER_APP_TEST_ALLOW_SW=<ws>
 * (test builds only) lets the page register a worker that answers navigations with a synthesized document - which
 * then serves the next load, unproved and never trusted: why the sweep matters. The next launch, on the same
 * profile and without the switch, sweeps that workspace's storage before its first navigation: the document comes
 * from the network, proved and trusted, and nothing of the worker's runs.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchPW, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { evalIn, inRegistry, open, sleep, tabState, trusted, until } from '../harness/trust.ts'

const slotBase = runSlotBase()
const ws = randomBytes(8).toString('hex')
let env: TestEnv
let run: AppRun | null = null
let f: FakeCanvas

const SW = `self.addEventListener('install', function () { self.skipWaiting() });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()) });
self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') e.respondWith(new Response('<!doctype html><title>from the worker</title><script>window.__fromSW = true</script>synthesized', { headers: { 'content-type': 'text/html' } }))
});`

beforeAll(async () => {
  env = testEnv(slotBase)
  f = await startFakeCanvas({ home: env.home, slotBase, slot: 17, ws, script: `
    window.__sw = 'pending';
    navigator.serviceWorker.register('/sw.js').then(function () { window.__sw = 'registered' }, function (e) { window.__sw = 'failed: ' + e.name });`,
  onRequest: (req, res) => {
    if (!(req.url ?? '').startsWith('/sw.js')) return false
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(SW)
    return true
  } })
  await f.ready
})
afterAll(async () => {
  await run?.close()
  await f?.close()
  env?.cleanup()
})

describe('a planted service worker', () => {
  it('planted: in the run that allows it, the worker then serves the next load - unproved, never trusted', async () => {
    run = await launchPW(env, { extraEnv: { MARVER_APP_TEST_ALLOW_SW: ws } })
    await inRegistry(run, f.port, 'ready')
    const id = await open(run, f.port)
    await trusted(run, id)
    await until('the worker to register', async () => (await evalIn<string>(run!, id, 'window.__sw')) === 'registered')
    await until('the worker to control the page', async () => evalIn<boolean>(run!, id, '!!navigator.serviceWorker.controller'))
    const docs = f.requests.filter((r) => r.path === '/').length
    const gen = (await tabState(run, id)).committed!.gen
    await run.call('trust:reload', { id })
    // the reload's commit first: an executeJavaScript sent while the frame navigates can wait forever (Electron), and
    // with the whole app's pages loading beside it (the merged build) that race is no longer rare
    await until('the reload to commit', async () => ((await tabState(run!, id)).committed?.gen ?? 0) > gen)
    await until('the synthesized document', async () => (await evalIn<boolean | null>(run!, id, 'window.__fromSW === true')) === true)
    const s = await tabState(run, id)
    expect(s.trusted).toBe(false)
    expect(s.committed?.attributed).toBe(false)
    expect(f.requests.filter((r) => r.path === '/').length).toBe(docs)   // no network request: nothing to prove
    expect(await run.call('trust:admit', { id })).toBe(null)
    expect(await run.close()).toBe(0)
    run = null
  })

  it('the next launch sweeps it before the partition\'s first navigation: the document comes from the network, proved', async () => {
    run = await launchPW(env)
    await inRegistry(run, f.port, 'ready')
    const docs = f.requests.filter((r) => r.path === '/').length
    const id = await open(run, f.port)
    const s = await trusted(run, id)
    expect(s.committed?.attributed).toBe(true)
    expect(await evalIn(run, id, 'window.__fromSW === undefined')).toBe(true)
    expect(f.requests.filter((r) => r.path === '/').length).toBe(docs + 1)
    // and its own register() fails now, the script never fetched
    await until('register() to settle', async () => { const v = await evalIn<string>(run!, id, 'window.__sw'); return v !== 'pending' ? v : null })
    expect(await evalIn<string>(run, id, 'window.__sw')).toMatch(/^failed/)
    await sleep(100)
    expect(await evalIn(run, id, '!!navigator.serviceWorker.controller')).toBe(false)
  })
})
