/**
 * A quit whose helpers end with it (spec 28 A2.2's quit, A2.14 #33): a SIGTERM to the app's process group - the
 * packaged smoke's stop, a terminal's signal - reaches main and every helper at once, so the strip's, Home's and the
 * canvas's renderers, the GPU and the network service go while main's quit runs through guardAll. Main must still
 * exit 0: Electron 45 throws from a WebFrameMain whose renderer went, and one such throw in an event handler (the
 * strip's snapshot sent as the canvas view went) was an uncaught exception - Electron's modal error box, main blocked
 * on the screen, the quit held until SIGKILL. The dev build under the production switches, with
 * test/harness/catch-uncaught.cjs recording what would have been that box. And what an ordinary quit keeps: a cookie
 * a page set a moment before it is on disk afterwards - the network service, which holds the cookie store, writes it
 * as it shuts down (a group SIGTERM ends that process at once, so the smoke signals main alone for its cookie check).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** A launch with one fake canvas running, named the active tab in tabs.json; resolves once its page lifted and reported. */
async function launchOnCanvas(o: { cookie?: boolean; extraEnv?: (e: TestEnv) => Record<string, string> } = {}): Promise<{ env: TestEnv; run: AppRun; fake: FakeCanvas }> {
  const slotBase = runSlotBase()
  const e = testEnv(slotBase)
  const f = await startFakeCanvas({ home: e.home, slotBase, slot: 1, name: 'Quit canvas', script: CLEAN, cookie: o.cookie })
  await f.ready
  const state = join(e.home, 'state-dev')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  writeFileSync(join(state, 'launched'), '')
  writeFileSync(join(state, 'tabs.json'), JSON.stringify({ v: 1, active: { kind: 'canvas', ws: f.ws, origin: f.origin },
    canvases: [{ ws: f.ws, origin: f.origin, path: '/', shownAt: Date.now() }], settings: false, closed: [] }))
  const r = await launchProd(e, { extraEnv: o.extraEnv?.(e) })
  const end = Date.now() + 10_000
  for (;;) {
    const s = await r.call<{ tabs: { kind: string; doc: { lifted?: boolean } | null; reports: { safety: string } }[] }>('state')
    const t = s.tabs.find((x) => x.kind === 'local')
    if (t?.doc?.lifted && t.reports.safety === 'fresh') break
    if (Date.now() > end) throw new Error(`the canvas never lifted with a fresh report: ${JSON.stringify(t)}`)
    await new Promise((ok) => setTimeout(ok, 50))
  }
  return { env: e, run: r, fake: f }
}

describe('the quit (A2.2)', () => {
  it('with its helpers ended at the same moment: exits 0, nothing uncaught, no sheet - a canvas tab loaded and clean, the strip and Home live', async () => {
    ;({ env, run, fake } = await launchOnCanvas({ extraEnv: (e) => ({ NODE_OPTIONS: `--require ${CATCH}`, MVAPP_UNCAUGHT: join(e.dir, 'uncaught.txt') }) }))
    const uncaught = join(env.dir, 'uncaught.txt')
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
    await fake.close(); fake = undefined
    env.cleanup(); env = undefined; run = undefined
  })

  it('a cookie the page set just before an ordinary quit is on disk after it', async () => {
    ;({ env, run, fake } = await launchOnCanvas({ cookie: true }))
    expect(await run.close()).toBe(0)
    const dbs: string[] = []
    const find = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) find(p); else if (e.name === 'Cookies') dbs.push(p) } }
    find(join(env.userData, 'Partitions'))
    const names = dbs.flatMap((db) => execFileSync('sqlite3', [db, 'select name from cookies'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean))
    expect(names).toContain('mvfake')
  })
})
