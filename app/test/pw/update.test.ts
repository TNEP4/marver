/**
 * Restart to Update in the dev flavour with the fake updater (spec 28 A5.1 #34; `MARVER_APP_FAKE_UPDATER=1`,
 * testing/updater.ts's LiveFakeUpdater: Squirrel's events a macrotask after each check, `quitAndInstall()` in S4's
 * order on Electron 45). Never a feed, never the native updater: S2's and S4's are those.
 *
 * - the ready pill and the menu's label;
 * - Restart to Update with an unsent capture on one fake canvas: that tab forward with its hold, then `waiting` naming
 *   it; the capture sent, `ready` again; a shared tab's sheet cancelled, `ready` again;
 * - pressed, with a Jam session left on (holding nothing): the fake's `quitAndInstall` in Electron 45's order -
 *   `before-quit-for-update`, every window closed, `before-quit-for-update` again, then one quit - the app exiting 0
 *   and the intent on disk;
 * - the next launch, as the fake's version: "Updated to"; one that finds `from`: Download opening the DMG's link (the
 *   `outside` spy);
 * - a manual check's three answers; a blocked build's menu item and its alert.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRun } from '../harness/app.ts'
import type { TestEnv } from '../harness/env.ts'
import { startRemoteCanvas, type RemoteCanvas } from '../harness/remote-canvas.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

const DMG = 'https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg'
const FAKE = { MARVER_APP_FAKE_UPDATER: '1' }
const QUICK = JSON.stringify({ updateFirstMs: 300 })

interface Pill { rev: number; kind: string; lead?: string; text: string; short: string; tab?: string; button?: { label: string }; dismissible?: boolean; tooltip?: string }
interface Phase { kind: string; version?: string; tab?: string; commit?: number }
interface Updater { state: { phase: Phase; failure: { from: string; to: string } | null } | null; menu: { label: string; enabled: boolean } | null; calls: string[] | null; file: { intent: unknown; move: unknown }; alerts: { message: string; detail: string; buttons: string[] }[] }
interface MenuDump { id?: string; label: string; enabled: boolean; submenu?: MenuDump[] }

const updater = (w: WindowRun) => w.run.call<Updater>('updater')
const pill = async (w: WindowRun) => (await w.state()).pill as unknown as Pill | null
const phase = async (w: WindowRun) => (await updater(w)).state!.phase
const menuItem = async (w: WindowRun) => (await w.run.call<MenuDump[]>('menu:items'))[0]!.submenu!.find((i) => i.id === 'update')
const press = async (w: WindowRun, act: 'button' | 'dismiss' = 'button') => w.run.call<boolean>('pill:action', { rev: (await pill(w))!.rev, act })
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
/** The process's exit code, heard before anything asks it to quit. */
function exited(run: AppRun): Promise<number | null> {
  const p = run.pw ? run.pw.process() : run.child!
  if (p.exitCode !== null) return Promise.resolve(p.exitCode)
  return new Promise((r) => p.once('exit', (code) => r(code)))
}
/** `want` appears in `lines` in this order (other lines may come between) */
function inOrder(lines: string[], want: string[]): boolean {
  let i = 0
  for (const l of lines) if (l === want[i]) i += 1
  return i === want.length
}
const records = (env: TestEnv) => {
  const f = join(env.home, 'perf', 'app-dev.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; phase?: string; version?: string; from?: string; to?: string }).filter((r) => r.kind === 'update') : []
}

describe('Restart to Update, refused and released, then pressed (#15, #16, #21)', () => {
  let r: RemoteCanvas
  let w: WindowRun
  /** the first launch: its fake canvases stay up until the end (closed with `keep`, the home reused) */
  let first: WindowRun | undefined
  let env: TestEnv
  let version = ''
  let alpha = ''
  let log = ''
  beforeAll(async () => {
    r = await startRemoteCanvas()
    w = await launchWindow('pw', {
      extraEnv: { ...r.env, ...FAKE, MARVER_APP_FAKE_OFFER: '0.99.2', MARVER_APP_TIMINGS: QUICK },
      prepare: async (e) => { log = join(e.dir, 'updater.log'); return { extraEnv: { MARVER_APP_FAKE_UPDATER_LOG: log } } },
    })
    env = w.env
    first = w
    version = (await w.run.call<{ version: string }>('ping')).version
  })
  afterAll(async () => { await w?.close().catch(() => {}); await first?.close().catch(() => {}); await r?.close() })

  it('the ready pill and the menu\'s label', async () => {
    await until('ready', async () => (await phase(w)).kind === 'ready')
    await w.run.call('activate', { id: 'home' })
    expect(await pill(w)).toMatchObject({ kind: 'update', lead: '0.99.2 is ready', short: 'Restart to Update', button: { label: 'Restart to Update' }, tooltip: 'What changed' })
    expect(await menuItem(w)).toMatchObject({ label: 'Restart to Install Update', enabled: true })
    expect((await updater(w)).calls).toEqual(expect.arrayContaining(['setFeedURL', 'checkForUpdates']))
  })

  it('an unsent capture on one canvas: that tab forward with its hold, then waiting naming it; the capture sent, ready again', async () => {
    const a = await w.canvas({ slot: 1, name: 'Tidewell' })
    alpha = a.id
    await w.run.call('activate', { id: a.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === a.id)?.doc?.lifted, 10_000, 'Tidewell lifted')
    await w.report(a.id, { unsaved: true, why: ['capture-unsent'] })
    // a Jam session left on: busy, never unsaved - it holds nothing
    const b = await w.canvas({ slot: 2, name: 'Gen lab' })
    await w.run.call('activate', { id: b.id })
    await w.until((x) => !!x.tabs.find((t) => t.id === b.id)?.doc?.lifted, 10_000, 'Gen lab lifted')
    await w.report(b.id, { unsaved: false, why: ['jam-session'] })
    await w.run.call('activate', { id: 'home' })
    expect(await press(w)).toBe(true)
    await until('waiting', async () => (await phase(w)).kind === 'waiting')
    const s = await w.state()
    expect(s.active).toBe(a.id)
    expect(s.quitting).toBe(false)
    expect(s.tabs.find((t) => t.id === a.id)!.held).toMatchObject({ action: 'update' })
    expect(await pill(w)).toMatchObject({ kind: 'unsaved', lead: 'Unsaved work here', text: 'the update waits', tab: a.id })
    expect(await phase(w)).toMatchObject({ kind: 'waiting', version: '0.99.2', tab: a.id })
    // elsewhere, the update's own pill names the tab; the menu still restarts
    await w.run.call('activate', { id: 'home' })
    expect(await pill(w)).toMatchObject({ kind: 'update', lead: '0.99.2 waits for Tidewell', short: 'Update waits', button: { label: 'Try Again' }, tab: a.id })
    expect(await menuItem(w)).toMatchObject({ label: 'Restart to Install Update', enabled: true })
    // a tab switch changes nothing; the capture sent does
    await w.run.call('activate', { id: b.id })
    expect((await phase(w)).kind).toBe('waiting')
    await w.report(a.id, { unsaved: false })
    await until('ready again', async () => (await phase(w)).kind === 'ready')
    await w.run.call('activate', { id: 'home' })
    expect(await pill(w)).toMatchObject({ kind: 'update', lead: '0.99.2 is ready' })
    expect((await updater(w)).calls!.filter((c) => c === 'quitAndInstall')).toEqual([])
  })

  it('a shared tab\'s sheet cancelled: ready again, never waiting', async () => {
    expect(await w.run.call('remote:open', { url: r.url('upd', '/') })).toEqual({ ok: true })
    const t = await w.until((x) => !!x.tabs.find((q) => q.kind === 'remote')?.doc?.lifted, 15_000, 'the shared canvas lifted')
    const shared = t.tabs.find((q) => q.kind === 'remote')!
    await w.run.call('sheet', { mode: 'cancel' })
    await w.run.call('activate', { id: 'home' })
    const n = (await w.log()).length
    expect(await press(w)).toBe(true)
    await until('the update refused', async () => (await w.log('quit', n)).some((l) => l.data.answer === 'refused'))
    const sheet = (await w.run.call<{ shown: { action: string; tabs: string[] }[] }>('sheets')).shown.at(-1)!
    expect(sheet).toMatchObject({ action: 'update', tabs: [shared.id] })
    expect(await phase(w)).toMatchObject({ kind: 'ready', version: '0.99.2' })
    expect((await w.state()).quitting).toBe(false)
  })

  it('pressed: the fake\'s quitAndInstall in Electron 45\'s order, one quit, exit 0, the intent and tabs.json on disk', async () => {
    await w.run.call('sheet', { mode: 'confirm' })
    await w.report(alpha, { unsaved: false })
    await w.run.call('activate', { id: 'home' })
    const exit = exited(w.run)
    expect(await press(w)).toBe(true)
    expect(await Promise.race([exit, sleep(20_000).then(() => 'held' as const)])).toBe(0)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(inOrder(lines, ['before-quit-for-update', 'window-closed', 'before-quit-for-update', 'before-quit', 'will-quit', 'exit 0'])).toBe(true)
    // the coordinator's window-all-closed listener held Electron's default quit off: no quit before the second event
    expect(lines.indexOf('before-quit')).toBeGreaterThan(lines.lastIndexOf('before-quit-for-update'))
    expect(lines.filter((l) => l === 'before-quit')).toHaveLength(1)
    expect(lines.filter((l) => l === 'before-quit-for-update')).toHaveLength(2)
    const file = JSON.parse(readFileSync(join(env.home, 'state-dev', 'update.json'), 'utf8'))
    expect(file.intent).toMatchObject({ from: version, to: '0.99.2', via: 'restart' })
    const tabs = JSON.parse(readFileSync(join(env.home, 'state-dev', 'tabs.json'), 'utf8')) as { canvases: { path: string }[] }
    expect(tabs.canvases.length).toBeGreaterThanOrEqual(2)
    // recorded once, whatever recorder says: the restart and the attempt that downloaded it
    const recs = records(env)
    expect(recs.filter((x) => x.phase === 'restart')).toEqual([expect.objectContaining({ phase: 'restart', version: '0.99.2' })])
    expect(recs.map((x) => x.phase)).toEqual(expect.arrayContaining(['check', 'downloading', 'downloaded']))
    await w.close({ keep: true })
  })

  it('the next launch, running the version it went to: "Updated to 0.99.2", once; the intent gone', async () => {
    w = await launchWindow('pw', { env, extraEnv: { ...r.env, ...FAKE, MARVER_APP_FAKE_VERSION: '0.99.2' } })
    await w.run.call('activate', { id: 'home' })
    expect(await until('the confirmation', async () => { const p = await pill(w); return p?.kind === 'confirmation' ? p : null })).toMatchObject({ text: 'Updated to 0.99.2', short: 'Updated' })
    expect((await updater(w)).file.intent).toBeNull()
    await w.close({ keep: true })
    // the recorder's queue, written at will-quit
    expect(records(env).some((x) => x.phase === 'installed' && x.to === '0.99.2')).toBe(true)
  })

  it('a launch that finds `from`: the failed pill; Download opens the DMG\'s link; Dismiss clears it', async () => {
    writeFileSync(join(env.home, 'state-dev', 'update.json'), JSON.stringify({ v: 1, intent: { from: version, to: '0.99.2', via: 'restart', at: Date.now() - 60_000 }, move: null, staging: null }))
    w = await launchWindow('pw', { env, extraEnv: { ...r.env, ...FAKE } })
    await w.run.call('activate', { id: 'home' })
    expect(await until('the failed pill', async () => { const p = await pill(w); return p?.kind === 'update' ? p : null })).toMatchObject({
      lead: "0.99.2 couldn't be installed", short: 'Update failed', button: { label: 'Download' }, dismissible: true,
    })
    expect(await press(w)).toBe(true)
    expect((await w.run.call<{ opened: string[] }>('outside')).opened).toEqual([DMG])
    expect(await press(w, 'dismiss')).toBe(true)
    expect((await updater(w)).state!.failure).toBeNull()
    expect(await pill(w)).toBeNull()
    await w.close({ keep: true })
    expect(records(env).some((x) => x.phase === 'install-failed' && x.from === version)).toBe(true)
  })
})

describe('a manual check\'s answers (#14)', () => {
  let w: WindowRun
  // no automatic check during the case: only the menu's
  beforeAll(async () => { w = await launchWindow('pw', { extraEnv: { ...FAKE, MARVER_APP_TIMINGS: JSON.stringify({ updateFirstMs: 600_000 }) } }) })
  afterAll(async () => { await w?.close() })

  it('up to date, offline, try again later - from the menu\'s Check for Updates…, each in the pill', async () => {
    const version = (await w.run.call<{ version: string }>('ping')).version
    await until('idle', async () => (await phase(w)).kind === 'idle')
    await w.run.call('activate', { id: 'home' })
    expect(await menuItem(w)).toMatchObject({ label: 'Check for Updates…', enabled: true })
    const check = async (next: unknown, online: boolean | null) => {
      await w.run.call('updater:fake', { next })
      await w.run.call('updater:online', { online })
      const before = (await pill(w))?.rev ?? 0
      // the menu as built now (menu:items builds it): Check for Updates…, enabled, its token the one clicked
      expect(await menuItem(w)).toMatchObject({ label: 'Check for Updates…', enabled: true })
      expect(await w.run.call('menu:click', { id: 'update' })).toBe(true)
      return until('the answer', async () => { const p = await pill(w); return p?.kind === 'confirmation' && p.rev > before ? p : null })
    }
    expect(await check({ kind: 'current' }, null)).toMatchObject({ text: `Marver ${version} is up to date`, short: 'Up to date' })
    expect(await check({ kind: 'error', message: 'The Internet connection appears to be offline.' }, false)).toMatchObject({ text: "Couldn't check for updates · You're offline", short: "You're offline" })
    expect(await check({ kind: 'error', message: 'a 404 page' }, true)).toMatchObject({ text: "Couldn't check for updates · Try again later", short: "Couldn't check" })
    // while one runs, the item is disabled and a click starts nothing
    await w.run.call('updater:fake', { next: null })
    await menuItem(w)
    await w.run.call('menu:click', { id: 'update' })
    expect(await menuItem(w)).toMatchObject({ label: 'Checking for Updates…', enabled: false })
    expect((await updater(w)).calls!.filter((c) => c === 'checkForUpdates')).toHaveLength(4)
  })
})

describe('a blocked build (#13, #22)', () => {
  it('outside the Applications folder: Updates Need the Applications Folder…, its alert, Show in Finder', async () => {
    const w = await launchWindow('pw', { extraEnv: { ...FAKE, MARVER_APP_FAKE_GATES: 'location' } })
    try {
      expect(await menuItem(w)).toMatchObject({ label: 'Updates Need the Applications Folder…', enabled: true })
      await w.run.call('updater:answer', { button: 'Show in Finder' })
      expect(await w.run.call('menu:click', { id: 'update' })).toBe(true)
      const a = await until('the alert', async () => (await updater(w)).alerts[0])
      expect(a).toMatchObject({ message: 'Marver updates itself only from the Applications folder', buttons: ['OK', 'Show in Finder'] })
      expect((await w.run.call<{ shown?: string[] }>('outside')).shown?.[0]).toMatch(/\.app$/)
      expect((await updater(w)).calls).toEqual([])                  // blocked: no adapter call at all
    } finally { await w.close() }
  })

  it('a declined move: the alert says so, and Move at Next Launch clears it', async () => {
    const w = await launchWindow('pw', {
      extraEnv: { ...FAKE, MARVER_APP_FAKE_GATES: 'location' },
      prepare: async (e) => {
        mkdirSync(join(e.home, 'state-dev'), { recursive: true, mode: 0o700 })
        writeFileSync(join(e.home, 'state-dev', 'update.json'), JSON.stringify({ v: 1, intent: null, move: { declined: true, at: 1 }, staging: null }))
        return {}
      },
    })
    try {
      // the item exists once the gates have blocked: a click before it would find nothing to press
      expect(await menuItem(w)).toMatchObject({ label: 'Updates Need the Applications Folder…', enabled: true })
      await w.run.call('updater:answer', { button: 'Move at Next Launch' })
      expect(await w.run.call('menu:click', { id: 'update' })).toBe(true)
      const a = await until('the alert', async () => (await updater(w)).alerts[0])
      expect(a.buttons).toEqual(['OK', 'Show in Finder', 'Move at Next Launch'])
      await until('the decline cleared', async () => (await updater(w)).file.move === null)
    } finally { await w.close() }
  })

  it('no feed: no item at all', async () => {
    const w = await launchWindow('pw', { extraEnv: { ...FAKE, MARVER_APP_FAKE_GATES: 'feed' } })
    try {
      expect(await menuItem(w)).toBeUndefined()
      expect((await updater(w)).state!.phase).toEqual({ kind: 'blocked', why: 'feed' })
    } finally { await w.close() }
  })

  it('the dev flavour without the fake has no feed: blocked, no item, and Electron\'s updater never touched', async () => {
    const w = await launchWindow('pw')
    try {
      expect(await menuItem(w)).toBeUndefined()
      expect(await updater(w)).toMatchObject({ state: { phase: { kind: 'blocked', why: 'feed' } }, calls: null })
    } finally { await w.close() }
  })
})

describe('Settings\' Updates group (spec 33 C), on the fake updater', () => {
  /** the Settings page's own webContents, as Playwright sees it */
  const settingsPage = async (w: WindowRun) => {
    await w.run.call('settings:open')
    return until('the Settings page', async () => w.run.pw!.windows().find((pg) => pg.url().startsWith('marver-app://settings/')) ?? null)
  }
  const stateText = (pg: import('playwright-core').Page) => pg.evaluate(() => document.getElementById('update-state')?.textContent ?? null)

  it('Check for updates: checking, downloading, then ready with the feed\'s notes; Restart to update goes through the coordinator to quitAndInstall', async () => {
    let log = ''
    const w = await launchWindow('pw', {
      extraEnv: { ...FAKE, MARVER_APP_TIMINGS: JSON.stringify({ updateFirstMs: 600_000 }) },
      prepare: async (e) => { log = join(e.dir, 'updater.log'); return { extraEnv: { MARVER_APP_FAKE_UPDATER_LOG: log } } },
    })
    try {
      await until('idle', async () => (await phase(w)).kind === 'idle')
      const pg = await settingsPage(w)
      await pg.waitForSelector('#update-btn:not([disabled])')
      expect(await pg.$eval('#checked', (e) => e.textContent)).toBe('Not checked yet')
      // the check never answers by itself: each step is the case's
      await w.run.call('updater:fake', { next: null })
      await pg.click('#update-btn')
      await pg.waitForFunction(() => document.getElementById('update-state')?.textContent === 'Checking for updates…')
      expect(await pg.$eval('#update-btn', (b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual(['Checking…', true])
      await w.run.call('updater:emit', { event: 'update-available' })
      await pg.waitForSelector('.st-bar')
      expect(await stateText(pg)).toBe('Downloading the update…')
      await w.run.call('updater:emit', { event: 'update-downloaded', version: '1.2.9', notes: 'What changed\nAnd more' })
      await pg.waitForFunction(() => document.getElementById('update-state')?.textContent === 'Marver 1.2.9 is ready to install')
      expect(await pg.$$eval('.st-notes li', (els) => els.map((e) => e.textContent))).toEqual(['What changed', 'And more'])
      expect(await pg.$eval('.st-notes .st-label', (e) => e.textContent)).toBe('What\'s new in 1.2.9')
      const exit = exited(w.run)
      await pg.click('#update-btn')
      expect(await Promise.race([exit, sleep(20_000).then(() => 'held' as const)])).toBe(0)
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(inOrder(lines, ['before-quit-for-update', 'before-quit', 'exit 0'])).toBe(true)
      expect(records(w.env).filter((x) => x.phase === 'restart')).toEqual([expect.objectContaining({ version: '1.2.9' })])
    } finally {
      await w.close().catch(() => {})
    }
  })

  it('autoUpdate: false in config.json - no automatic check; Check for updates in Settings still checks', async () => {
    const w = await launchWindow('pw', {
      extraEnv: { ...FAKE, MARVER_APP_TIMINGS: JSON.stringify({ updateFirstMs: 300, updateEveryMs: 300 }) },
      prepare: async (e) => { mkdirSync(e.home, { recursive: true }); writeFileSync(join(e.home, 'config.json'), JSON.stringify({ autoUpdate: false })); return {} },
    })
    try {
      await until('idle', async () => (await phase(w)).kind === 'idle')
      await sleep(1500)
      expect((await updater(w)).calls!.filter((c) => c === 'checkForUpdates')).toEqual([])
      expect(records(w.env).filter((x) => x.phase === 'check')).toEqual([])
      const pg = await settingsPage(w)
      await pg.waitForSelector('[data-ctl="config.autoUpdate"][aria-checked="false"]')
      await w.run.call('updater:fake', { next: { kind: 'current' } })
      await pg.click('#update-btn')
      await pg.waitForFunction(() => document.getElementById('update-state')?.textContent === 'Marver is up to date')
      expect(await pg.$eval('#checked', (e) => e.textContent)).toBe('Last checked just now')
      expect((await updater(w)).calls!.filter((c) => c === 'checkForUpdates')).toHaveLength(1)
    } finally {
      await w.close().catch(() => {})
    }
  })
})
