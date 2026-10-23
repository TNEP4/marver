/**
 * A quit whose helpers end with it (spec 28 A2.2's quit, A2.14 #33): a SIGTERM to the app's process group - the
 * packaged smoke's stop, a terminal's signal - reaches main and every helper at once, so the strip's, Home's and the
 * canvas's renderers, the GPU and the network service go while main's quit runs through guardAll. Main must still
 * exit 0: Electron 45 throws from a WebFrameMain whose renderer went, and one such throw in an event handler (the
 * strip's snapshot sent as the canvas view went) was an uncaught exception - Electron's modal error box, main blocked
 * on the screen, the quit held until SIGKILL. The dev build under the production switches, with
 * test/harness/catch-uncaught.cjs recording what would have been that box.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { launchProd, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'

const CATCH = resolve(import.meta.dirname, '..', 'harness', 'catch-uncaught.cjs')
const CLEAN = "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'quit-page-01' }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }"

let env: TestEnv | undefined
let run: AppRun | undefined
let fake: FakeCanvas | undefined
afterAll(async () => {
  if (run?.child && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
  await fake?.close()
  env?.cleanup()
})

describe('a quit with its helpers ended at the same moment', () => {
  it('exits 0, nothing uncaught, no sheet: a canvas tab loaded and clean, the strip and Home live', async () => {
    const slotBase = runSlotBase()
    env = testEnv(slotBase)
    const uncaught = join(env.dir, 'uncaught.txt')
    // the canvas running and named the active tab before the app starts, as the smoke's clean launch has it
    fake = await startFakeCanvas({ home: env.home, slotBase, slot: 1, name: 'Quit canvas', script: CLEAN })
    await fake.ready
    const state = join(env.home, 'state-dev')
    mkdirSync(state, { recursive: true, mode: 0o700 })
    writeFileSync(join(state, 'launched'), '')
    writeFileSync(join(state, 'tabs.json'), JSON.stringify({ v: 1, active: { kind: 'canvas', ws: fake.ws, origin: fake.origin },
      canvases: [{ ws: fake.ws, origin: fake.origin, path: '/', shownAt: Date.now() }], settings: false, closed: [] }))
    run = await launchProd(env, { extraEnv: { NODE_OPTIONS: `--require ${CATCH}`, MVAPP_UNCAUGHT: uncaught } })
    const end = Date.now() + 10_000
    for (;;) {
      const s = await run.call<{ tabs: { kind: string; doc: { lifted?: boolean } | null; reports: { safety: string } }[] }>('state')
      const t = s.tabs.find((x) => x.kind === 'local')
      if (t?.doc?.lifted && t.reports.safety === 'fresh') break
      if (Date.now() > end) throw new Error(`the canvas never lifted with a fresh report: ${JSON.stringify(t)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(readFileSync(uncaught, 'utf8')).toContain('loaded browser')   // the catcher is in main: the case is not blind
    const child = run.child!
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })))
    // the process group's SIGTERM, without signalling this test's own group: every helper, then main, in one turn
    const helpers = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
    expect(helpers.length).toBeGreaterThanOrEqual(3)
    for (const p of helpers) { try { process.kill(p, 'SIGTERM') } catch { /* gone */ } }
    child.kill('SIGTERM')
    const r = await Promise.race([exited, new Promise<'held'>((ok) => setTimeout(() => ok('held'), 10_000))])
    const said = existsSync(uncaught) ? readFileSync(uncaught, 'utf8') : ''
    expect(said.split('\n').filter((l) => /^(uncaught|rejection):/.test(l))).toEqual([])
    expect(r).toEqual({ code: 0, signal: null })
  })
})
