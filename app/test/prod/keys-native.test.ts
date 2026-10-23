/**
 * "A key fires once" with real key events (spec 28 A2.4, A2.7, A2.14 #25): Playwright and sendInputEvent never
 * reach AppKit's key equivalents, so these cases post CGEvents to the app's own pid (test/native/keypost.swift).
 * The control case first: a test build that leaves the menu its key equivalents (MARVER_APP_KEYS_NO_PREVENT=1) must
 * see the command twice, or the harness is blind and every key case is inconclusive.
 *
 * Needs the terminal running the suite to have Accessibility (macOS drops posted events otherwise) and brings the
 * test window to the front, taking the keyboard for a moment: without the access the cases are skipped and say so.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchWindow, sleep, SWALLOW_KEYS, hits, type WindowRun } from '../harness/window.ts'

const SRC = resolve(import.meta.dirname, '..', 'native', 'keypost.swift')
let KEYPOST = ''
let access = false
try {
  KEYPOST = join(mkdtempSync(join(tmpdir(), 'mvkeys-')), 'keypost')
  execFileSync('swiftc', ['-O', SRC, '-o', KEYPOST], { stdio: 'ignore', timeout: 120_000 })
  access = existsSync(KEYPOST) && /access: true/.test(execFileSync(KEYPOST, ['check'], { encoding: 'utf8' }))
} catch { access = false }
if (!access) process.stdout.write('keys-native: INCONCLUSIVE - this terminal may not post key events (Accessibility); the cases are skipped\n')

// macOS virtual key codes
const VK = { comma: 43, two: 19, j: 38 }
const post = (pid: number, code: number, mods = '') => execFileSync(KEYPOST, [String(pid), String(code), ...(mods ? [mods] : [])])

let w: WindowRun | undefined
afterEach(async () => { await w?.close(); w = undefined })

async function ready(extraEnv: Record<string, string> = {}) {
  w = await launchWindow('prod', { extraEnv: { MARVER_APP_SHOW: 'focus', ...extraEnv } })
  await w.run.call('onTop', { on: true })
  await w.run.call('show', { focus: true })
  const c = await w.canvas({ slot: 1, script: SWALLOW_KEYS })
  const d = await w.canvas({ slot: 2 })
  await w.run.call('activate', { id: c.id })
  await w.until((s) => !!s.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
  await sleep(300)
  return { c, d }
}

const settingsCount = async () => (await w!.log('command')).filter((l) => l.data.cmd === 'settings').length
/**
 * Every way ⌘2 can switch to the second canvas: the key's command (`tab-2`, keys.ts) and the Window menu's item for
 * that tab, whose Cmd+2 key equivalent runs its click (views.ts tabAct, journaled `tab-act`) - so a double fire
 * through the menu is counted too, not only one through the command table.
 */
const switchesTo = async (id: string) => {
  const viaKey = (await w!.log('command')).filter((l) => l.data.cmd === 'tab-2').length
  const viaMenu = (await w!.log('tab-act')).filter((l) => l.data.what === 'activate' && l.data.tab === id && !l.data.stale).length
  return viaKey + viaMenu
}

describe.skipIf(!access)('real key events (CGEvent) over a page that swallows every key', () => {
  it('control: without preventDefault the menu\'s key equivalent fires too - ⌘, and ⌘2 each run twice', async () => {
    const { c, d } = await ready({ MARVER_APP_KEYS_NO_PREVENT: '1' })
    post(w!.run.pid, VK.comma, 'cmd')
    await sleep(600)
    expect(await settingsCount(), 'the harness is blind: every key case below is inconclusive').toBe(2)
    await w!.run.call('activate', { id: c.id })
    await sleep(300)
    post(w!.run.pid, VK.two, 'cmd')
    await sleep(600)
    expect(await switchesTo(d.id), 'the harness cannot see the Window menu\'s Cmd+2: the ⌘2 case below is inconclusive').toBe(2)
  })

  it('⌘, opens Settings once; ⌘2 switches once; J reaches the page once and runs nothing of the menu', async () => {
    const { c, d } = await ready()
    post(w!.run.pid, VK.comma, 'cmd')
    await sleep(600)
    expect(await settingsCount()).toBe(1)
    await w!.run.call('activate', { id: c.id })
    await sleep(300)
    post(w!.run.pid, VK.two, 'cmd')
    await sleep(600)
    expect(await switchesTo(d.id)).toBe(1)
    expect((await w!.state()).active).toBe(d.id)
    await w!.run.call('activate', { id: c.id })
    await sleep(300)
    const before = (await w!.log('command')).length
    post(w!.run.pid, VK.j)
    for (let i = 0; i < 20 && hits(c.fake, '/__mv/test/key-j') === 0; i++) await sleep(100)
    expect(hits(c.fake, '/__mv/test/key-j')).toBe(1)
    expect((await w!.log('command')).length).toBe(before)
  })
})
