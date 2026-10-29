/**
 * Shared canvases (spec 28 A4.4, A4.6 #39-#50, #51, #52, r1 #8, r1 #9): the app against the remote harness's
 * `*.canvas.test` hosts over https (test/harness/remote-canvas.ts), through its test switches. Opening one tab per
 * origin, the hash-only link and the guarded one, no `marverApp`, the navigation and window policy, the front door,
 * downloads and permissions, the app's keys over a page that swallows them, crashes, ⌘W and ⌘R asking; the sign-in
 * chain - its place never a sign-in URL, cut short at finish then reopened from Home, kept across a relaunch, never
 * restored; recovery - unreachable then answering, offline to online, a bad certificate; the quit and update sheets;
 * the overflow with twenty local canvases and two shared ones (A2.10's case, made explicit by A4.6 #51 - here, since
 * it needs the remote harness's hosts at launch).
 * A page's own beforeunload veto after consent is the production-switch harness's (Playwright's loader turns
 * Chromium's beforeunload check off): test/prod/remote-guard.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, SWALLOW_KEYS, type State, type TabDump, type WindowRun } from '../harness/window.ts'
import { startRemoteCanvas, type RemoteCanvas } from '../harness/remote-canvas.ts'
import type { LinkOpenAnswer, SharedLink } from '../../src/shared/channels.ts'

let r: RemoteCanvas
let w: WindowRun
beforeAll(async () => { r = await startRemoteCanvas() })
afterAll(async () => { await r?.close() })

const host = (name: string) => `${name}.canvas.test:${r.port}`
const shared = (s: State, name: string) => s.tabs.find((t) => t.kind === 'remote' && t.remote?.origin === r.origin(name))
const open = (url: string) => w.run.call<LinkOpenAnswer>('remote:open', { url })
const exec = <T = unknown>(id: string, js: string, gesture = false) => w.run.call<T>('exec', { target: id, js, gesture })
const opened = () => w.run.call<string[]>('trust:opened')
const sheets = async () => (await w.run.call<{ shown: Record<string, any>[]; held: number }>('sheets'))
/** opens `name`'s link and waits for its tab's document to lift */
async function lifted(name: string, path = '/'): Promise<TabDump> {
  expect(await open(r.url(name, path))).toEqual({ ok: true })
  const s = await w.until((x) => !!shared(x, name)?.doc?.lifted, 15_000, `${name} lifted`)
  return shared(s, name)!
}
const now = async (name: string) => shared(await w.state(), name)!
/** a page that signs in when it has no session, as a published canvas's gate sends you through Marver ID */
const SIGN_IN = "if (!document.cookie.includes('mvsession=')) location.href = '/__mv/id/start?next=' + encodeURIComponent(location.pathname + location.search + location.hash)"

describe('opening, the policy, the guard (A4.6 #39-#43, #45, #49)', () => {
  let local: string
  beforeAll(async () => { w = await launchWindow('pw', { extraEnv: r.env }) })
  afterAll(async () => { await w?.close() })

  it('an https link opens its origin\'s tab: its host its name, after the local canvases, lifted at its commit, never trusted, below the strip', async () => {
    local = (await w.canvas({ slot: 1, name: 'Tidewell' })).id
    const t = await lifted('pilot', '/#/b/main')
    const s = await w.state()
    expect(t).toMatchObject({ kind: 'remote', name: host('pilot'), retained: true, remote: { origin: r.origin('pilot'), url: r.url('pilot', '/#/b/main'), host: host('pilot') } })
    expect(t.doc).toMatchObject({ trusted: false, lifted: true })
    expect(s.canvases).toEqual([local, t.id])
    expect(s.order.indexOf(t.id)).toBeGreaterThan(s.order.indexOf(local))
    expect((await w.views()).find((v) => v.key === `${t.id}:view`)).toMatchObject({ visible: true, bounds: { y: 44 } })
  })

  it('a shared canvas has no marverApp, no app channel and no Node', async () => {
    const t = await now('pilot')
    expect(await exec(t.id, 'typeof window.marverApp + "|" + typeof window.marverPage + "|" + typeof window.require + "|" + typeof window.process')).toBe('undefined|undefined|undefined|undefined')
  })

  it('the same origin again: its tab activated, a hash-only link unasked - the same document, its place following', async () => {
    const t = await now('pilot')
    await w.run.call('activate', { id: 'home' })
    const since = (await w.log()).length
    expect(await open(r.url('pilot', '/#/b/other'))).toEqual({ ok: true })
    const s = await w.until((x) => shared(x, 'pilot')!.remote!.url === r.url('pilot', '/#/b/other'), 5000, 'its place')
    expect(s.active).toBe(t.id)
    expect(shared(s, 'pilot')!.doc!.commits).toBe(t.doc!.commits)
    expect(await w.log('guard', since)).toEqual([])
    expect(s.tabs.filter((x) => x.kind === 'remote')).toHaveLength(1)
  })

  it('a link that changes more than the hash asks first, naming the host: Cancel keeps the page, Open loads it; a page that is not the shell leaves its place', async () => {
    const t = await now('pilot')
    await w.run.call('sheet', { mode: 'cancel' })
    expect(await open(r.url('pilot', '/?view=2'))).toEqual({ ok: false, why: 'refused' })
    const last = (await sheets()).shown.at(-1)!
    expect(last).toMatchObject({ kind: 'guard', action: 'load', tabs: [t.id], message: `Open the link in ${host('pilot')} anyway?` })
    expect(last.detail).toContain(`${host('pilot')} is a shared canvas: the app can't tell what it hasn't saved.`)
    expect((await now('pilot')).doc!.commits).toBe(t.doc!.commits)
    await w.run.call('sheet', { mode: 'confirm' })
    expect(await open(r.url('pilot', '/?view=2'))).toEqual({ ok: true })
    await w.until((x) => shared(x, 'pilot')!.doc!.commits > t.doc!.commits && shared(x, 'pilot')!.remote!.url === r.url('pilot', '/?view=2'), 10_000, 'the shell page')
    const before = (await now('pilot')).doc!.commits
    expect(await open(r.url('pilot', '/about'))).toEqual({ ok: true })
    await w.until((x) => shared(x, 'pilot')!.doc!.commits > before, 10_000, '/about')
    expect((await now('pilot')).remote!.url).toBe(r.url('pilot', '/?view=2'))
    expect(await open(r.url('pilot', '/?view=2'))).toEqual({ ok: true })
    await w.until((x) => shared(x, 'pilot')!.doc!.url.startsWith(r.url('pilot', '/?view=2')), 10_000, 'back on the shell')
  })

  it('its main frame: http goes to the browser, a loopback host nowhere; window.open of its own origin stays in its tab, another site to the browser - never a child window', async () => {
    const t = await now('pilot')
    await exec(t.id, "location.href = 'http://example.com/plain'; 1")
    for (let i = 0; i < 40 && !(await opened()).includes('http://example.com/plain'); i++) await sleep(50)
    expect(await opened()).toContain('http://example.com/plain')
    await sleep(1100)   // openOutside: one a second
    await exec(t.id, `location.href = 'https://localhost:${r.port}/'; 1`)
    await sleep(500)
    expect((await now('pilot')).doc!.commits).toBe(t.doc!.commits)
    expect((await opened()).some((u) => u.includes('localhost'))).toBe(false)
    const at = await exec<string>(t.id, 'location.origin + location.pathname + location.search')
    await exec(t.id, `window.open('${at}#/b/win'); 1`, true)
    await w.until((x) => shared(x, 'pilot')!.remote!.url === `${at}#/b/win`, 5000, 'its own window.open in its tab')
    await sleep(1100)
    await exec(t.id, "window.open('https://docs.example.com/page'); 1", true)
    for (let i = 0; i < 40 && !(await opened()).includes('https://docs.example.com/page'); i++) await sleep(50)
    expect(await opened()).toContain('https://docs.example.com/page')
    expect((await w.state()).tabs.filter((x) => x.kind === 'remote')).toHaveLength(1)
  })

  it('the front door\'s window.open of a canvas opens that canvas in a tab of its own', async () => {
    const door = await lifted('door', '/')
    await exec(door.id, `window.open('${r.url('tide', '/#/b/x')}'); 1`, true)
    const s = await w.until((x) => !!shared(x, 'tide')?.doc?.lifted, 15_000, 'the canvas the front door opened')
    expect(s.active).toBe(shared(s, 'tide')!.id)
    expect(shared(s, 'tide')!.remote!.url).toBe(r.url('tide', '/#/b/x'))
  })

  it('a download is cancelled, never a save sheet; notices and the location denied, the clipboard granted', async () => {
    const t = await now('pilot')
    await w.run.call('activate', { id: t.id })
    const since = (await w.log()).length
    await exec(t.id, "location.href = '/download'; 1")
    let d: unknown[] = []
    for (let i = 0; i < 40 && !(d = await w.log('download', since)).length; i++) await sleep(50)
    expect(d.map((l) => (l as { data: unknown }).data)).toEqual([expect.objectContaining({ saved: false, why: 'a shared canvas' })])
    expect(await exec(t.id, 'Notification.requestPermission()', true)).toBe('denied')
    expect(await exec(t.id, "navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)")).toBe('denied')
    expect(await exec(t.id, "navigator.permissions.query({ name: 'clipboard-write' }).then((p) => p.state)")).toBe('granted')
  })

  it('the app\'s keys win over a shared page that swallows every key', async () => {
    r.page('keys', { script: SWALLOW_KEYS })
    const k = await lifted('keys', '/')
    for (let i = 0; i < 100 && r.hits('keys', '/__mv/test/script') < 1; i++) await sleep(50)
    await w.run.call('key', { target: k.id, keyCode: '1', modifiers: ['meta'] })
    await w.until((x) => x.active === local, 3000, '⌘1 over the page')
  })

  it('⌘R and ⌘W ask, naming the host: Cancel keeps the page as it was; Reload reloads it', async () => {
    const t = await now('pilot')
    await w.run.call('activate', { id: t.id })
    await w.run.call('sheet', { mode: 'cancel' })
    const n = (await sheets()).shown.length
    await w.run.call('command', { cmd: 'reload' })
    await w.run.call('command', { cmd: 'close-tab' })
    for (let i = 0; i < 40 && (await sheets()).shown.length < n + 2; i++) await sleep(50)
    expect((await sheets()).shown.slice(n).map((x) => [x.action, x.tabs])).toEqual([['reload', [t.id]], ['close', [t.id]]])
    expect(await now('pilot')).toMatchObject({ id: t.id, doc: { commits: t.doc!.commits } })
    await w.run.call('sheet', { mode: 'confirm' })
    await w.run.call('command', { cmd: 'reload' })
    await w.until((x) => shared(x, 'pilot')!.doc!.commits > t.doc!.commits && !!shared(x, 'pilot')!.doc!.lifted, 10_000, 'reloaded')
  })

  it('its tab menu: Open in Browser, Copy Link, Reload, Force Reload, Close Tab - no Reveal in Finder, no Mark All as Seen', async () => {
    const t = await now('pilot')
    await w.run.call('tabMenu', { id: t.id })
    const pop = (await w.log('popup')).at(-1)!.data as { items: { label: string }[] }
    expect(pop.items.map((i) => i.label)).toEqual(['Open in Browser', 'Copy Link', 'Reload', 'Force Reload', 'Close Tab'])
    await w.run.call('popup:click', { label: 'Copy Link' })
    expect((await w.run.call<{ copies: string[] }>('effects')).copies.at(-1)).toBe(t.remote!.url)
  })

  it('a crash reloads its place once, in a new renderer; a second within 60 s latches, its page saying so', async () => {
    const t = await now('pilot')
    await w.run.call('activate', { id: t.id })
    await w.run.call('crash', { target: t.id })
    await w.until((x) => { const y = shared(x, 'pilot')!; return y.crash.count === 1 && !!y.doc?.lifted && y.doc.commits > t.doc!.commits }, 15_000, 'reloaded after the crash')
    await w.run.call('crash', { target: t.id })
    await w.until((x) => shared(x, 'pilot')!.crash.latched, 10_000, 'latched')
    expect(await w.run.call('page', { tab: t.id })).toMatchObject({ body: { page: 'crashed', latched: true, name: host('pilot') } })
    await w.run.call('tabpage:action', { tab: t.id, action: 'reload' })
    await w.until((x) => !!shared(x, 'pilot')!.doc?.lifted, 15_000, 'the person\'s reload')
  })

  it('⌘W with Close: the tab goes, its canvas listed on Home', async () => {
    const t = await now('pilot')
    await w.run.call('activate', { id: t.id })
    await w.run.call('sheet', { mode: 'confirm' })
    await w.run.call('command', { cmd: 'close-tab' })
    await w.until((x) => !x.tabs.some((y) => y.id === t.id), 10_000, 'closed')
    expect((await w.run.call<SharedLink[]>('home.shared')).map((l) => l.host)).toContain(host('pilot'))
  })
})

describe('the sign-in chain, Home and a relaunch (A4.6 #39, #47, r1 #9)', () => {
  beforeAll(async () => {
    r.page('pilot', { script: SIGN_IN })
    r.page('flow', { script: SIGN_IN })
    w = await launchWindow('pw', { extraEnv: r.env })
  })
  afterAll(async () => { await w?.close() })

  it('a sign-in through the identity host and back: the tab stays the canvas\'s, its place never a sign-in URL, the board kept', async () => {
    expect(await open(r.url('pilot', '/#/b/plans'))).toEqual({ ok: true })
    await w.until((x) => { const t = shared(x, 'pilot'); return !!t?.doc?.lifted && t.doc.url === r.url('pilot', '/#/b/plans') }, 20_000, 'signed in, back on the board')
    const t = await now('pilot')
    expect(r.hits('id', '/login')).toBe(1)
    expect(t).toMatchObject({ name: host('pilot'), remote: { origin: r.origin('pilot'), url: r.url('pilot', '/#/b/plans') } })
    expect(await exec<string>(t.id, 'document.cookie')).toContain('mvsession=abc')
    await w.run.call('home.flush')
    const file = readFileSync(join(w.env.home, 'state-dev', 'shared.json'), 'utf8')
    expect(JSON.parse(file).links).toEqual([expect.objectContaining({ url: r.url('pilot', '/#/b/plans'), host: host('pilot') })])
    expect(file).not.toMatch(/__mv|code=/)
  })

  it('cut short at finish and closed there: its place still the board first opened, which Home\'s Shared canvases reopen', async () => {
    r.finishStalls = true
    expect(await open(r.url('flow', '/#/b/flow'))).toEqual({ ok: true })
    await w.until((x) => !!shared(x, 'flow')?.doc?.url.includes('/__mv/id/finish'), 20_000, 'stalled at finish')
    const t = await now('flow')
    expect(t.remote!.url).toBe(r.url('flow', '/#/b/flow'))
    await w.run.call('sheet', { mode: 'confirm' })
    expect(await w.run.call('close', { id: t.id })).toBe('closed')
    const links = await w.run.call<SharedLink[]>('home.shared')
    const flow = links.find((l) => l.host === host('flow'))!
    expect(flow.url).toBe(r.url('flow', '/#/b/flow'))
    expect(links.some((l) => l.url.includes('__mv'))).toBe(false)
    r.finishStalls = false
    expect(await open(flow.url)).toEqual({ ok: true })
    await w.until((x) => shared(x, 'flow')?.doc?.url === r.url('flow', '/#/b/flow'), 20_000, 'the board first opened')
  })

  it('a board changed by its hash moves the place', async () => {
    const t = await now('pilot')
    await exec(t.id, "location.hash = '#/b/elsewhere'; 1")
    await w.until((x) => shared(x, 'pilot')!.remote!.url === r.url('pilot', '/#/b/elsewhere'), 5000, 'the hash')
  })

  it('relaunched: no shared tab restored, Home lists them, and reopening one needs no second sign-in', async () => {
    const env = w.env
    await w.close({ keep: true })
    w = await launchWindow('pw', { env, extraEnv: r.env })
    const s = await w.state()
    expect(s.tabs.filter((t) => t.kind === 'remote')).toEqual([])
    expect((await w.run.call<SharedLink[]>('home.shared')).map((l) => l.host)).toEqual(expect.arrayContaining([host('pilot'), host('flow')]))
    const logins = r.hits('id', '/login')
    expect(await open(r.url('pilot', '/#/b/elsewhere'))).toEqual({ ok: true })
    await w.until((x) => !!shared(x, 'pilot')?.doc?.lifted, 15_000, 'reopened')
    expect(r.hits('id', '/login')).toBe(logins)
  })
})

describe('recovery, split by what is kept (A4.6 #44)', () => {
  beforeAll(async () => { w = await launchWindow('pw', { extraEnv: r.env }) })
  afterAll(async () => { await w?.close() })

  it('online but unreachable: a look within 5 s of the server answering again, then a load', async () => {
    await r.pause()
    expect(await open(r.url('rec', '/'))).toEqual({ ok: true })
    await w.until((x) => shared(x, 'rec')?.state === 'unreachable', 15_000, 'unreachable')
    const t = await now('rec')
    expect(await w.run.call('page', { tab: t.id })).toMatchObject({ body: { page: 'unreachable', name: host('rec'), origin: r.origin('rec'), retained: false } })
    await r.resume()
    const at = Date.now()
    await w.until((x) => !!shared(x, 'rec')?.doc?.lifted, 10_000, 'answering again')
    expect(Date.now() - at).toBeLessThan(6500)
  })

  it('a bad certificate: unreachable for its certificate, nothing offered past it; Open in Browser sends its place outside', async () => {
    const url = `${r.bad.origin('pilot')}/`
    expect(await open(url)).toEqual({ ok: true })
    await w.until((x) => x.tabs.some((t) => t.kind === 'remote' && t.remote?.origin === r.bad.origin('pilot') && t.state === 'unreachable'), 15_000, 'refused')
    const t = (await w.state()).tabs.find((x) => x.remote?.origin === r.bad.origin('pilot'))!
    expect(await w.run.call('page', { tab: t.id })).toMatchObject({ body: { page: 'unreachable', reason: 'certificate' } })
    await sleep(6000)   // a look that only probes: still refused, no document
    const still = (await w.state()).tabs.find((x) => x.id === t.id)!
    expect([still.state, still.doc?.lifted ?? false]).toEqual(['unreachable', false])
    expect(r.requests.some((q) => q.host === 'bad:pilot' && q.path === '/')).toBe(false)
    await w.run.call('tabpage:action', { tab: t.id, action: 'open-browser' })
    expect(await opened()).toContain(url)
  })
})

describe('offline to online (A4.6 #44)', () => {
  // the hidden tab's next retry a minute away: only isOnline's turn can bring it back within the second
  beforeAll(async () => { w = await launchWindow('pw', { extraEnv: { ...r.env, MARVER_APP_TIMINGS: JSON.stringify({ retryMs: [60_000], retryEveryMs: 60_000, activeCheckMs: 60_000 }) } }) })
  afterAll(async () => { await w?.close() })

  it('a look within 1 s of isOnline turning true (stubbed), then a load', async () => {
    await w.run.call('remote:online', { online: false })
    await r.pause()
    expect(await open(r.url('net', '/'))).toEqual({ ok: true })
    await w.until((x) => shared(x, 'net')?.state === 'unreachable', 15_000, 'unreachable')
    await w.run.call('activate', { id: 'home' })
    await r.resume()
    await sleep(1500)
    expect((await now('net')).doc?.lifted ?? false).toBe(false)   // nothing looked: its next retry is a minute away
    const at = Date.now()
    await w.run.call('remote:online', { online: true })
    await w.until((x) => !!shared(x, 'net')?.doc?.lifted, 5000, 'online again')
    expect(Date.now() - at).toBeLessThan(2500)
  })
})

describe('the quit and the update take shared canvases (A4.6 #43, r1 #8)', () => {
  beforeAll(async () => { w = await launchWindow('pw', { extraEnv: r.env }) })
  afterAll(async () => { await w?.close() })

  it('a quit with only a shared canvas: one sheet naming it, its line; Cancel keeps it', async () => {
    const t = await lifted('quit', '/')
    await w.run.call('sheet', { mode: 'cancel' })
    expect(await w.run.call('guardAll', { action: { kind: 'quit' } })).toBe('refused')
    const last = (await sheets()).shown.at(-1)!
    expect(last).toMatchObject({ kind: 'guard', action: 'quit', tabs: [t.id], message: 'Quit Marver anyway?' })
    expect(last.detail).toContain(`${host('quit')} is a shared canvas`)
    expect((await now('quit')).doc!.commits).toBe(t.doc!.commits)
  })

  it('a shared page that commits again while the quit\'s sheet is up refuses the quit', async () => {
    const t = await now('quit')
    await w.run.call('sheet', { mode: 'hold' })
    const quit = w.run.call('guardAll', { action: { kind: 'quit' } })
    for (let i = 0; i < 40 && (await sheets()).held < 1; i++) await sleep(50)
    await exec(t.id, 'location.reload(); 1')
    await w.until((x) => shared(x, 'quit')!.doc!.commits > t.doc!.commits, 10_000, 'committed again')
    await w.run.call('sheet:answer', { ok: true })
    expect(await quit).toBe('refused')
    expect((await w.state()).tabs.some((x) => x.id === t.id)).toBe(true)
  })

  it('an update with a local canvas not yet heard and a shared one: the one sheet names both, each with its own line', async () => {
    const local = await w.canvas({ slot: 2, name: 'Gen lab' })
    await w.run.call('activate', { id: local.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === local.id)?.doc?.lifted, 10_000, 'local lifted')
    const t = await now('quit')
    await w.run.call('sheet', { mode: 'cancel' })
    expect(await w.run.call('guardAll', { action: { kind: 'update' } })).toBe('refused')
    const last = (await sheets()).shown.at(-1)!
    expect(last.tabs).toEqual([local.id, t.id])
    expect(last.detail).toContain("Gen lab hasn't told the app yet whether it holds unsaved work.")
    expect(last.detail).toContain(`${host('quit')} is a shared canvas: the app can't tell what it hasn't saved.`)
  })
})

describe('the overflow: twenty local canvases and two shared ones at 720 px (A2.10, A4.6 #39, #51)', () => {
  const strip = <T>(js: string) => w.run.call<T>('exec', { target: 'strip', js })
  beforeAll(async () => { w = await launchWindow('pw', { extraEnv: r.env }) })
  afterAll(async () => { await w?.close() })

  it('the shared ones last in opening order, behind »; ⌘9 the last of them; one chosen from » shows; » counts them', async () => {
    const locals: string[] = []
    for (let i = 1; i <= 20; i++) locals.push((await w.canvas({ slot: i, name: `Canvas ${i}` })).id)
    const ids: string[] = []
    for (const name of ['first', 'second']) {
      expect(await w.run.call('remote:open', { url: r.url(name, '/') })).toEqual({ ok: true })
      const s = await w.until((x) => !!x.tabs.find((t) => t.remote?.origin === r.origin(name))?.doc?.lifted, 15_000, `${name} lifted`)
      ids.push(s.tabs.find((t) => t.remote?.origin === r.origin(name))!.id)
    }
    await w.run.call('resize', { width: 720, height: 600 })
    await w.run.call('activate', { id: locals[0] })
    const s = await w.state()
    expect(s.canvases).toEqual([...locals, ...ids])
    expect(s.order.slice(-2)).toEqual(ids)
    await new Promise((res) => setTimeout(res, 300))
    const hidden = await strip<string[]>("[...document.querySelectorAll('#tabs > [data-id]')].filter((e) => e.hidden).map((e) => e.dataset.id)")
    expect(hidden).toEqual(expect.arrayContaining(ids))
    expect(await strip<string>("document.getElementById('more').getAttribute('aria-label')")).toBe(`${hidden.length} more canvases`)
    // ⌘9: the last canvas tab, the second shared one
    await w.run.call('key', { target: 'strip', keyCode: '9', modifiers: ['meta'] })
    await w.until((x) => x.active === ids[1], 3000, '⌘9')
    // the first shared one, chosen from »: it shows
    await w.run.call('activate', { id: locals[0] })
    await w.run.call('tabsMore', { ids: hidden })
    expect(await w.run.call('popup:click', { label: `first.canvas.test:${r.port}` })).toBe(true)
    await w.until((x) => x.active === ids[0], 3000, 'chosen from »')
    await new Promise((res) => setTimeout(res, 300))
    expect(await strip<boolean>(`document.querySelector('[data-id="${ids[0]}"]').hidden`)).toBe(false)
    expect(await strip<string>(`document.querySelector('[data-id="${ids[0]}"]').getAttribute('aria-label')`)).toBe(`first.canvas.test:${r.port}, shared canvas`)
  })
})
