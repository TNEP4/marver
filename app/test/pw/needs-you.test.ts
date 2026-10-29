/**
 * What needs you (spec 28 A4.2, A4.6 #17-#29, #51, #52's pw cases), on the dev build under Playwright with the fake
 * presenter (testing/notices.ts: nothing reaches macOS, every create, post and badge journaled):
 *
 * - the strip's marks, its real page under a fake main (test/harness/pages.ts): the orange count (99+), else the blue
 *   one, else the sweep (a still wash under Reduce Motion), the teal session dot, a stale mark dimmed, each said in
 *   the tab's name; the live region's "<name> needs you" never for a tab's first marks, once a minute at most;
 * - the app on the real trust and registry against fake canvases serving the live stream: the strip's count and one
 *   post with the window away; nothing old after a reconnect, an item born in the gap posting; in front, the mark
 *   only, and another tab active with the window focused, a post; working and session; `kill -9` giving one Stopped
 *   post and its count until the tab is shown, a SIGTERM none; a click on a never-shown tab delivered to its
 *   document after its hello; a refused notice raising the pill; the offer once, Turn On writing
 *   `notifications: true` and journaling one create and two canvases summed on the badge, Not now across a relaunch.
 *
 * Unloaded tabs' delivery and the held click's 15 s are tabs.ts's (test/unit/tabs.test.ts); a stale click's
 * resolution is the shell's (the package's browser cases).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LiveItem } from '../../../src/shared/app-api.ts'
import type { TabsSnapshot, TabView } from '../../src/shared/channels.ts'
import { launchPW, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { startFakeCanvas, type FakeCanvas, type FakeOptions } from '../harness/fake-canvas.ts'
import { animatedProperties, openPage, type PageRun } from '../harness/pages.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  for (;;) {
    try { last = await f() } catch (err) { last = err }
    if (last && !(last instanceof Error)) return last as T
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 600)}`)
    await sleep(40)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The strip's marks (A4.6 #19, A2.13)

const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, name: string, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name, state: 'live', verified: true, open: true, link: `http://localhost:${4900 + Number(id.slice(1))}/`, ...over })
let rev = 0
const snap = (active: string, tabs: TabView[]): TabsSnapshot => ({ rev: ++rev, active, tabs })
const marks = (o: Partial<NonNullable<TabView['marks']>>) => ({ needs: 0, unseen: 0, working: false, session: false, ...o })

describe('the strip\'s marks (A4.6 #19)', () => {
  let p: PageRun
  beforeAll(async () => { p = await openPage('strip', { width: 1280, height: 44 }); await p.send('pill', null) })
  afterAll(async () => { await p?.close() })
  const read = (id: string) => p.page.$eval(`[data-id="${id}"]`, (e) => ({
    cls: e.className, mark: e.querySelector('.mk')?.textContent ?? null, markCls: e.querySelector('.mk')?.className ?? null,
    sess: !!e.querySelector('.slot .sess'), label: e.getAttribute('aria-label'), order: [...e.children].map((c) => c.className),
  }))

  it('needs you: an orange count after the name and before the key, 99+ past 99, said in the tab\'s name; no sweep beside it', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'Pilot', { key: 1, marks: marks({ needs: 3, unseen: 5, working: true }) }), tab('t2', 'Tidewell', { key: 2, marks: marks({ needs: 150 }) }), tab('t3', 'One', { key: 3, marks: marks({ needs: 1 }) })]))
    const a = await read('t1')
    expect(a).toMatchObject({ mark: '3', markCls: 'mk ask', label: 'Pilot, 3 need you', sess: false })
    expect(a.order).toEqual(['slot', 'name', 'mk ask', 'key'])
    expect(a.cls).not.toMatch(/working/)
    expect((await read('t2')).mark).toBe('99+')
    expect((await read('t3')).label).toBe('One, 1 needs you')
    const [bg, mkAsk] = await p.page.$eval('[data-id="t1"] .mk', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--mk-ask').trim()])
    expect(mkAsk).not.toBe('')
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('else new frames: a blue count; else an agent at work: the bubble sweeps, no count - a still wash under Reduce Motion', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'Pilot', { marks: marks({ unseen: 2, working: true }) }), tab('t2', 'Tidewell', { marks: marks({ unseen: 1 }) }), tab('t3', 'One', { marks: marks({ working: true }) })]))
    expect(await read('t1')).toMatchObject({ mark: '2', markCls: 'mk new', label: 'Pilot, 2 new frames' })
    expect((await read('t2')).label).toBe('Tidewell, 1 new frame')
    const w = await read('t3')
    expect(w).toMatchObject({ mark: null, label: 'One, agent working' })
    expect(w.cls).toMatch(/\bworking\b/)
    expect((await animatedProperties(p.page)).some((x) => x.name === 'mv-sweep')).toBe(true)
    await p.media({ 'prefers-reduced-motion': 'reduce' })
    expect((await animatedProperties(p.page)).some((x) => x.name === 'mv-sweep')).toBe(false)
    expect(await p.page.$eval('[data-id="t3"]', (e) => getComputedStyle(e, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await p.media({ 'prefers-reduced-motion': 'no-preference' })
  })

  it('a Jam session: a teal dot on the logo\'s corner whatever the slot shows; a stream down: the mark dimmed, "may be out of date"', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'Pilot', { marks: marks({ needs: 2, session: true, stale: true }) }), tab('t2', 'Tidewell', { marks: marks({ session: true }) })]))
    expect(await read('t1')).toMatchObject({ mark: '2', sess: true, label: 'Pilot, 2 need you, Jam session on, may be out of date' })
    expect((await read('t1')).cls).toMatch(/\bstale\b/)
    expect(await p.page.$eval('[data-id="t1"] .mk', (e) => getComputedStyle(e).opacity)).toBe('0.45')
    expect(await read('t2')).toMatchObject({ mark: null, sess: true, label: 'Tidewell, Jam session on' })
  })

  it('no marks: nothing drawn; Home and Settings never have any', async () => {
    await p.send('tabs', snap('t1', [home, tab('t1', 'Pilot'), { id: 'settings', kind: 'settings', name: 'Settings', state: 'hidden', verified: false, open: true }]))
    expect(await read('t1')).toMatchObject({ mark: null, sess: false, label: 'Pilot' })
    expect(await p.page.$$eval('.mk, .sess', (els) => els.length)).toBe(0)
  })

  it('the live region: never for a tab\'s first marks; "<name> needs you" on a rise, once a minute; a fall says nothing', async () => {
    const q = await openPage('strip', { width: 1280, height: 44 })
    const live = () => q.page.$eval('#live', (e) => e.textContent)
    try {
      await q.send('tabs', { rev: 1, active: 't1', tabs: [home, tab('t1', 'Pilot', { marks: marks({ needs: 1 }) })] })
      await q.send('pill', null)
      await q.send('tabs', { rev: 2, active: 't1', tabs: [home, tab('t1', 'Pilot', { marks: marks({ needs: 1 }) }), tab('t2', 'Tidewell', { marks: marks({ needs: 4 }) })] })
      await q.page.waitForTimeout(100)
      expect(await live()).toBe('')   // what was found at launch, and a canvas's first marks
      await q.send('tabs', { rev: 3, active: 't1', tabs: [home, tab('t1', 'Pilot', { marks: marks({ needs: 2 }) }), tab('t2', 'Tidewell', { marks: marks({ needs: 3 }) })] })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'Pilot needs you')
      await q.send('tabs', { rev: 4, active: 't1', tabs: [home, tab('t1', 'Pilot', { marks: marks({ needs: 5 }) }), tab('t2', 'Tidewell', { marks: marks({ needs: 3 }) })] })
      await q.page.waitForTimeout(100)
      expect(await live()).toBe('Pilot needs you')   // once per tab per minute
      await q.send('tabs', { rev: 5, active: 't1', tabs: [home, tab('t1', 'Pilot', { marks: marks({ needs: 5 }) }), tab('t2', 'Tidewell', { marks: marks({ needs: 6 }) })] })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'Tidewell needs you')
      // a stop as a tab's first marks, acknowledged at its restart's ready (no marks), then the workspace's first
      // snapshot: first marks again, said nothing; a rise after it is said
      const two = [tab('t1', 'Pilot', { marks: marks({ needs: 5 }) }), tab('t2', 'Tidewell', { marks: marks({ needs: 6 }) })]
      await q.send('tabs', { rev: 6, active: 't1', tabs: [home, ...two, tab('t3', 'One', { state: 'gone', marks: marks({ needs: 1 }) })] })
      await q.send('tabs', { rev: 7, active: 't1', tabs: [home, ...two, tab('t3', 'One', { state: 'starting' })] })
      await q.send('tabs', { rev: 8, active: 't1', tabs: [home, ...two, tab('t3', 'One', { marks: marks({ needs: 3 }) })] })
      await q.page.waitForTimeout(100)
      expect(await live()).toBe('Tidewell needs you')
      await q.send('tabs', { rev: 9, active: 't1', tabs: [home, ...two, tab('t3', 'One', { marks: marks({ needs: 4 }) })] })
      await q.page.waitForFunction(() => document.getElementById('live')!.textContent === 'One needs you')
    } finally { await q.close() }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The app, its streams and its notices (A4.6 #16-#29)

interface Line { op: 'create' | 'post' | 'badge'; n: number; title?: string; body?: string }
interface Pill { rev: number; kind: string; short: string; lead?: string }
interface TabRow { id: string; kind: string; name: string; open: boolean; reg: { state: string; instance: string } | null }

const slotBase = runSlotBase()
/** a 0.29 shell as far as main can tell: hello and busy at once, and a notice's click reported back to the server */
const SHELL = `var A = window.marverApp; if (A) { try { A.hello({ version: '0.29.0-fake', board: 'main', page: 'needs-' + Math.random().toString(36).slice(2, 12) }); A.busy({ busy: false, unsaved: false, why: [] }); if (A.onOpen) A.onOpen(function (p) { say('open-' + p.id); return 'handled' }) } catch (e) {} }`
const TIMINGS = JSON.stringify({ noticeEveryMs: 0, liveBackoffMs: [100, 200], liveBackoffMaxMs: 300, badgeRetryMs: 400 })
let k = 0
const ask = (title: string): LiveItem => { k += 1; return { id: `ask:${k.toString(16).padStart(20, '0')}`, kind: 'ask', board: 'main', title, at: Date.now() + k, thread: `t${k}`, msg: `m${k}` } }

function app() {
  const o = { env: undefined as unknown as TestEnv, run: undefined as unknown as AppRun, fakes: [] as FakeCanvas[], children: [] as ChildProcess[] }
  const launch = async (config?: Record<string, unknown>, env?: TestEnv) => {
    o.env = env ?? testEnv(slotBase)
    if (config) writeFileSync(join(o.env.home, 'config.json'), JSON.stringify(config))
    o.run = await launchPW(o.env, { extraEnv: { MARVER_APP_TIMINGS: TIMINGS } })
  }
  const call = <T = unknown>(n: string, a?: unknown) => o.run.call<T>(n, a)
  const journal = async () => (await call<{ journal: Line[] }>('notices')).journal
  const posts = async () => (await journal()).filter((l) => l.op === 'post')
  const badges = async () => (await journal()).filter((l) => l.op === 'badge').map((l) => l.n)
  const tabs = async () => (await call<{ tabs: TabRow[] }>('state')).tabs
  const pill = async () => (await call<{ pill: Pill | null }>('state')).pill
  const strip = (id: string) => call<{ mark: string | null; label: string | null; cls: string; sess: boolean } | null>('exec', { target: 'strip', js: `(() => { const e = document.querySelector('[data-id="${id}"]'); return e ? { mark: e.querySelector('.mk')?.textContent ?? null, label: e.getAttribute('aria-label'), cls: e.className, sess: !!e.querySelector('.sess') } : null })()` })
  const canvas = async (opts: Partial<FakeOptions>) => {
    const f = await startFakeCanvas({ home: o.env.home, slotBase, features: ['bridge', 'live', 'open'], script: SHELL, live: true, ...opts })
    o.fakes.push(f)
    await f.ready
    const t = await until(`${f.instance}'s tab`, async () => (await tabs()).find((x) => x.reg?.instance === f.instance && x.reg.state === 'ready'))
    await until(`${f.instance}'s stream`, async () => (await call<{ instance: string; held: boolean }[]>('live')).find((s) => s.instance === f.instance && s.held))
    return { f, id: t.id }
  }
  /** a canvas as a child process, for kill -9 and SIGTERM: its stdin takes setLive */
  const child = async (opts: Partial<FakeOptions>) => {
    const c = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'harness', 'fake-canvas.ts'),
      JSON.stringify({ home: o.env.home, slotBase, features: ['bridge', 'live', 'open'], live: true, ...opts })], { stdio: ['pipe', 'pipe', 'pipe'] })
    o.children.push(c)
    const line = await new Promise<string>((ok, fail) => { createInterface({ input: c.stdout! }).once('line', ok); c.once('exit', (x) => fail(new Error(`exited ${x}`))) })
    const ready = (JSON.parse(line) as { ready: { instance: string } }).ready
    const t = await until('the child\'s tab', async () => (await tabs()).find((x) => x.reg?.instance === ready.instance && x.reg.state === 'ready'))
    return { c, id: t.id, instance: ready.instance, setLive: (s: unknown) => c.stdin!.write(`${JSON.stringify({ setLive: s })}\n`) }
  }
  const away = () => call('hide')
  const front = async () => { await call('show', { focus: true }); await until('the window focused', async () => (await call<{ focused: boolean }>('focusApp')) || null) }
  const close = async () => {
    for (const c of o.children.splice(0)) if (c.exitCode === null) { c.kill('SIGKILL'); await new Promise((r) => c.once('exit', r)) }
    await o.run?.close()
    for (const f of o.fakes.splice(0)) await f.close().catch(() => {})
  }
  return { o, launch, call, journal, posts, badges, tabs, pill, strip, canvas, child, away, front, close }
}

describe('marks and notices with notices on (A4.6 #17-#25)', () => {
  const a = app()
  beforeAll(async () => { await a.launch({ notifications: true }) }, 60_000)
  afterAll(async () => { await a.close(); a.o.env?.cleanup() })
  afterEach(async () => { await a.call('activate', { id: 'home' }) })

  it('the window away: the strip\'s count and name and one post; a reconnect posts nothing old; an item born in the gap posts', async () => {
    const { f, id } = await a.canvas({ slot: 1, name: 'Pilot' })
    await a.away()
    expect(await a.posts()).toEqual([])   // the workspace's first snapshot: nothing waited
    const q = ask('Which logo?')
    f.setLive({ items: [q] })
    const [p1] = await until('one post', async () => { const p = await a.posts(); return p.length === 1 ? p : null })
    expect(p1).toMatchObject({ title: 'Pilot', body: 'Asks you: Which logo?' })
    await until('the strip\'s count', async () => { const s = await a.strip(id); return s?.mark === '1' && s.label === 'Pilot, 1 needs you' ? s : null })
    f.dropLive()
    const r = ask('Which blue?')
    f.setLive({ items: [r, q] })
    await until('the gap\'s item posted', async () => (await a.posts()).length === 2 || null)
    expect((await a.posts())[1]!.body).toBe('Asks you: Which blue?')
    f.dropLive()
    await sleep(800)
    expect(await a.posts()).toHaveLength(2)
    await until('the count of two', async () => (await a.strip(id))?.mark === '2' || null)
  })

  it('in front on that tab: the mark only; another tab active with the window focused: a post', async () => {
    const { f, id } = await a.canvas({ slot: 2, name: 'Tidewell' })
    await a.call('activate', { id })
    await a.front()
    const n = (await a.posts()).length
    f.setLive({ items: [ask('Seen in front')] })
    await until('the mark', async () => (await a.strip(id))?.mark === '1' || null)
    await sleep(300)
    expect(await a.posts()).toHaveLength(n)
    await a.call('activate', { id: 'home' })
    f.setLive({ items: [ask('On another tab')] })
    await until('a post', async () => (await a.posts()).length === n + 1 || null)
    expect((await a.posts()).at(-1)).toMatchObject({ title: 'Tidewell', body: 'Asks you: On another tab' })
  })

  it('working and session: the sweep and the teal dot', async () => {
    const { f, id } = await a.canvas({ slot: 3, name: 'Worker' })
    f.setLive({ working: true })
    await until('the sweep', async () => /\bworking\b/.test((await a.strip(id))?.cls ?? '') || null)
    f.setLive({ working: true, session: true })
    await until('the session dot', async () => (await a.strip(id))?.sess || null)
    expect((await a.strip(id))!.label).toBe('Worker, agent working, Jam session on')
  })

  it('kill -9: one Stopped post and its count until the tab is shown in front; a SIGTERM makes none', async () => {
    const crash = await a.child({ slot: 4, name: 'Crashy' })
    const quit = await a.child({ slot: 5, name: 'Quitter' })
    await a.away()
    const n = (await a.posts()).length
    quit.c.kill('SIGTERM')
    crash.c.kill('SIGKILL')
    await until('one Stopped post', async () => { const p = await a.posts(); return p.length === n + 1 ? p : null }, 12_000)
    expect((await a.posts()).at(-1)).toMatchObject({ title: 'Crashy', body: 'Stopped' })
    await until('its count', async () => (await a.strip(crash.id))?.mark === '1' || null)
    await sleep(6000)   // past the registry's reconcile: the SIGTERM made nothing
    expect(await a.posts()).toHaveLength(n + 1)
    await a.call('activate', { id: crash.id })
    await a.front()
    await until('acknowledged', async () => (await a.strip(crash.id))?.mark === null || null)
    expect((await a.call<{ stops: string[] }>('notify')).stops).toEqual([])
  }, 30_000)

  it('a click on a never-shown tab shows it, and its document takes the item after its hello', async () => {
    const { f, id } = await a.canvas({ slot: 6, name: 'Clicky' })
    await a.away()
    const q = ask('Open me')
    f.setLive({ items: [q] })
    const p = await until('the post', async () => (await a.posts()).find((x) => x.body === 'Asks you: Open me'))
    expect(await a.call('notices:fire', { n: p.n, event: 'click' })).toBe(true)
    await until('its tab active', async () => (await a.call<{ active: string }>('state')).active === id || null)
    await until('the shell opened it', async () => f.requests.some((r) => r.path === `/__mv/test/open-${q.id}`) || null)
    const opened = (await a.call<{ topic: string; data: Record<string, unknown> }[]>('log')).filter((l) => l.topic === 'bridge' && l.data.ch === 'opened')
    expect(opened.map((l) => [l.data.event, l.data.id, l.data.result])).toEqual([['accepted', q.id, 'handled']])
  })

  it('a notice macOS refused raises the pill for 4 s and Settings says so', async () => {
    const { f } = await a.canvas({ slot: 7, name: 'Refused' })
    await a.away()
    f.setLive({ items: [ask('Nobody sees this')] })
    const p = await until('the post', async () => (await a.posts()).find((x) => x.title === 'Refused'))
    await a.call('notices:fire', { n: p.n, event: 'failed' })
    await a.call('show', { focus: false })
    expect(await until('the pill', async () => { const x = await a.pill(); return x?.kind === 'confirmation' ? x : null })).toMatchObject({ lead: 'Refused', short: 'Needs you' })
    expect(await a.call('files.view')).toMatchObject({ notices: { outcome: 'failed' } })
    expect(await a.call('files.notices')).toMatchObject({ lastOutcome: 'failed' })
  })
})

describe('before Turn On, the offer, Turn On and the badge (A4.6 #21, #22, #26)', () => {
  const a = app()
  afterEach(async () => { await a.close(); a.o.env?.cleanup() })

  it('nothing of notices before Turn On; the offer once at focus; Turn On writes notifications true, one create, two canvases summed', async () => {
    await a.launch()
    await a.away()
    await a.canvas({ slot: 8, name: 'One', live: { items: [ask('First')] } })
    await a.canvas({ slot: 9, name: 'Two', live: { items: [ask('Second'), ask('Third')] } })
    await sleep(500)
    expect(await a.journal()).toEqual([])
    expect(await a.pill()).toBeNull()   // the marks came in the background: no offer yet
    await a.front()
    const offer = await until('the offer', async () => { const x = await a.pill(); return x?.kind === 'offer' ? x : null })
    expect(offer).toMatchObject({ lead: 'Get a notice when a canvas needs you', short: 'Turn On Notices' })
    expect(await a.call('files.notices')).toMatchObject({ offeredAt: expect.any(Number) })
    expect(await a.call('pill:action', { rev: offer.rev, act: 'button' })).toBe(true)
    await until('notices on', async () => (await a.call<{ config: Record<string, unknown> }>('files.values')).config.notifications === true || null)
    expect(JSON.parse(readFileSync(join(a.o.env.home, 'config.json'), 'utf8'))).toMatchObject({ notifications: true })
    await until('the badge again after badgeRetryMs', async () => (await a.badges()).length >= 2 || null)
    const j = await a.journal()
    expect(j.filter((l) => l.op === 'create')).toHaveLength(1)
    expect(j[0]!.op).toBe('create')
    expect(await a.badges()).toEqual(expect.arrayContaining([3]))
    expect((await a.badges()).every((n) => n === 3)).toBe(true)
    expect(await a.pill()).toBeNull()
  })

  it('Not now: dismissedAt kept, and the offer never returns - after a relaunch too', async () => {
    await a.launch()
    const env = a.o.env
    await a.canvas({ slot: 10, name: 'Asker', live: { items: [ask('Q')] } })
    await a.front()
    const offer = await until('the offer', async () => { const x = await a.pill(); return x?.kind === 'offer' ? x : null })
    expect(await a.call('pill:action', { rev: offer.rev, act: 'dismiss' })).toBe(true)
    expect(await a.call('files.notices')).toMatchObject({ dismissedAt: expect.any(Number) })
    await a.o.run.close()
    a.o.run = await launchPW(env, { extraEnv: { MARVER_APP_TIMINGS: TIMINGS } })
    await until('the stream again', async () => (await a.call<{ held: boolean }[]>('live')).find((s) => s.held))
    await a.front()
    await sleep(800)
    expect((await a.pill())?.kind).not.toBe('offer')
    expect(await a.journal()).toEqual([])
  })
})
