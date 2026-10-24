/**
 * Unloading against a REAL canvas (spec 28 A2.10's (A3) cases, A3.8 #43; A3.7's real-shell cases): `marver dev` from
 * this branch's dist/ in a temporary project on the run's own MARVER_HOME and slot base, the app on the real trust
 * with its production switches. The camera a person left 150 ms after a zoom - inside the shell's second of quiet -
 * comes back exactly after an unload and its reopen, under a selection link (the 0.27.2 shell writes it as the page
 * hides; without that write it is lost: app-bridge-browser's camera case fails so). An agent at work keeps its tab;
 * its work done, the tab is unloaded at the next tick. A link into the unloaded tab opens on the frame it names, not
 * under the saved camera. The pressure is a sample the case describes (`memory:tick`).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLI, fixtureRoot, startDev, type Dev } from '../../../test/dev-server.ts'
import { launchWindow, sleep, type State, type TabDump, type WindowRun } from '../harness/window.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const TIMINGS = { unloadMinHiddenMs: 300, unloadCooldownMs: 2000, unloadEffectMs: 200 }
const HIDDEN = TIMINGS.unloadMinHiddenMs + 150
const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`
const board = (name: string, order: number) => JSON.stringify({ version: 1, name, order, auto: false, nodes: [
  { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
  { key: 'n-two', frame: 'demo/two', x: 1600, y: 900, w: 390, h: 844 },
] })

let w: WindowRun
let root = ''
let dev: Dev | null = null
let id = ''

const tab = (s: State, x: string): TabDump => s.tabs.find((t) => t.id === x)!
const exec = <T>(js: string) => w.run.call<T>('exec', { target: id, js })
const tick = (o: Record<string, unknown>) => w.run.call<{ unload: { id: string }[] }>('memory:tick', o)
/** the shell booted on board `b`, its frames ready */
const onB = `!!window.__mvStore && __mvStore.getState().board === 'b' && __mvStore.getState().nodes.length === 2 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`
async function waitIn(js: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await exec<boolean>(js).catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out waiting in the page for: ${js}`)
    await sleep(100)
  }
}
/** the page said exactly idle and clean, since its last commit */
const idle = () => w.until((s) => { const b = tab(s, id).reports.busy; return tab(s, id).reports.safety === 'fresh' && !!b && !b.busy && !b.unsaved }, 30_000, 'the shell idle and clean')
/** where the camera looks, and its scale */
const camera = () => exec<{ x: number; y: number; s: number }>(`(() => { const v = __mvJamCanvas.view(); return { x: v.x, y: v.y, s: document.querySelector('.sh-canvas').clientWidth / v.w } })()`)
const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, MARVER_HOME: w.env.home, MARVER_NO_UPDATE_CHECK: '1' } })

beforeAll(async () => {
  // the package's dist/ from this branch: the shell the app meets is the one these commits ship
  const tsdown = join(ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  const b = spawnSync(process.execPath, [tsdown], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 })
  if (b.status !== 0) throw new Error(`the package build failed: ${b.stderr || b.stdout}`)
  w = await launchWindow('prod', { extraEnv: { MARVER_APP_FAKE_TRUST: '0', MARVER_APP_TIMINGS: JSON.stringify(TIMINGS) } })
  root = fixtureRoot('mv-app-unload-', {
    'design/config.ts': `export default { share: { name: 'Unload canvas' } }\n`,
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/boards/a.json': board('a', 0),
    'design/boards/b.json': board('b', 1),
  })
  dev = await startDev(root, { env: { MARVER_HOME: w.env.home, MARVER_SLOT_BASE: String(w.slotBase) } })
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.port === dev!.port && t.reg.state === 'ready'), 15_000, 'the canvas from the registry')
  id = s.tabs.find((t) => t.reg?.port === dev!.port)!.id
}, 240_000)
afterAll(async () => {
  try { if (root && dev) cli('work', 'done', '--all') } catch { /* not working */ }
  await w?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('a real shell (A2.10 (A3), A3.8 #43)', () => {
  it('the camera left 150 ms after a zoom comes back exactly after an unload, under a selection link', async () => {
    await w.run.call('activate', { id })
    await w.until((s) => !!tab(s, id).doc?.lifted && tab(s, id).doc!.trusted, 30_000, 'the canvas trusted')
    await exec(`location.hash = '#/b/b?n=n-two'; 1`)
    await waitIn(onB)
    await w.until((s) => tab(s, id).path === '/#/b/b?n=n-two', 5000, 'the selection link in the path')
    await idle()
    const zoomAt = Date.now()
    await exec(`__mvJamCanvas.zoomTo(1.37); 1`)
    await sleep(250 + 150)   // landed, then 150 ms: the shell's own write is still most of a second away
    const left = await camera()
    expect(left.s).toBeCloseTo(1.37, 2)
    await w.run.call('activate', { id: 'home' })
    // the hide wrote it, read back through the hidden page inside the shell's second of quiet - before its own
    // debounced write could have come: so it is the 0.27.2 write at the hide that keeps it, nothing slower
    const stored = await exec<{ x: number; y: number; scale: number } | null>(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('mv-camera:') && x.endsWith(':b')); return k ? JSON.parse(localStorage.getItem(k)) : null })()`)
    expect(Date.now() - zoomAt).toBeLessThan(1000)
    expect(stored?.scale).toBeCloseTo(left.s, 2)
    await sleep(HIDDEN)
    await idle()
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([id])
    await w.until((s) => tab(s, id).view === 'unloaded' && !tab(s, id).hasView, 10_000, 'unloaded')
    await w.run.call('activate', { id })
    await w.until((s) => !!tab(s, id).doc?.lifted && tab(s, id).doc!.trusted && tab(s, id).unload == null, 30_000, 'reopened')
    await waitIn(onB)
    expect(await exec('window.marverApp.reopen')).toBe(true)
    expect((await w.tab(id)).path).toBe('/#/b/b?n=n-two')
    await sleep(300)
    const back = await camera()
    expect(Math.abs(back.s - left.s)).toBeLessThan(0.01)
    expect(Math.abs(back.x - left.x)).toBeLessThan(0.01)
    expect(Math.abs(back.y - left.y)).toBeLessThan(0.01)
  }, 120_000)

  it('an agent at work keeps its tab through critical; its work done, the tab is unloaded at the next tick', async () => {
    await w.run.call('activate', { id })
    await w.until((s) => !!tab(s, id).doc?.lifted && tab(s, id).hasView, 30_000, 'the canvas shown')
    await idle()
    await w.run.call('activate', { id: 'home' })
    await sleep(HIDDEN)
    cli('work', 'start', 'demo/one')
    await w.until((s) => !!tab(s, id).reports.busy?.why.includes('agent'), 15_000, 'the agent at work, said by the hidden page')
    expect((await tick({ level: 4 })).unload).toEqual([])
    const st = await w.run.call<{ tabs: { id: string; why: string | null }[] }>('memory:state')
    expect(st.tabs.find((t) => t.id === id)?.why).toBe('busy')
    await sleep(300)
    expect((await w.tab(id)).view).toBe('live')
    cli('work', 'done', '--all')
    await idle()
    expect((await tick({ level: 4 })).unload.map((u) => u.id)).toEqual([id])
    await w.until((s) => tab(s, id).view === 'unloaded', 10_000, 'unloaded')
  }, 120_000)

  it('a link into the unloaded tab opens on what it names: the frame it selects fitted, never the camera the tab was left at', async () => {
    // the cases above left it unloaded on board b, its camera at 1.37 on n-two: a link to n-one on that board
    const t = await w.tab(id)
    expect(t.view).toBe('unloaded')
    const entry = { state: 'ready', origin: t.reg!.origin, port: t.reg!.port, ws: t.reg!.ws, name: 'Unload canvas' }
    expect(await w.run.call('openInTab', { entry, url: `${t.reg!.origin}/#/b/b?n=n-one`, rest: '/#/b/b?n=n-one' })).toEqual({ ok: true })
    await w.until((s) => !!tab(s, id).doc?.lifted && tab(s, id).doc!.trusted && tab(s, id).unload == null, 30_000, 'the link loaded')
    await waitIn(onB)
    expect(await exec('window.marverApp.reopen')).toBe(false)
    expect((await w.tab(id)).path).toBe('/#/b/b?n=n-one')
    await sleep(400)   // the fit's flight
    expect(await exec('__mvStore.getState().selection')).toEqual(['n-one'])
    // n-one spans 0..390 by 0..844 on the board; the camera left on n-two looks near (1795, 1322)
    const v = await exec<{ x: number; y: number; w: number; h: number }>('__mvJamCanvas.view()')
    const centre = { x: v.x + v.w / 2, y: v.y + v.h / 2 }
    expect(centre.x).toBeGreaterThan(0)
    expect(centre.x).toBeLessThan(390)
    expect(centre.y).toBeGreaterThan(0)
    expect(centre.y).toBeLessThan(844)
  }, 120_000)
})
