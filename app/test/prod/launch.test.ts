/**
 * The production-switch harness (spec 28 A2.10, A2.14 #27): the real Electron binary with the app folder and
 * nothing else - no Playwright loader, none of its switches - driven over the control socket (mode 600). The
 * hang, one copy of each guard case, hidden tabs and the memory budget run here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureRoot, startDev, type Dev } from '../../../test/dev-server.ts'
import { launchProd, type AppRun } from '../harness/app.ts'
import { NIC_PROFILES, runSlotBase, snapshot, testEnv, type TestEnv } from '../harness/env.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

interface Ping { name: string; pid: number; argv: string[]; switches: string[]; userData: string; ready: boolean }

let env: TestEnv
let run: AppRun
const nicBefore = NIC_PROFILES.map(snapshot)
beforeAll(async () => {
  env = testEnv(runSlotBase())
  run = await launchProd(env)
})
afterAll(async () => {
  await run?.close()
  env?.cleanup()
})

describe('the dev build with the production switches', () => {
  it('answers on its control socket, mode 600', async () => {
    const p = await run.call<Ping>('ping')
    expect(p).toMatchObject({ name: 'Marver Dev', pid: run.pid, ready: true, userData: env.userData })
    expect(statSync(env.control).mode & 0o777).toBe(0o600)
  })

  it('carries none of Playwright\'s switches: the hang monitor, backgrounding and debugging stay as in production', async () => {
    const p = await run.call<Ping>('ping')
    expect(p.switches).toEqual([])
    expect(p.argv.slice(1)).toEqual([expect.stringMatching(/\/app$/)])
  })

  it('a hook that does not exist is refused by name', async () => {
    await expect(run.call('no-such-hook')).rejects.toThrow(/no hook named no-such-hook/)
  })

  it('quits with 0 and leaves Nic\'s profiles as they were', async () => {
    expect(await run.close()).toBe(0)
    expect(NIC_PROFILES.map(snapshot)).toEqual(nicBefore)
  })
})

/**
 * Spec 30 R7 #37 - NEEDS A REAL WINDOW: run in the VM, not with the headless suites. `marver dev` from this branch's
 * dist/, the app on the real trust: a launch with one restored canvas writes one `launch` line, and its
 * `firstCanvas.page` is in that repo's page.jsonl, whose boot `load` it joins.
 */
describe('the launch line on a real canvas (spec 30 R7; VM only)', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..', '..')
  let w: WindowRun
  let root = ''
  let dev: Dev | null = null
  beforeAll(async () => {
    const b = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 })
    if (b.status !== 0) throw new Error(`the package build failed: ${b.stderr || b.stdout}`)
    root = fixtureRoot('mv-app-launch-', {
      'design/scenes/demo/one.tsx': `export const meta = { title: 'One', viewport: 'mobile' }\nexport default () => <main><h1>One</h1></main>\n`,
      'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }] }),
    })
    w = await launchWindow('prod', {
      extraEnv: { MARVER_APP_FAKE_TRUST: '0' },
      // running before the app starts: the launch restores its tab
      prepare: async (env, slotBase) => { dev = await startDev(root, { env: { MARVER_HOME: env.home, MARVER_SLOT_BASE: String(slotBase) } }); return {} },
    })
    await w.run.call('onTop', { on: true })
  }, 240_000)
  afterAll(async () => {
    await w?.close()
    await dev?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('one line, first canvas uncovered, its page in the repo\'s page.jsonl', async () => {
    const s = await w.until((x) => x.tabs.some((t) => t.kind === 'local'), 30_000, 'the restored tab')
    await w.run.call('activate', { id: s.tabs.find((t) => t.kind === 'local')!.id })
    const file = join(w.env.home, 'perf', 'app-dev.jsonl')
    const launchLines = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"kind":"launch"')).map((l) => JSON.parse(l) as Record<string, any>) : [])
    const end = Date.now() + 30_000
    while (!launchLines().length && Date.now() < end) { await w.run.call('recorder:flush'); await sleep(250) }
    const [line, ...rest] = launchLines()
    expect(rest).toEqual([])
    expect(line!.readyMs).toBeGreaterThan(0)
    expect(line!.windowShownMs).toBeGreaterThanOrEqual(line!.readyMs)
    expect(line!.tabs).toMatchObject({ restored: 1, local: 1 })
    expect(line!.firstCanvas.uncoveredMs).toBeGreaterThan(line!.readyMs)
    expect(line!.firstCanvas.page).toMatch(/^[0-9a-f]{12}$/)
    const page = join(root, 'design', '.local', 'perf', 'page.jsonl')
    const by = Date.now() + 15_000
    const boots = () => (existsSync(page) ? readFileSync(page, 'utf8').split('\n').filter((l) => l.includes(`"page":"${line!.firstCanvas.page}"`) && l.includes('"kind":"load"')) : [])
    while (!boots().length && Date.now() < by) await sleep(250)
    expect(boots().length).toBeGreaterThan(0)
  }, 90_000)
})
