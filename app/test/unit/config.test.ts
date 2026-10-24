/**
 * ~/.marver: the files (src/main/config.ts; spec 28 A2.7, A2.12, A2.14 #23, #24, v1.12 r1 #7), in node with
 * Electron mocked - the folder, the repairs, the files judged whole, the launch fallback, settings:set, the watch,
 * the pill and tabs.json. The same cases run against the real app in test/pw/files.test.ts.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOwned, renderReadme } from '../../src/main/readme.ts'

const theme = vi.hoisted(() => ({ themeSource: 'system' as string }))
const shellCalls = vi.hoisted(() => ({ opened: [] as string[], copied: [] as string[] }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getName: () => 'Marver Dev', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
  nativeTheme: theme,
  shell: { openPath: async (p: string) => { shellCalls.opened.push(p); return '' } },
  clipboard: { writeText: (t: string) => { shellCalls.copied.push(t) } },
}))

type Cfg = typeof import('../../src/main/config.ts')
type Fsx = typeof import('../../src/main/fsx.ts')
let cfg: Cfg
let fsx: Fsx
let base: string
let home: string

beforeEach(async () => {
  vi.resetModules()
  cfg = await import('../../src/main/config.ts')
  fsx = await import('../../src/main/fsx.ts')
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-cfg-')))
  home = join(base, 'home')
  process.env.MARVER_HOME = home
  theme.themeSource = 'system'
  shellCalls.opened.length = 0
})
afterEach(() => {
  cfg.stopFiles()
  try { chmodSync(home, 0o700) } catch { /* gone */ }
  rmSync(base, { recursive: true, force: true })
  delete process.env.MARVER_HOME
})

const mode = (p: string) => statSync(p).mode & 0o777
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const read = (p: string) => readFileSync(p, 'utf8')
const start = (o: { dev?: boolean } = {}) => { const h = cfg.ensureHome({ version: '0.1.0', dev: o.dev ?? true }); cfg.loadFiles(); return h }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T, ok: (v: T) => boolean, ms = 1500): Promise<T> {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (ok(v) || Date.now() > end) return v; await wait(20) }
}

describe('ensureHome()', () => {
  it('first launch on an empty home: README, schemas, state (700), perf/crashpad (700); never config.json or theme.json', () => {
    const h = start()
    expect(h).toMatchObject({ dir: home, writable: true, state: join(home, 'state-dev'), crashpad: join(home, 'perf', 'crashpad') })
    expect(mode(home)).toBe(0o700)
    for (const d of ['state-dev', 'perf', 'perf/crashpad']) expect(mode(join(home, d)), d).toBe(0o700)
    for (const [p, t] of renderOwned('0.1.0')) expect(read(join(home, p)), p).toBe(t)
    expect(existsSync(join(home, 'config.json'))).toBe(false)
    expect(existsSync(join(home, 'theme.json'))).toBe(false)
    expect(readdirSync(home).sort()).toEqual(['README.md', 'perf', 'schemas', 'state-dev'])
  })

  it('the release build keeps state/; Marver Dev state-dev/ (A2.14 #23)', () => {
    expect(cfg.ensureHome({ version: '0.1.0', dev: false }).state).toBe(join(home, 'state'))
    expect(existsSync(join(home, 'state-dev'))).toBe(false)
  })

  it('never chmods a home that exists; is quick the second time', () => {
    mkdirSync(home, { mode: 0o755 })
    chmodSync(home, 0o755)
    start()
    expect(mode(home)).toBe(0o755)
    const h = cfg.ensureHome({ version: '0.1.0', dev: true })
    expect(h.ms).toBeLessThan(50)
  })

  it('an unwritable home: runs on defaults, says why, creates nothing', () => {
    mkdirSync(home, { mode: 0o500 })
    chmodSync(home, 0o500)
    const h = start()
    expect(h).toMatchObject({ writable: false, reason: 'EACCES' })
    expect(readdirSync(home)).toEqual([])
    expect(cfg.values().config.restoreTabs).toBe(true)
    expect(cfg.filesPill()).toMatchObject({ kind: 'files', lead: expect.stringMatching(/can't be written$/), text: 'nothing is kept', short: 'Files not saved' })
  })

  it('a home that is a file: not writable, ENOTDIR', () => {
    writeFileSync(home, 'x')
    expect(cfg.ensureHome({ version: '0.1.0', dev: true })).toMatchObject({ writable: false, reason: 'ENOTDIR' })
  })

  it('repairs a README cut short (release and dev), and a release build replaces one of another version', () => {
    start({ dev: false })
    const md = read(join(home, 'README.md'))
    writeFileSync(join(home, 'README.md'), md.slice(0, md.indexOf('\n') + 30))
    cfg.ensureHome({ version: '0.1.0', dev: true })
    expect(read(join(home, 'README.md'))).toBe(md)
    writeFileSync(join(home, 'README.md'), renderReadme('0.0.9'))
    cfg.ensureHome({ version: '0.1.0', dev: true })
    expect(read(join(home, 'README.md'))).toBe(renderReadme('0.0.9'))   // whole, of another version: a dev build keeps it
    cfg.ensureHome({ version: '0.1.0', dev: false })
    expect(read(join(home, 'README.md'))).toBe(md)
  })

  it('a dev build never downgrades a whole README of another version', () => {
    start()
    writeFileSync(join(home, 'README.md'), renderReadme('0.2.0'))
    cfg.ensureHome({ version: '0.1.0', dev: true })
    expect(read(join(home, 'README.md'))).toBe(renderReadme('0.2.0'))
    cfg.ensureHome({ version: '0.1.0', dev: false })
    expect(read(join(home, 'README.md'))).toBe(renderReadme('0.1.0'))
  })

  it('sweeps our temp files older than a minute in the home and state, and nothing else', () => {
    start()
    const old = join(home, 'state-dev', 'tabs.json.0123456789ab.tmp')
    const fresh = join(home, 'state-dev', 'tabs.json.ba9876543210.tmp')
    const mine = join(home, 'config.json.0123456789ab.tmp')
    for (const f of [old, fresh, mine]) writeFileSync(f, 'x')
    const t = new Date(Date.now() - 120_000)
    utimesSync(old, t, t)
    utimesSync(mine, t, t)
    utimesSync(fresh, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000))
    cfg.ensureHome({ version: '0.1.0', dev: true })
    expect([existsSync(old), existsSync(fresh), existsSync(mine)]).toEqual([false, true, false])
  })
})

describe('judge()', () => {
  const j = (text: string | undefined) => cfg.judge('config', text === undefined ? undefined : Buffer.from(text))

  it('absent and {} apply as the defaults', () => {
    expect(j(undefined)).toEqual({ ok: true, present: false, values: {}, sha256: '' })
    expect(j('{}')).toEqual({ ok: true, present: true, values: {}, sha256: sha('{}') })
  })

  it('a leading BOM is fine; the sha256 is of the bytes as they are', () => {
    const t = '﻿{ "restoreTabs": false }\n'
    expect(j(t)).toEqual({ ok: true, present: true, values: { restoreTabs: false }, sha256: sha(Buffer.from(t)) })
  })

  it('does not apply: a trailing comma, [], null, an unknown key, $schema 3, a bad value', () => {
    expect(j('{ "restoreTabs": true, }')).toMatchObject({ ok: false, problems: [{ message: expect.stringMatching(/^not valid JSON: /) }] })
    expect(j('[]')).toMatchObject({ ok: false, problems: [{ message: 'must be one JSON object' }] })
    expect(j('null')).toMatchObject({ ok: false, problems: [{ message: 'must be one JSON object' }] })
    expect(j('{ "restoreTab": true }')).toMatchObject({ ok: false, problems: [{ key: 'restoreTab' }] })
    expect(j('{ "$schema": 3 }')).toMatchObject({ ok: false, problems: [{ key: '$schema' }] })
    expect(j('{ "restoreTabs": "yes" }')).toMatchObject({ ok: false, problems: [{ key: 'restoreTabs', message: 'restoreTabs must be true or false' }], sha256: sha('{ "restoreTabs": "yes" }') })
  })

  it('a file over 64 KB does not apply', () => {
    expect(cfg.judge('config', { tooBig: true })).toMatchObject({ ok: false, problems: [{ message: 'the file is over 64 KB' }] })
  })
})

describe('the files in force', () => {
  it('a bad config.json is not applied as a whole; status.json says why; fixing it applies', async () => {
    start()
    const bad = '{ "restoreTabs": "yes", "unloadUnderPressure": false }'
    writeFileSync(join(home, 'config.json'), bad)
    await cfg.reread()
    expect(cfg.values().config).toMatchObject({ restoreTabs: true, unloadUnderPressure: true })
    expect(cfg.filesPill()).toMatchObject({ lead: 'config.json', text: 'did not apply · using the last good one', short: 'Settings not applied' })
    await (await import('../../src/main/fsx.ts')).settled()
    await wait(20)
    const st = JSON.parse(read(join(home, 'state-dev', 'status.json')))
    expect(st.files['config.json']).toMatchObject({ present: true, ok: false, sha256: sha(bad), problems: [{ key: 'restoreTabs' }] })
    writeFileSync(join(home, 'config.json'), '{ "restoreTabs": true, "unloadUnderPressure": false }')
    await cfg.reread()
    expect(cfg.values().config).toMatchObject({ restoreTabs: true, unloadUnderPressure: false })
    expect(cfg.filesPill()).toBeNull()
  })

  it('at launch, a file that does not apply leaves status.json\'s last applied values in force (A2.14 #24)', () => {
    cfg.ensureHome({ version: '0.1.0', dev: true })
    const applied = { sha256: 'a'.repeat(64), values: { unloadUnderPressure: false } }
    writeFileSync(join(home, 'state-dev', 'status.json'), JSON.stringify({ v: 1, app: '0.1.0', at: 1, writable: true, files: {
      'config.json': { present: true, ok: true, sha256: applied.sha256, applied }, 'theme.json': { present: false, ok: true, sha256: '', applied: { sha256: '', values: {} } },
    } }))
    writeFileSync(join(home, 'config.json'), '{ "unloadUnderPressure": nope }')
    cfg.loadFiles()
    expect(cfg.values().config.unloadUnderPressure).toBe(false)
    expect(cfg.filesStatus().files['config.json']).toMatchObject({ ok: false, applied })
  })

  it('a status.json whose applied values would not pass today is not trusted: the defaults', () => {
    cfg.ensureHome({ version: '0.1.0', dev: true })
    writeFileSync(join(home, 'state-dev', 'status.json'), JSON.stringify({ v: 1, files: { 'config.json': { applied: { sha256: 'x', values: { restoreTabs: 'yes' } } } } }))
    writeFileSync(join(home, 'config.json'), 'nope')
    cfg.loadFiles()
    expect(cfg.values().config.restoreTabs).toBe(true)
  })

  it('theme.json\'s mode drives nativeTheme.themeSource; a bad one changes nothing', async () => {
    start()
    writeFileSync(join(home, 'theme.json'), '{ "mode": "midnight" }')
    await cfg.reread()
    expect(theme.themeSource).toBe('system')
    writeFileSync(join(home, 'theme.json'), '{ "mode": "dark" }')
    await cfg.reread()
    expect(theme.themeSource).toBe('dark')
    rmSync(join(home, 'theme.json'))
    await cfg.reread()
    expect(theme.themeSource).toBe('system')
  })

  it('watches the folder: an agent\'s rename-over edit applies within 500 ms', async () => {
    start()
    cfg.watchFiles()
    await wait(100)
    const tmp = join(home, 'config.json.agent.tmp')
    writeFileSync(tmp, '{ "restoreTabs": false }\n')
    renameSync(tmp, join(home, 'config.json'))
    const t0 = Date.now()
    const v = await until(() => cfg.values().config.restoreTabs, (x) => x === false, 1500)
    expect(v).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    writeFileSync(join(home, 'config.json'), '{ "restoreTabs": true }\n')   // in place
    expect(await until(() => cfg.values().config.restoreTabs, (x) => x === true, 1500)).toBe(true)
  })

  it('tells its listeners once per change, never for an echo of the same bytes', async () => {
    start()
    const changes: string[] = []
    cfg.onChange((f) => changes.push(f))
    writeFileSync(join(home, 'config.json'), '{ "restoreTabs": false }')
    await cfg.reread()
    await cfg.reread()
    expect(changes).toEqual(['config'])
  })
})

describe('settings:set', () => {
  it('creates config.json with its $schema line, mode 600, no temp; applied at once; status.json has its sha256', async () => {
    start()
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: true })
    const text = read(join(home, 'config.json'))
    expect(text).toBe('{\n  "$schema": "./schemas/config.schema.json",\n  "restoreTabs": false\n}\n')
    expect(mode(join(home, 'config.json'))).toBe(0o600)
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(cfg.values().config.restoreTabs).toBe(false)
    expect(cfg.filesStatus().files['config.json']).toMatchObject({ ok: true, sha256: sha(text) })
  })

  it('keeps the other keys, their order and an agent\'s own $schema', async () => {
    start()
    writeFileSync(join(home, 'theme.json'), '{\n  "mode": "light",\n  "$schema": "x.json"\n}\n')
    await cfg.reread()
    expect(await cfg.settingsSet({ file: 'theme', key: 'mode', value: 'dark' })).toEqual({ ok: true })
    expect(JSON.parse(read(join(home, 'theme.json')))).toEqual({ $schema: 'x.json', mode: 'dark' })
    expect(theme.themeSource).toBe('dark')
  })

  it('refuses a key of a later milestone, an unknown key, a bad value and a bad shape', async () => {
    start()
    // app 0.2 is A3: unloading, the recorder and its days are shown (and set); A4's keys not yet
    expect(await cfg.settingsSet({ file: 'config', key: 'notifications', value: true })).toEqual({ ok: false, why: 'unknown-key' })
    expect(await cfg.settingsSet({ file: 'config', key: 'dockBadge', value: false })).toEqual({ ok: false, why: 'unknown-key' })
    expect(await cfg.settingsSet({ file: 'config', key: 'nope', value: true })).toEqual({ ok: false, why: 'unknown-key' })
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: 'no' })).toEqual({ ok: false, why: 'bad-value' })
    expect(await cfg.settingsSet({ file: 'theme', key: 'mode', value: 'midnight' })).toEqual({ ok: false, why: 'bad-value' })
    expect(await cfg.settingsSet({ file: 'other', key: 'mode', value: 'dark' })).toEqual({ ok: false, why: 'bad-value' })
    expect(await cfg.settingsSet({ file: 'config', key: '__proto__', value: true })).toEqual({ ok: false, why: 'bad-value' })
    expect(existsSync(join(home, 'config.json'))).toBe(false)
    expect(await cfg.settingsSet({ file: 'config', key: 'unloadUnderPressure', value: false })).toEqual({ ok: true })
    expect(cfg.values().config.unloadUnderPressure).toBe(false)
  })

  it('onto a file that does not apply: the last good values plus the change, the broken bytes kept as .bad', async () => {
    start()
    writeFileSync(join(home, 'theme.json'), '{ "mode": "light" }')
    await cfg.reread()
    writeFileSync(join(home, 'theme.json'), '{ "mode": "midnight" }')
    await cfg.reread()
    expect(await cfg.settingsSet({ file: 'theme', key: 'mode', value: 'dark' })).toEqual({ ok: true })
    expect(JSON.parse(read(join(home, 'theme.json')))).toEqual({ $schema: './schemas/theme.schema.json', mode: 'dark' })
    expect(read(join(home, 'theme.json.bad'))).toBe('{ "mode": "midnight" }')
    expect(cfg.filesPill()).toBeNull()
  })

  it('onto a file too big to read: the file itself renamed to .bad, unread, then the change written', async () => {
    start()
    const big = `{ "restoreTabs": true, "pad": "${'x'.repeat(70 * 1024)}" }`
    writeFileSync(join(home, 'config.json'), big)
    await cfg.reread()
    expect(cfg.filesStatus().files['config.json'].ok).toBe(false)
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: true })
    expect(read(join(home, 'config.json.bad'))).toBe(big)
    expect(JSON.parse(read(join(home, 'config.json')))).toEqual({ $schema: './schemas/config.schema.json', restoreTabs: false })
  })

  it('onto a file that cannot be read (mode 000): renamed to .bad with its bytes and mode, then the change written', async () => {
    start()
    writeFileSync(join(home, 'theme.json'), '{ "mode": "light" }')
    chmodSync(join(home, 'theme.json'), 0o000)
    await cfg.reread()
    expect(cfg.filesStatus().files['theme.json'].ok).toBe(false)
    expect(await cfg.settingsSet({ file: 'theme', key: 'mode', value: 'dark' })).toEqual({ ok: true })
    expect(mode(join(home, 'theme.json.bad'))).toBe(0o000)
    chmodSync(join(home, 'theme.json.bad'), 0o600)
    expect(read(join(home, 'theme.json.bad'))).toBe('{ "mode": "light" }')
    expect(JSON.parse(read(join(home, 'theme.json'))).mode).toBe('dark')
  })

  it('when the broken bytes cannot be kept aside, nothing is written over them: write-failed, the file untouched', async () => {
    start()
    writeFileSync(join(home, 'theme.json'), '{ "mode": "midnight" }')
    await cfg.reread()
    fsx.faults.inject({ match: 'theme\\.json\\.bad$', code: 'ENOSPC', at: 'write' })
    expect(await cfg.settingsSet({ file: 'theme', key: 'mode', value: 'dark' })).toEqual({ ok: false, why: 'write-failed', code: 'ENOSPC' })
    expect(read(join(home, 'theme.json'))).toBe('{ "mode": "midnight" }')
    expect(existsSync(join(home, 'theme.json.bad'))).toBe(false)
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(cfg.filesPill()).toMatchObject({ lead: 'theme.json' })   // the problem still outranks the failed write
    expect(cfg.filesStatus().write).toMatchObject({ code: 'ENOSPC', file: expect.stringMatching(/theme\.json$/) })
  })

  it('a file renamed aside whose change then fails to write goes back where it was', async () => {
    start()
    const big = `{ "pad": "${'x'.repeat(70 * 1024)}" }`
    writeFileSync(join(home, 'config.json'), big)
    await cfg.reread()
    fsx.faults.inject({ match: 'config\\.json$', code: 'ENOSPC', at: 'write' })
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: false, why: 'write-failed', code: 'ENOSPC' })
    expect(read(join(home, 'config.json'))).toBe(big)
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('a full disk: write-failed with its code, the file unchanged, the pill; the next write clears it', async () => {
    start()
    writeFileSync(join(home, 'config.json'), '{ "restoreTabs": true }')
    await cfg.reread()
    fsx.faults.inject({ match: 'config\\.json$', code: 'ENOSPC' })
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: false, why: 'write-failed', code: 'ENOSPC' })
    expect(read(join(home, 'config.json'))).toBe('{ "restoreTabs": true }')
    expect(cfg.values().config.restoreTabs).toBe(true)
    expect(cfg.filesPill()).toMatchObject({ lead: "Couldn't save config.json", text: 'the disk is full', short: 'Files not saved' })
    expect(cfg.filesStatus().write).toMatchObject({ code: 'ENOSPC', file: expect.stringMatching(/config\.json$/) })
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: true })
    expect(cfg.filesPill()).toBeNull()
    expect(cfg.filesStatus().write).toBeUndefined()
  })

  it('an unwritable home answers unwritable', async () => {
    mkdirSync(home, { mode: 0o500 })
    chmodSync(home, 0o500)
    start()
    expect(await cfg.settingsSet({ file: 'config', key: 'restoreTabs', value: false })).toEqual({ ok: false, why: 'unwritable' })
  })

  it('settings:get: the folder with ~, each file, the effective values, the text of one that does not apply, the shown keys', async () => {
    start()
    writeFileSync(join(home, 'theme.json'), '{ "mode": "midnight" }')
    await cfg.reread()
    const v = cfg.settingsView()
    expect(v.shown).toEqual(['config.restoreTabs', 'config.unloadUnderPressure', 'config.recorder', 'config.keepPerfDays', 'theme.mode'])
    expect(v.statusFile).toBe(join(home, 'state-dev', 'status.json'))   // under the temp home: no ~ to shorten
    expect(v.config).toMatchObject({ ok: true, present: false, values: { restoreTabs: true } })
    expect(v.config).not.toHaveProperty('text')
    expect(v.theme).toMatchObject({ ok: false, text: '{ "mode": "midnight" }', values: { mode: 'system' }, problems: [{ key: 'mode' }] })
    expect(v.status.files['theme.json'].ok).toBe(false)
  })

  it('Show the Files opens the folder itself (never selects a dot-folder)', () => {
    start()
    cfg.settingsReveal()
    expect(shellCalls.opened).toEqual([home])
  })
})

describe('the pill and status pushes', () => {
  it('tells the pill feed the pill at once, then only when it changes; Settings on every judgement', async () => {
    start()
    const pills: unknown[] = []
    const statuses: unknown[] = []
    cfg.onPill((p) => pills.push(p))
    cfg.onStatus((s) => statuses.push(s))
    expect(pills).toEqual([null])
    writeFileSync(join(home, 'config.json'), '[]')
    await cfg.reread()
    writeFileSync(join(home, 'config.json'), 'null')
    await cfg.reread()
    writeFileSync(join(home, 'config.json'), '{}')
    await cfg.reread()
    expect(pills).toHaveLength(3)
    expect(pills[1]).toMatchObject({ kind: 'files', lead: 'config.json' })
    expect(pills[2]).toBeNull()
    expect(statuses).toHaveLength(3)
  })

  it('a pill found at launch, before any feed listened, reaches the feed when it subscribes', () => {
    cfg.ensureHome({ version: '0.1.0', dev: true })
    writeFileSync(join(home, 'config.json'), '{ "restoreTabs": "yes" }')
    cfg.loadFiles()
    const pills: unknown[] = []
    cfg.onPill((p) => pills.push(p))
    expect(pills).toEqual([expect.objectContaining({ kind: 'files', lead: 'config.json', short: 'Settings not applied' })])
  })

  it('a problem outranks a failed write, which outranks an unwritable home', async () => {
    start()
    cfg.noteWrite(join(home, 'state-dev', 'recent.json'), Object.assign(new Error('x'), { code: 'ENOSPC' }))
    expect(cfg.filesPill()).toMatchObject({ lead: "Couldn't save recent.json" })
    writeFileSync(join(home, 'config.json'), '{ "x": 1 }')
    await cfg.reread()
    expect(cfg.filesPill()).toMatchObject({ lead: 'config.json', tooltip: 'config.json: x is not a config.json key' })
    cfg.noteWrite(join(home, 'state-dev', 'recent.json'), null)
    rmSync(join(home, 'config.json'))
    await cfg.reread()
    expect(cfg.filesPill()).toBeNull()
  })
})

describe('tabs.json (v1.12 r1 #5)', () => {
  const good = {
    v: 1, active: { kind: 'canvas', ws: '0123456789abcdef', origin: 'http://[::1]:4806' },
    canvases: [{ ws: '0123456789abcdef', origin: 'http://[::1]:4806', path: '/#/b/flow?f=x', shownAt: 5 }],
    settings: false, closed: [{ ws: 'fedcba9876543210', instance: '6f2c1b7e-1d7f-4f5e-9d61-1a2b3c4d5e6f' }],
  }

  it('reads back a good file; one with v: 2 or a bad shape goes aside as tabs.json.bad', () => {
    start()
    const f = join(home, 'state-dev', 'tabs.json')
    writeFileSync(f, JSON.stringify(good))
    expect(cfg.readTabsFile()).toEqual(good)
    writeFileSync(f, JSON.stringify({ ...good, v: 2 }))
    expect(cfg.readTabsFile()).toBeUndefined()
    expect(JSON.parse(read(`${f}.bad`)).v).toBe(2)
    for (const bad of [
      { ...good, active: { kind: 'canvas', ws: 'x', origin: 'http://[::1]:4806' } },
      { ...good, active: { kind: 'canvas', ws: '0123456789abcdef', origin: 'http://example.com:80' } },
      { ...good, canvases: [{ ...good.canvases[0], path: 'http://evil/' }] },
      { ...good, canvases: [{ ...good.canvases[0], path: '/other/page' }] },
      { ...good, settings: 'yes' },
      { ...good, closed: [{ ws: '0123456789abcdef' }] },
    ]) expect(cfg.checkTabsFile(bad)).toBe(false)
    expect(cfg.checkTabsFile({ ...good, active: { kind: 'home' } })).toBe(true)
    expect(cfg.checkTabsFile({ ...good, active: { kind: 'settings' } })).toBe(true)
  })

  it('shellPath keeps the shell\'s own document, its query and hash, and nothing else', () => {
    expect(cfg.shellPath('/#/b/flow?f=x')).toBe('/#/b/flow?f=x')
    expect(cfg.shellPath('/index.html?n=1#/b/x')).toBe('/index.html?n=1#/b/x')
    for (const p of ['/other', 'x', 3, `/#${'a'.repeat(2048)}`, '//evil.com/']) expect(cfg.shellPath(p)).toBe('/')
  })

  it('the writer writes it whole, mode 600', async () => {
    start()
    const w = cfg.tabsWriter()
    w.set(good as never)
    await w.flush()
    const f = join(home, 'state-dev', 'tabs.json')
    expect(JSON.parse(read(f))).toEqual(good)
    expect(mode(f)).toBe(0o600)
  })
})
