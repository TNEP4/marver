/**
 * Trust against a REAL canvas (spec 28 A2.10's first case, v1.12 r1 #1): `marver dev` from this branch's dist/ in a
 * temporary project, on the run's own MARVER_HOME and slot base. Its slot file is seen starting, then ready; the tab
 * verifies within 2 s of ready; the 0.27.1 shell's hello, theme, busy and menu - said at boot, before the admit -
 * arrive once it lands, hello first, and its busy makes the document fresh; its proved logo is fetched; a menu click
 * does what the key does and the next menu says so; `kill -9` makes it gone within one reconcile tick, the document
 * untrusted at once, stale, and told untrusted.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOUNDS, WHY } from '../../../src/shared/app-api.ts'
import { fixtureRoot, startDev, type Dev } from '../../../test/dev-server.ts'
import { launchPW, type AppRun } from '../harness/app.ts'
import { runSlotBase, testEnv, type TestEnv } from '../harness/env.ts'
import { journal, open, sleep, tabState, trusted, until, type TabState } from '../harness/trust.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>\n'
const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`

const slotBase = runSlotBase()
let env: TestEnv
let run: AppRun
let root = ''
let dev: Dev | null = null
const seen: { t: number; state: string }[] = []
const onDisk: { t: number; state: string }[] = []
let id = ''
let state: TabState

beforeAll(async () => {
  // the package's dist/ from this branch: the shell the app meets is the one these commits ship
  const tsdown = join(ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  const b = spawnSync(process.execPath, [tsdown], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 })
  if (b.status !== 0) throw new Error(`the package build failed: ${b.stderr || b.stdout}`)
  env = testEnv(slotBase)
  run = await launchPW(env)
  root = fixtureRoot('mv-app-trust-', {
    'design/config.ts': `export default { share: { name: 'Trust canvas' } }\n`,
    'design/logo.svg': SVG,
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }] }),
  })
  let polling = true
  const direct = (async () => {
    while (polling) {
      try {
        for (const n of readdirSync(join(env.home, 'running')).filter((x) => /^slot-\d+\.json$/.test(x))) {
          const r = JSON.parse(readFileSync(join(env.home, 'running', n), 'utf8')) as { state: string; name: string }
          if (r.name === 'Trust canvas' && onDisk.at(-1)?.state !== r.state) onDisk.push({ t: Date.now(), state: r.state })
        }
      } catch { /* not yet */ }
      await sleep(5)
    }
  })()
  const poll = (async () => {
    while (polling) {
      const es = await run.call<{ name: string; state: string }[]>('trust:registry').catch(() => [])
      const e = es.find((x) => x.name === 'Trust canvas')
      if (e && seen.at(-1)?.state !== e.state) seen.push({ t: Date.now(), state: e.state })
      await sleep(25)
    }
  })()
  try {
    dev = await startDev(root, { env: { MARVER_HOME: env.home, MARVER_SLOT_BASE: String(slotBase) } })
    await until('the registry to say ready', () => seen.some((s) => s.state === 'ready'), 15_000)
  } finally { polling = false; await poll; await direct }
}, 240_000)
afterAll(async () => {
  await dev?.stop()
  await run?.close()
  env?.cleanup()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('a real marver dev', () => {
  it('its slot file says starting, then ready; activated, the tab verifies within 2 s of ready', async () => {
    // warm, a real start is starting for some 40 ms - inside the watch's 100 ms debounce, so the app may see ready alone
    expect(onDisk.map((s) => s.state)).toEqual(['starting', 'ready'])
    expect(seen.map((s) => s.state).at(-1)).toBe('ready')
    const ready = seen.find((s) => s.state === 'ready')!.t
    id = await open(run, dev!.port, '/#/b/main')
    state = await trusted(run, id, 10_000)
    const at = state.events.find((e) => e.e.kind === 'commit' && e.e.attributed)!.t
    expect(at - ready).toBeLessThan(2000)
    expect(state.entry).toMatchObject({ state: 'ready', port: dev!.port })
  })

  it('admits the 0.27.1 shell: what it said at boot arrives once admitted, hello first, and its busy makes it fresh', async () => {
    const s = await until('the shell\'s four reports', async () => { const t = await tabState(run, id); return t.current?.menu && t.current.busy && t.current.theme && t.current.hello ? t : null }, 20_000)
    const h = s.current!.hello!
    expect(h.version).toMatch(BOUNDS.versionChars)
    expect(h.page).toMatch(BOUNDS.page)
    expect(h.board).toBe('main')
    expect(s.current!.theme).toEqual({ dark: false })
    expect(s.current!.safety).toBe('fresh')
    expect(s.current!.busy!.why.every((w) => (WHY as readonly string[]).includes(w))).toBe(true)
    expect(s.current!.menu!.map((m) => m.id)).toEqual(expect.arrayContaining(['fit-all', 'play', 'hide-ui', 'comments']))
    const b = (await journal(run, 'bridge')).map((l) => l.data).filter((d) => d.wc === s.wc)
    const accepted = b.filter((d) => d.event === 'accepted').map((d) => d.ch)
    expect(accepted[0]).toBe('hello')
    expect(accepted.slice(0, 4).sort()).toEqual(['busy', 'hello', 'menu', 'theme'])
    expect(b.findIndex((d) => d.event === 'admit')).toBeLessThan(b.findIndex((d) => d.event === 'accepted'))
    expect(b.filter((d) => d.event === 'refused')).toEqual([])
    state = s
  })

  it('its logo is fetched with its proof', async () => {
    expect(await run.call('trust:logo', { port: dev!.port })).toMatchObject({ type: 'svg' })
  })

  it('a menu click does what the key does, and the next menu says so', async () => {
    const was = state.current!.menu!.find((m) => m.id === 'hide-ui') as { checked?: boolean }
    expect(was.checked).toBe(false)
    // a click goes to the document committed when it is sent. A fresh project's first load can still be replaced by
    // Vite's own full reload (its dependencies optimized on that load), and a click sent while it reloads reaches no
    // page: the case clicks again only for a document committed since its last click, never twice into one
    const click = async (want: boolean) => {
      let sentTo = -1
      const clicks: number[] = []
      await until(`Hide UI ${want ? 'checked' : 'unchecked'} (clicks into commits ${clicks.join(', ')})`, async () => {
        const s = await tabState(run, id)
        if ((s.current?.menu?.find((m) => m.id === 'hide-ui') as { checked?: boolean } | undefined)?.checked === want) return true
        if (s.trusted && s.commits !== sentTo) {
          sentTo = s.commits
          clicks.push(s.commits)
          expect(await run.call('trust:menu-click', { id, item: 'hide-ui' })).toBe(true)
        }
        return false
      })
      if (clicks.length > 1) process.stdout.write(`trust-shell: Hide UI took ${clicks.length} clicks - the page reloaded under the first (commits ${clicks.join(', ')})\n`)
    }
    await click(true)
    await click(false)
  })

  it('kill -9: gone within one reconcile tick, untrusted at once, stale, and told untrusted', async () => {
    const t0 = Date.now()
    await dev!.stop('SIGKILL')
    await until('the registry to drop it', async () => !(await run.call<{ port: number }[]>('trust:registry')).some((e) => e.port === dev!.port), 7000)
    expect(Date.now() - t0).toBeLessThan(5300)
    const s = await tabState(run, id)
    expect(s.trusted).toBe(false)
    expect(s.current?.safety).toBe('stale')
    const b = (await journal(run, 'bridge')).map((l) => l.data)
    expect(b.some((d) => d.event === 'untrusted' && d.wc === s.wc)).toBe(true)
    dev = null
  })
})
