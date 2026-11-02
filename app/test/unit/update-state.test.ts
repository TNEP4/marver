/**
 * `state/update.json` and #18's reconciliation (spec 28 A5.1 #18, #23 v1.33, #41), in node with Electron mocked: the
 * file parsed field by field, a bad one set aside as `.bad` and read as empty, written whole; the reconciliation's
 * four outcomes against the version running - `to` ("Updated to X", `installed`), `from` (the failure and its pill,
 * `install-failed`), another version and an intent over 30 days old (cleared and recorded, nothing shown) - and the
 * moved copy's one-time note; then the same through updater.ts at launch, before the first check.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.99.1', getName: () => 'Marver Dev', getPath: () => '/Applications/Marver.app/Contents/MacOS/Marver', commandLine: { hasSwitch: () => false }, isReady: () => true, on: () => {}, isInApplicationsFolder: () => true },
  autoUpdater: {}, BaseWindow: { getAllWindows: () => [] }, dialog: {}, net: { isOnline: () => true }, powerMonitor: { on: () => {} },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
}))

type Cfg = typeof import('../../src/main/config.ts')
type Upd = typeof import('../../src/main/updater.ts')
let cfg: Cfg
let upd: Upd
let base: string
let state: string

beforeEach(async () => {
  vi.resetModules()
  cfg = await import('../../src/main/config.ts')
  upd = await import('../../src/main/updater.ts')
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-update-')))
  process.env.MARVER_HOME = join(base, 'home')
  state = cfg.ensureHome({ version: '0.99.1', dev: true }).state
})
afterEach(() => {
  upd.resetUpdater()
  rmSync(base, { recursive: true, force: true })
  delete process.env.MARVER_HOME
})

const file = () => join(state, 'update.json')
const DAY = 86_400_000
const NOW = 1_800_000_000_000
const intent = (o: Partial<{ from: string; to: string; via: 'restart' | 'quit'; at: number }> = {}) => ({ from: '0.99.1', to: '0.99.2', via: 'restart' as const, at: NOW - 60_000, ...o })

describe('update.json (#41)', () => {
  it('absent: empty, nothing set aside; written whole and read back', () => {
    expect(cfg.readUpdateFile()).toEqual({ v: 1, intent: null, move: null, staging: null })
    const f = { v: 1 as const, intent: intent(), move: { declined: true as const, at: 5 }, staging: { path: '/Applications/.Marver-staging-x', dev: 1, ino: 2, placeholder: { dev: 1, ino: 3 }, at: 6 } }
    expect(cfg.writeUpdateFile(f)).toBe(true)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual(f)
    expect(cfg.readUpdateFile()).toEqual(f)
    expect(existsSync(`${file()}.bad`)).toBe(false)
    // the smoke's seed (#36) reads as written
    writeFileSync(file(), JSON.stringify({ v: 1, intent: null, move: { declined: true, at: 1 }, staging: null }))
    expect(cfg.readUpdateFile().move).toEqual({ declined: true, at: 1 })
    // the moved note
    cfg.writeUpdateFile({ v: 1, intent: null, move: { moved: true, at: 7, from: 'dmg' }, staging: null })
    expect(cfg.readUpdateFile().move).toEqual({ moved: true, at: 7, from: 'dmg' })
  })

  it('a bad one is set aside as update.json.bad and read as empty (A2.12)', () => {
    const bad = [
      'not json',
      JSON.stringify({ v: 2, intent: null, move: null, staging: null }),
      JSON.stringify({ v: 1, intent: { from: '1.0.0-rc.1', to: '1.0.1', via: 'restart', at: 1 }, move: null, staging: null }),
      JSON.stringify({ v: 1, intent: { from: '1.0.0', to: '1.0.1', via: 'later', at: 1 }, move: null, staging: null }),
      JSON.stringify({ v: 1, intent: null, move: { declined: true, moved: true, at: 1, from: 'dmg' }, staging: null }),
      JSON.stringify({ v: 1, intent: null, move: null, staging: { path: 'relative', dev: 1, ino: 2, placeholder: null, at: 3 } }),
      JSON.stringify({ v: 1, intent: null, move: null }),
    ]
    for (const b of bad) {
      writeFileSync(file(), b)
      expect(cfg.readUpdateFile(), b).toEqual({ v: 1, intent: null, move: null, staging: null })
      expect(readFileSync(`${file()}.bad`, 'utf8')).toBe(b)
    }
  })

  it('an unwritable home: the write says false', () => {
    const h = cfg.currentHome()
    ;(h as { writable: boolean }).writable = false
    expect(cfg.writeUpdateFile({ v: 1, intent: intent(), move: null, staging: null })).toBe(false)
    expect(existsSync(file())).toBe(false)
  })
})

describe('the reconciliation (#18), against the version running', () => {
  const f = (o: Partial<import('../../src/main/config.ts').UpdateFile> = {}) => ({ v: 1 as const, intent: null, move: null, staging: null, ...o })

  it('it equals `to`: "Updated to 0.99.2", installed, the intent cleared', () => {
    const r = upd.reconcile(f({ intent: intent() }), '0.99.2', NOW)
    expect(r).toMatchObject({ changed: true, installed: true, failure: null, show: { text: 'Updated to 0.99.2', short: 'Updated' } })
    expect(r.next.intent).toBeNull()
    expect(r.records).toEqual([{ phase: 'installed', from: '0.99.1', to: '0.99.2', version: '0.99.2' }])
  })

  it('it equals `from`: the failure, install-failed, the intent cleared, nothing shown but the pill', () => {
    const r = upd.reconcile(f({ intent: intent({ via: 'quit' }) }), '0.99.1', NOW)
    expect(r).toMatchObject({ changed: true, installed: false, show: null, failure: { from: '0.99.1', to: '0.99.2', at: NOW } })
    expect(r.next.intent).toBeNull()
    expect(r.records).toEqual([{ phase: 'install-failed', from: '0.99.1', to: '0.99.2', version: '0.99.1' }])
  })

  it('another version: cleared and recorded, nothing shown', () => {
    const r = upd.reconcile(f({ intent: intent() }), '0.99.3', NOW)
    expect(r).toMatchObject({ changed: true, installed: false, show: null, failure: null })
    expect(r.records).toEqual([{ phase: 'late', why: 'intent', from: '0.99.1', to: '0.99.2', version: '0.99.3' }])
  })

  it('an intent over 30 days old: cleared and recorded, nothing shown - even one that reads `to` or `from`', () => {
    for (const running of ['0.99.2', '0.99.1']) {
      const r = upd.reconcile(f({ intent: intent({ at: NOW - 30 * DAY - 1 }) }), running, NOW)
      expect(r).toMatchObject({ changed: true, installed: false, show: null, failure: null })
      expect(r.records).toEqual([{ phase: 'late', why: 'intent-old', from: '0.99.1', to: '0.99.2', version: running }])
    }
    expect(upd.reconcile(f({ intent: intent({ at: NOW - 30 * DAY }) }), '0.99.2', NOW).installed).toBe(true)
  })

  it('the moved copy\'s note, once: from a disk image, from a folder, from nowhere known; over 30 days, cleared unshown', () => {
    const moved = (from: string, at = NOW - 1000) => upd.reconcile(f({ move: { moved: true, at, from } }), '0.99.1', NOW)
    expect(moved('dmg').show).toEqual({ lead: 'Marver moved itself to Applications.', text: 'You can eject the disk image.', short: 'Moved to Applications' })
    expect(moved('Downloads').show).toEqual({ lead: 'Marver moved itself to Applications.', text: 'You can delete the copy in Downloads.', short: 'Moved to Applications' })
    expect(moved('').show).toEqual({ lead: 'Marver moved itself to Applications.', text: '', short: 'Moved to Applications' })
    const r = moved('dmg')
    expect(r.next.move).toBeNull()
    expect(r.records).toEqual([{ phase: 'move', why: 'moved', version: '0.99.1' }])
    const old = moved('dmg', NOW - 31 * DAY)
    expect(old).toMatchObject({ show: null, changed: true })
    expect(old.next.move).toBeNull()
  })

  it('a declined move and a staging record are the mover\'s: kept, nothing written for them', () => {
    const staging = { path: '/Applications/.Marver-staging-a', dev: 1, ino: 2, placeholder: null, at: 3 }
    const r = upd.reconcile(f({ move: { declined: true, at: 1 }, staging }), '0.99.1', NOW)
    expect(r).toMatchObject({ changed: false, show: null, records: [] })
    expect(r.next).toEqual(f({ move: { declined: true, at: 1 }, staging }))
  })
})

describe('at launch, through updater.ts, before the first check', () => {
  async function launch() {
    const { FakeClock, FakeUpdater } = await import('../../src/main/testing/updater.ts')
    const { world } = await import('./window-fakes.ts')
    const pill = await import('../../src/main/pill.ts')
    const w = world()
    const u = new FakeUpdater()
    const clock = new FakeClock()
    const records: unknown[] = []
    const m = upd.startUpdater({
      record: (b) => { records.push(b) }, openExternal: () => {}, reveal: () => {},
      adapter: u, clock, gates: { inApplications: true, writable: true }, feed: 'https://example.invalid/releases.json', version: '0.99.1',
    })
    return { w, u, clock, m, records, pill }
  }

  it('found `from`: the failure\'s pill with Download, the file rewritten without the intent, and still no check made', async () => {
    writeFileSync(file(), JSON.stringify({ v: 1, intent: intent(), move: { declined: true, at: 1 }, staging: null }))
    const x = await launch()
    expect(x.m.state().failure).toMatchObject({ from: '0.99.1', to: '0.99.2' })
    expect(x.pill.currentPill()).toMatchObject({ kind: 'update', lead: "0.99.2 couldn't be installed", button: { label: 'Download' } })
    expect(x.records).toContainEqual({ phase: 'install-failed', from: '0.99.1', to: '0.99.2', version: '0.99.1' })
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ v: 1, intent: null, move: { declined: true, at: 1 }, staging: null })
    expect(x.u.count('checkForUpdates')).toBe(0)
  })

  it('found `to`: "Updated to 0.99.1" as a confirmation, installed, the intent gone', async () => {
    writeFileSync(file(), JSON.stringify({ v: 1, intent: intent({ from: '0.99.0', to: '0.99.1' }), move: null, staging: null }))
    const x = await launch()
    expect(x.pill.currentPill()).toMatchObject({ kind: 'confirmation', text: 'Updated to 0.99.1', short: 'Updated', icon: 'check' })
    expect(x.records).toContainEqual({ phase: 'installed', from: '0.99.0', to: '0.99.1', version: '0.99.1' })
    expect(cfg.readUpdateFile().intent).toBeNull()
  })

  it('nothing to reconcile: nothing written', async () => {
    await launch()
    expect(existsSync(file())).toBe(false)
  })
})
