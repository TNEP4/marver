/**
 * The shutdown coordinator on the real Electron binary under the production switches (spec 28 A5.1 #35), the fake
 * updater (`MARVER_APP_FAKE_UPDATER=1`) acting in Electron 45's order as S4 measured it: integration evidence for the
 * coordinator, never evidence about the native updater, which is S2's and S4's. The fake appends each event of the
 * restart to a file as it happens (`MARVER_APP_FAKE_UPDATER_LOG`), read once the process is gone.
 *
 * - during an update the window's close is not cancelled; `before-quit` comes once; Electron's default quit does not
 *   race (the coordinator's `window-all-closed` listener: no quit before the second `before-quit-for-update`); the
 *   recorder's queue and tabs.json are on disk (tabs.json's debounce pushed past the case, so only the shutdown's
 *   writes can have put it there); exit 0;
 * - a stuck unload's Force Quit Tab restarts: the sheet names the tab, then the update goes on through the guard;
 * - #17: a preparation failure (`error` after the windows closed) and the wait (`restartWaitMs`): the alert once (held by
 *   the test seam until answered), then one quit, exit 0, the intent kept; the next launch reconciles against the
 *   version it finds.
 * notices.json is in `flushAll` too (shutdown.test checks it runs once), but nothing here makes a notices change wait.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppRun } from '../harness/app.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

interface Phase { kind: string; version?: string }
interface Pill { rev: number; kind: string; lead?: string; text?: string; short: string }
const phase = async (w: WindowRun) => (await w.run.call<{ state: { phase: Phase } }>('updater')).state.phase
const pill = async (w: WindowRun) => (await w.state()).pill as unknown as Pill | null
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
function exited(run: AppRun): Promise<number | null> {
  const p = run.child!
  if (p.exitCode !== null) return Promise.resolve(p.exitCode)
  return new Promise((r) => p.once('exit', (code) => r(code)))
}
const within = <T>(p: Promise<T>, ms = 20_000) => Promise.race([p, sleep(ms).then(() => 'held' as const)])
function inOrder(lines: string[], want: string[]): boolean {
  let i = 0
  for (const l of lines) if (l === want[i]) i += 1
  return i === want.length
}
const updateRecords = (home: string) => {
  const f = join(home, 'perf', 'app-dev.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; phase?: string; version?: string; message?: string }).filter((r) => r.kind === 'update') : []
}

/** A launch with the fake updater ready with 0.99.2, its restart's events going to `<dir>/updater.log`. */
async function launch(o: { restart?: 'ok' | 'error' | 'silent'; timings?: Record<string, number>; prepare?: (home: string) => void } = {}): Promise<{ w: WindowRun; log: string }> {
  let log = ''
  const w = await launchWindow('prod', {
    extraEnv: {
      MARVER_APP_FAKE_UPDATER: '1', MARVER_APP_FAKE_OFFER: '0.99.2', ...(o.restart ? { MARVER_APP_FAKE_RESTART: o.restart } : {}),
      MARVER_APP_TIMINGS: JSON.stringify({ updateFirstMs: 300, stateDebounceMs: 600_000, ...o.timings }),
    },
    prepare: async (env) => {
      log = join(env.dir, 'updater.log')
      mkdirSync(join(env.home, 'state-dev'), { recursive: true, mode: 0o700 })
      writeFileSync(join(env.home, 'state-dev', 'launched'), '')
      o.prepare?.(env.home)
      return { extraEnv: { MARVER_APP_FAKE_UPDATER_LOG: log } }
    },
  })
  await until('ready', async () => (await phase(w)).kind === 'ready')
  return { w, log }
}
/** A fake canvas, shown, lifted and reporting clean. */
async function shown(w: WindowRun, slot: number, name: string): Promise<string> {
  const c = await w.canvas({ slot, name })
  await w.run.call('activate', { id: c.id })
  await w.until((x) => { const t = x.tabs.find((q) => q.id === c.id); return !!t?.doc?.lifted && t.retained }, 10_000, `${name} lifted`)
  await w.report(c.id, { unsaved: false })
  return c.id
}
const press = async (w: WindowRun) => w.run.call<boolean>('pill:action', { rev: (await pill(w))!.rev, act: 'button' })

describe('Restart to Update on the real binary (#15, #16, #20)', () => {
  it('the window\'s close is not cancelled, before-quit comes once, no default quit races, the queue and tabs.json on disk, exit 0', async () => {
    const { w, log } = await launch()
    const home = w.env.home
    try {
      const a = await shown(w, 1, 'Tidewell')
      await w.run.call('exec', { target: a, js: "location.hash = '#/b/kept'; 1" })
      await w.until((x) => x.tabs.find((t) => t.id === a)!.path === '/#/b/kept', 3000, 'the board followed')
      expect(existsSync(join(home, 'state-dev', 'tabs.json'))).toBe(false)     // its debounce is past the case
      const exit = exited(w.run)
      expect(await press(w)).toBe(true)
      expect(await within(exit)).toBe(0)
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(inOrder(lines, ['before-quit-for-update', 'window-closed', 'window-all-closed', 'before-quit-for-update', 'before-quit', 'will-quit', 'exit 0'])).toBe(true)
      expect(lines.filter((l) => l === 'before-quit')).toHaveLength(1)
      expect(lines.indexOf('before-quit')).toBeGreaterThan(lines.lastIndexOf('before-quit-for-update'))
      const tabs = JSON.parse(readFileSync(join(home, 'state-dev', 'tabs.json'), 'utf8')) as { active: unknown; canvases: { path: string }[]; closed: unknown[] }
      expect(tabs.canvases.map((c) => c.path)).toContain('/#/b/kept')
      expect(tabs.closed).toEqual([])
      expect(JSON.parse(readFileSync(join(home, 'state-dev', 'update.json'), 'utf8')).intent).toMatchObject({ to: '0.99.2', via: 'restart' })
      expect(updateRecords(home).filter((r) => r.phase === 'restart')).toEqual([expect.objectContaining({ version: '0.99.2' })])
    } finally {
      await w.close()
    }
  })

  it('a stuck unload\'s Force Quit Tab restarts: the sheet names the tab, then the update goes on and exits 0', async () => {
    const { w, log } = await launch({
      timings: { unloadMinHiddenMs: 300, unloadCooldownMs: 2000, unloadActMs: 200, unloadEffectMs: 200, quitWaitMs: 1500 },
      prepare: (home) => writeFileSync(join(home, 'config.json'), JSON.stringify({ unloadUnderPressure: true })),
    })
    try {
      const s = await shown(w, 1, 'Canvas 1')
      await shown(w, 2, 'Canvas 2')
      await sleep(450)
      expect(await w.run.call('closeNever', { target: s })).toBe(true)
      await w.run.call('sheet', { mode: 'hold' })
      const n = (await w.log()).length
      expect((await w.run.call<{ unload: { id: string }[] }>('memory:tick', { level: 4 })).unload.map((u) => u.id)).toEqual([s])
      await w.until((x) => x.tabs.find((t) => t.id === s)!.unload?.phase === 'unsure', 5000, 'unsure')
      const exit = exited(w.run)
      expect(await press(w)).toBe(true)
      const sheet = await until('the stuck sheet', async () => { const x = await w.run.call<{ shown: Record<string, unknown>[]; held: number }>('sheets'); return x.held >= 1 ? x.shown.at(-1) : null })
      expect(sheet).toMatchObject({ kind: 'guard', action: 'update', tabs: [s], message: expect.stringMatching(/^Canvas 1 isn't closing$/), buttons: ['Keep Waiting', 'Force Quit Tab'] })
      expect((await w.log('quit', n)).map((l) => l.data)).toEqual([{ asked: true, update: '0.99.2' }, { answer: 'stuck', update: '0.99.2' }])
      expect(await phase(w)).toMatchObject({ kind: 'ready', version: '0.99.2' })
      // Force Quit Tab: the update asked again, through the guard - and on to the restart
      await w.run.call('sheet:answer', { ok: true })
      expect(await within(exit)).toBe(0)
      expect(readFileSync(log, 'utf8')).toContain('exit 0')
    } finally {
      await w.close()
    }
  })
})

describe('a failure before exit (#17) and the next launch (#18)', () => {
  for (const restart of ['error', 'silent'] as const) {
    it(`${restart === 'error' ? 'an error after the windows closed' : 'no exit restartWaitMs after the windows closed'}: the alert once, one quit, exit 0, the intent kept; the next launch reconciles`, async () => {
      const { w, log } = await launch({ restart, timings: { restartWaitMs: 1500 } })
      const env = w.env
      try {
        await shown(w, 1, 'Tidewell')
        const exit = exited(w.run)
        expect(await press(w)).toBe(true)
        // the window and every view are gone; the app still answers, the alert held by the test seam
        const alerts = await until('the alert', async () => { const x = await w.run.call<{ shown: { message: string; detail: string; buttons: string[] }[]; held: boolean }>('shutdown:alerts'); return x.held ? x : null }, 15_000)
        expect(alerts.shown).toEqual([{
          message: "Marver couldn't restart to install 0.99.2",
          detail: 'Your canvases were closed safely. Open Marver again: it may already be 0.99.2, and if not, it tells you how to get it.',
          buttons: ['Quit'],
        }])
        expect((await w.run.call<{ quitting: boolean }>('shutdown')).quitting).toBe(true)
        expect((await w.run.call<{ calls: string[] }>('updater')).calls).toContain('windows-closed')
        expect(readFileSync(log, 'utf8')).not.toContain('before-quit\n')          // nothing quit by itself
        await sleep(restart === 'silent' ? 2000 : 500)
        expect((await w.run.call<{ shown: unknown[] }>('shutdown:alerts')).shown).toHaveLength(1)
        expect(await w.run.call('shutdown:alert-answer')).toBe(true)
        expect(await within(exit)).toBe(0)
        const lines = readFileSync(log, 'utf8').trim().split('\n')
        expect(lines.filter((l) => l === 'before-quit')).toHaveLength(1)
        expect(JSON.parse(readFileSync(join(env.home, 'state-dev', 'update.json'), 'utf8')).intent).toMatchObject({ to: '0.99.2', via: 'restart' })
        expect(updateRecords(env.home).filter((r) => r.phase === 'restart-failed')).toEqual([expect.objectContaining({ version: '0.99.2', ...(restart === 'error' ? { message: 'Could not write update request' } : {}) })])
      } finally {
        await w.close({ keep: true })
      }
      // the next launch reads the version it finds: here the quit installed it
      const next = await launchWindow('prod', { env, extraEnv: { MARVER_APP_FAKE_UPDATER: '1', MARVER_APP_FAKE_VERSION: '0.99.2' } })
      try {
        await next.run.call('activate', { id: 'home' })
        expect(await until('the confirmation', async () => { const p = await pill(next); return p?.kind === 'confirmation' ? p : null })).toMatchObject({ text: 'Updated to 0.99.2' })
        expect((await next.run.call<{ file: { intent: unknown } }>('updater')).file.intent).toBeNull()
      } finally {
        await next.close()
      }
    })
  }
})
