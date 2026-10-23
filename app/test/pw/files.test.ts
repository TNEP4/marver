/**
 * ~/.marver against the real app (spec 28 A2.7, A2.10 "First launch and the files", A2.12, A2.14 #23, #24): the dev
 * build under Playwright on a temporary MARVER_HOME, MARVER_APP_USER_DATA and slot base, driven through main's test
 * hooks (config.ts, home.ts, effects.ts) - the window stream's views and the trust stream's bridge are not needed for
 * the files. The dev build is Marver Dev: its state is state-dev/ and it never downgrades a whole README.
 * Nothing here touches the clipboard or Finder: effects are recorded in test mode.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchPW, type AppRun } from '../harness/app.ts'
import { NIC_PROFILES, runSlotBase, snapshot, testEnv, type TestEnv } from '../harness/env.ts'

const nicBefore = NIC_PROFILES.map(snapshot)
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const mode = (p: string) => statSync(p).mode & 0o777
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let env: TestEnv | undefined
let run: AppRun | undefined
afterEach(async () => {
  await run?.close()
  run = undefined
  if (env) { try { chmodSync(env.home, 0o700) } catch { /* gone */ } env.cleanup() }
  env = undefined
})
const launch = async (extra: Record<string, string> = {}) => { run = await launchPW(env!, { extraEnv: extra }); return run }
const relaunch = async () => { await run!.close(); run = undefined; return launch() }
const call = <T = unknown>(n: string, a?: unknown) => run!.call<T>(n, a)
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 1500): Promise<T> {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await wait(25) }
}
const state = (...p: string[]) => join(env!.home, 'state-dev', ...p)
interface Values { config: Record<string, unknown>; theme: { mode: string } }
interface Status { files: Record<string, { ok: boolean; sha256: string; problems?: { key?: string }[] }>; write?: { code: string } }

describe('first launch (A2.12, A2.14 #24)', () => {
  it('an empty home gets README, schemas, state (700) and perf/crashpad (700) - never config.json or theme.json - and nothing of notices or capture is touched', async () => {
    env = testEnv(runSlotBase())
    await launch({ MARVER_APP_SPY: '1' })
    const owned = await call<[string, string][]>('files.render')
    for (const [p, text] of owned) expect(readFileSync(join(env.home, p), 'utf8'), p).toBe(text)
    for (const d of ['state-dev', 'perf', 'perf/crashpad']) expect(mode(join(env.home, d)), d).toBe(0o700)
    expect(existsSync(join(env.home, 'config.json'))).toBe(false)
    expect(existsSync(join(env.home, 'theme.json'))).toBe(false)
    expect(existsSync(join(env.home, 'state'))).toBe(false)
    expect(await call('home.info')).toEqual({ welcome: true, writable: true })
    await wait(1500)
    // RE-RUN once the window and trust streams merge: on this branch the window, the tabs and the bridge are the
    // skeleton's, so this proves the files side alone touches none of these, not the integrated app
    const spies = await call<{ counts: Record<string, number>; installed: string[] }>('spies')
    expect(spies.installed.length).toBeGreaterThan(0)
    expect(spies.counts).toEqual({})
  })

  it('state/launched only once Home has shown; the welcome holds for the run; the next launch is "On this Mac" and quick', async () => {
    env = testEnv(runSlotBase())
    await launch()
    expect(existsSync(state('launched'))).toBe(false)
    // the writer, driven by its hook: the trigger (Home's first did-finish-load while active, ports.ts) is the window
    // stream's, and gets its own end-to-end case once it merges
    await call('home.shown')
    await until(async () => existsSync(state('launched')), (x) => x)
    expect(JSON.parse(readFileSync(state('launched'), 'utf8'))).toMatchObject({ v: 1, app: '0.1.0' })
    expect((await call<{ welcome: boolean }>('home.info')).welcome).toBe(true)
    await relaunch()
    expect((await call<{ welcome: boolean }>('home.info')).welcome).toBe(false)
    expect((await call<{ ms: number }>('files.home')).ms).toBeLessThan(10)
  })

  it('running/ and prefer/ made by marver dev do not end the welcome', async () => {
    env = testEnv(runSlotBase())
    for (const d of ['running', 'prefer']) mkdirSync(join(env.home, d), { mode: 0o700 })
    await launch()
    expect((await call<{ welcome: boolean }>('home.info')).welcome).toBe(true)
  })

  it('a home that cannot be written: the app starts on defaults with the pill, creating nothing; writable again, the next launch makes the files', async () => {
    env = testEnv(runSlotBase())
    chmodSync(env.home, 0o500)
    await launch()
    expect(await call('files.home')).toMatchObject({ writable: false, reason: 'EACCES' })
    expect(await call('files.pill')).toMatchObject({ kind: 'files', text: 'nothing is kept', short: 'Files not saved', lead: expect.stringMatching(/can't be written$/) })
    expect(await call('home.info')).toEqual({ welcome: true, writable: false })
    expect((await call<Values>('files.values')).config.restoreTabs).toBe(true)
    expect(readdirSync(env.home)).toEqual([])
    expect(await call('files.set', { file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: false, why: 'unwritable' })
    chmodSync(env.home, 0o700)
    await relaunch()
    expect(readdirSync(env.home).sort()).toEqual(['README.md', 'perf', 'schemas', 'state-dev'])
    expect(await call('files.pill')).toBeNull()
  })

  it('repairs at launch: a README cut short, our old temp files; a cut-short recent.json goes aside and Recently here is empty', async () => {
    env = testEnv(runSlotBase())
    await launch()
    const md = readFileSync(join(env.home, 'README.md'), 'utf8')
    await run!.close(); run = undefined
    writeFileSync(join(env.home, 'README.md'), md.slice(0, md.indexOf('\n') + 50))
    const old = state('tabs.json.0123456789ab.tmp')
    const fresh = state('tabs.json.ba9876543210.tmp')
    for (const f of [old, fresh]) writeFileSync(f, 'x')
    utimesSync(old, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    utimesSync(fresh, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000))
    writeFileSync(state('recent.json'), '{"v":1,"canvases":[{"workspace":"00000')
    await launch()
    expect(readFileSync(join(env.home, 'README.md'), 'utf8')).toBe(md)
    expect([existsSync(old), existsSync(fresh)]).toEqual([false, true])
    expect(readFileSync(state('recent.json.bad'), 'utf8')).toBe('{"v":1,"canvases":[{"workspace":"00000')
    expect(await call('home.views')).toEqual([])
  })
})

describe('config.json and theme.json (A2.7, A2.14 #23, #24, v1.12 r1 #7)', () => {
  it('a bad config.json is not applied as a whole, status.json says why, the pill; fixed by an agent\'s rename, it applies within 500 ms', async () => {
    env = testEnv(runSlotBase())
    await launch()
    const bad = '{ "restoreTabs": "yes", "unloadUnderPressure": false }'
    writeFileSync(join(env.home, 'config.json'), bad)
    const st = await until(() => call<Status>('files.status'), (s) => s.files['config.json'].sha256 === sha(bad))
    expect(st.files['config.json']).toMatchObject({ ok: false, sha256: sha(bad), problems: [{ key: 'restoreTabs' }] })
    await call('files.statusWritten')
    expect(JSON.parse(readFileSync(state('status.json'), 'utf8')).files['config.json']).toMatchObject({ ok: false, sha256: sha(bad) })
    expect((await call<Values>('files.values')).config.unloadUnderPressure).toBe(true)
    expect(await call('files.pill')).toMatchObject({ lead: 'config.json', text: 'did not apply · using the last good one', short: 'Settings not applied' })
    const good = '{ "$schema": "./schemas/config.schema.json", "restoreTabs": true, "unloadUnderPressure": false }\n'
    writeFileSync(join(env.home, 'config.json.agent.tmp'), good)
    const t0 = Date.now()
    renameSync(join(env.home, 'config.json.agent.tmp'), join(env.home, 'config.json'))
    const v = await until(() => call<Values>('files.values'), (x) => x.config.unloadUnderPressure === false)
    expect(v.config.unloadUnderPressure).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(await call('files.pill')).toBeNull()
    expect((await call<Status>('files.status')).files['config.json']).toMatchObject({ ok: true, sha256: sha(good) })
  })

  it('never applies [], a trailing comma, an unknown key, $schema 3, or a 70 KB file', async () => {
    env = testEnv(runSlotBase())
    writeFileSync(join(env.home, 'config.json'), '{ "restoreTabs": false }')
    await launch()
    for (const text of ['[]', '{ "restoreTabs": true, }', '{ "restoreTab": true }', '{ "$schema": 3, "restoreTabs": true }', `{ "restoreTabs": true, "pad": "${'x'.repeat(70 * 1024)}" }`]) {
      writeFileSync(join(env.home, 'config.json'), text)
      await until(() => call<Status>('files.status'), (s) => !s.files['config.json'].ok)
      expect((await call<Values>('files.values')).config.restoreTabs, text.slice(0, 30)).toBe(false)
      writeFileSync(join(env.home, 'config.json'), '{ "restoreTabs": false }')
      await until(() => call<Status>('files.status'), (s) => s.files['config.json'].ok)
    }
  })

  it('theme.json: "midnight" leaves the theme as it was; "dark" sets nativeTheme within 500 ms', async () => {
    env = testEnv(runSlotBase())
    await launch()
    writeFileSync(join(env.home, 'theme.json'), '{ "mode": "midnight" }')
    await until(() => call<Status>('files.status'), (s) => !s.files['theme.json'].ok)
    expect(await call('files.theme')).toMatchObject({ themeSource: 'system' })
    const view = await call<{ theme: { text?: string; problems?: unknown[] } }>('files.view')
    expect(view.theme).toMatchObject({ text: '{ "mode": "midnight" }', problems: [{ key: 'mode' }] })
    const t0 = Date.now()
    writeFileSync(join(env.home, 'theme.json'), '{ "mode": "dark" }')
    const th = await until(() => call<{ themeSource: string; dark: boolean }>('files.theme'), (t) => t.themeSource === 'dark')
    expect(th).toEqual({ themeSource: 'dark', dark: true })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('at launch, a broken config.json leaves status.json\'s last applied values in force', async () => {
    env = testEnv(runSlotBase())
    await launch()
    await call('files.set', { file: 'config', key: 'restoreTabs', value: false })
    await call('files.statusWritten')
    await run!.close(); run = undefined
    writeFileSync(join(env.home, 'config.json'), '{ "restoreTabs": nope }')
    await launch()
    expect((await call<Values>('files.values')).config.restoreTabs).toBe(false)
    expect((await call<Status>('files.status')).files['config.json'].ok).toBe(false)
  })
})

describe('Settings through main (A2.7)', () => {
  it('a change creates config.json with its $schema line, mode 600, applied at once; an agent\'s edit shows; later milestones\' keys refused', async () => {
    env = testEnv(runSlotBase())
    await launch()
    expect(await call('files.set', { file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: true })
    const p = join(env.home, 'config.json')
    expect(readFileSync(p, 'utf8')).toBe('{\n  "$schema": "./schemas/config.schema.json",\n  "restoreTabs": false\n}\n')
    expect(mode(p)).toBe(0o600)
    expect(readdirSync(env.home).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await call<{ config: { values: Record<string, unknown> } }>('files.view')).config.values.restoreTabs).toBe(false)
    writeFileSync(`${p}.x.tmp`, '{ "restoreTabs": true }')
    renameSync(`${p}.x.tmp`, p)
    await until(() => call<Values>('files.values'), (v) => v.config.restoreTabs === true)
    for (const s of [{ file: 'config', key: 'recorder', value: false }, { file: 'config', key: 'unloadUnderPressure', value: false }, { file: 'config', key: 'nope', value: true }]) {
      expect(await call('files.set', s)).toEqual({ ok: false, why: 'unknown-key' })
    }
    expect(await call('files.set', { file: 'config', key: 'restoreTabs', value: 'no' })).toEqual({ ok: false, why: 'bad-value' })
  })

  it('onto a broken theme.json: the last good values plus the change, the broken bytes kept as theme.json.bad', async () => {
    env = testEnv(runSlotBase())
    writeFileSync(join(env.home, 'theme.json'), '{ "mode": "midnight" }')
    await launch()
    expect(await call('files.set', { file: 'theme', key: 'mode', value: 'dark' })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(join(env.home, 'theme.json'), 'utf8'))).toEqual({ $schema: './schemas/theme.schema.json', mode: 'dark' })
    expect(readFileSync(join(env.home, 'theme.json.bad'), 'utf8')).toBe('{ "mode": "midnight" }')
    expect(await call('files.theme')).toMatchObject({ themeSource: 'dark' })
  })

  it('a full disk (an injected ENOSPC): write-failed, the file unchanged, no temp, the pill and status.json; the next write clears them', async () => {
    env = testEnv(runSlotBase())
    writeFileSync(join(env.home, 'config.json'), '{ "restoreTabs": true }')
    await launch()
    // at 'write': the temp file exists when the disk fills, so "no temp file" proves the cleanup
    await call('files.inject', { match: 'config\\.json$', code: 'ENOSPC', at: 'write' })
    expect(await call('files.set', { file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: false, why: 'write-failed', code: 'ENOSPC' })
    expect(readFileSync(join(env.home, 'config.json'), 'utf8')).toBe('{ "restoreTabs": true }')
    expect(readdirSync(env.home).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(await call('files.pill')).toMatchObject({ lead: 'Couldn\'t save config.json', text: 'the disk is full', short: 'Files not saved' })
    await call('files.statusWritten')
    expect(JSON.parse(readFileSync(state('status.json'), 'utf8')).write).toMatchObject({ code: 'ENOSPC' })
    expect(await call('files.set', { file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: true })
    expect(await call('files.pill')).toBeNull()
  })

  it('Show the Files opens the folder (recorded in test mode, never Finder)', async () => {
    env = testEnv(runSlotBase())
    await launch()
    await call('files.reveal')
    expect(await call('effects')).toEqual({ copies: [], opened: [env.home] })
  })
})

describe('Recently here and Home\'s commands (A2.12, A2.14 #5, #24)', () => {
  const WS = '0123456789abcdef'

  it('a canvas verified then gone is listed, the folder with ~; its start command copied whole; a running one is never listed twice', async () => {
    env = testEnv(runSlotBase())
    const root = join(env.dir, `it's a repo`)
    mkdirSync(root)
    await launch()
    await call('home.verified', { ws: WS, root, name: 'Fixture A', origin: `http://[::1]:${env.slotBase + 1}`, slot: 1, port: env.slotBase + 1 })
    await call('home.verified', { ws: 'fedcba9876543210', root, name: 'Fixture B', origin: 'http://127.0.0.1:5298', slot: null, port: 5298 })
    expect(await call('home.views', { running: [WS] })).toEqual([expect.objectContaining({ id: 'r_fedcba9876543210', name: 'Fixture B' })])
    await call('home.gone', { ws: WS })
    const views = await call<{ id: string; name: string; folder: string }[]>('home.views')
    expect(views.map((v) => v.name).sort()).toEqual(['Fixture A', 'Fixture B'])
    expect(await call('home.action', { action: 'copy-start', id: `r_${WS}` })).toEqual({ ok: true })
    expect(await call('home.action', { action: 'copy-start', id: 'r_fedcba9876543210' })).toEqual({ ok: true })
    for (const id of ['dev', 'init', 'update']) expect(await call('home.action', { action: 'copy', id })).toEqual({ ok: true })
    expect(await call('home.action', { action: 'show-files' })).toEqual({ ok: true })
    const q = root.replace(/'/g, `'\\''`)
    expect(await call('effects')).toEqual({
      copies: [`cd '${q}' && npx marver dev`, `cd '${q}' && npx marver dev --port 5298`, 'npx marver dev', 'npm i -D @marver-design/marver && npx marver init', 'npm i -D @marver-design/marver@latest'],
      opened: [env.home],
    })
    await until(async () => existsSync(state('recent.json')), (x) => x, 2500)
    expect(JSON.parse(readFileSync(state('recent.json'), 'utf8')).canvases.map((c: { name: string }) => c.name).sort()).toEqual(['Fixture A', 'Fixture B'])
  })

  it('after a restart: listed again; a folder deleted meanwhile is dropped', async () => {
    env = testEnv(runSlotBase())
    const a = join(env.dir, 'a')
    const b = join(env.dir, 'b')
    mkdirSync(a); mkdirSync(b)
    await launch()
    await call('home.verified', { ws: WS, root: a, name: 'A', origin: 'http://[::1]:4901', slot: 1, port: 4901 })
    await call('home.verified', { ws: 'fedcba9876543210', root: b, name: 'B', origin: 'http://[::1]:4902', slot: 2, port: 4902 })
    await call('home.flush')
    await run!.close(); run = undefined
    rmSync(a, { recursive: true })
    await launch()
    expect((await call<{ name: string }[]>('home.views')).map((v) => v.name)).toEqual(['B'])
  })

  it('a full disk while saving recent.json keeps the old bytes and says so; the next save writes and clears it', async () => {
    env = testEnv(runSlotBase())
    mkdirSync(join(env.home, 'state-dev'), { recursive: true, mode: 0o700 })
    const before = JSON.stringify({ v: 1, canvases: [] }) + '\n'
    writeFileSync(state('recent.json'), before)
    const root = join(env.dir, 'r')
    mkdirSync(root)
    await launch()
    await call('files.inject', { match: 'recent\\.json$', code: 'ENOSPC', at: 'write' })
    await call('home.verified', { ws: WS, root, name: 'R', origin: 'http://[::1]:4903', slot: 3, port: 4903 })
    const pill = await until(() => call<{ lead?: string } | null>('files.pill'), (p) => !!p, 3000)
    expect(pill).toMatchObject({ lead: 'Couldn\'t save recent.json', short: 'Files not saved' })
    expect(readFileSync(state('recent.json'), 'utf8')).toBe(before)
    expect(readdirSync(state()).filter((n) => n.endsWith('.tmp'))).toEqual([])
    await call('files.statusWritten')
    expect(JSON.parse(readFileSync(state('status.json'), 'utf8')).write).toMatchObject({ code: 'ENOSPC' })
    await call('home.verified', { ws: WS, root, name: 'R', origin: 'http://[::1]:4903', slot: 3, port: 4903 })
    await until(() => call('files.pill'), (p) => p === null, 3000)
    expect(JSON.parse(readFileSync(state('recent.json'), 'utf8')).canvases).toHaveLength(1)
  })
})

describe('tabs.json (v1.12 r1 #5)', () => {
  it('written whole by its writer and read back; one with v: 2 goes aside as tabs.json.bad', async () => {
    env = testEnv(runSlotBase())
    await launch()
    const file = { v: 1, active: { kind: 'home' }, canvases: [{ ws: '0123456789abcdef', origin: 'http://[::1]:4901', path: '/#/b/flow', shownAt: 1 }], settings: true, closed: [] }
    await call('files.tabsWrite', file)
    expect(mode(state('tabs.json'))).toBe(0o600)
    expect(await call('files.tabs')).toEqual(file)
    writeFileSync(state('tabs.json'), JSON.stringify({ ...file, v: 2 }))
    expect(await call('files.tabs')).toBeNull()
    expect(JSON.parse(readFileSync(state('tabs.json.bad'), 'utf8')).v).toBe(2)
  })
})

it('left Nic\'s profiles as they were', () => {
  expect(NIC_PROFILES.map(snapshot)).toEqual(nicBefore)
})
