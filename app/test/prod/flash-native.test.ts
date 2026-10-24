/**
 * A real ⌃⌥F (spec 28 A3.3, A3.7 Native, A3.8 #13): posted as CGEvents to the app's pid (test/native/keypost.swift)
 * over a page that swallows every key, it writes one mark and its picture before the pill says "Flash marked", the
 * page never sees the key, and a second ⌃⌥F within 2 s writes none. Through the app's own path: keys.ts, runCommand,
 * recorder.markFlash (the recorder stream's composition of flash-ports.ts) - so the mark is read where the app
 * writes it: the picture under perf/flashes, the record in perf/app-dev.jsonl, the order in the journal's `flash`
 * topic and the pill's.
 *
 * Needs the terminal running the suite to have Accessibility (macOS drops posted events otherwise): without it the
 * cases are skipped and say INCONCLUSIVE, never passed. The control case first: the menu's own ⌃⌥F equivalent, left
 * to it in a test build (MARVER_APP_KEYS_NO_PREVENT=1), must see the command twice, or the harness is blind.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeTool, responsibleApp } from '../harness/capture.ts'
import { launchWindow, sleep, SWALLOW_KEYS, type WindowRun } from '../harness/window.ts'

let KEYPOST = ''
let access = false
try {
  KEYPOST = nativeTool('keypost')
  access = /access: true/.test(execFileSync(KEYPOST, ['check'], { encoding: 'utf8' }))
} catch { access = false }
if (!access) process.stdout.write(`flash-native: INCONCLUSIVE - not run: ${responsibleApp()} may not post key events (Accessibility); the cases are skipped\n`)

const VK_F = 3
const post = (pid: number) => execFileSync(KEYPOST, [String(pid), String(VK_F), 'ctrl,alt'])

let w: WindowRun | undefined
afterEach(async () => { await w?.close(); w = undefined })

async function ready(extraEnv: Record<string, string> = {}) {
  w = await launchWindow('prod', { extraEnv: { MARVER_APP_SHOW: 'focus', ...extraEnv } })
  await w.run.call('onTop', { on: true })
  await w.run.call('show', { focus: true })
  const c = await w.canvas({ slot: 1, script: SWALLOW_KEYS })
  await w.run.call('activate', { id: c.id })
  await w.until((s) => !!s.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
  await sleep(300)
  return c
}
const pictures = () => { const d = join(w!.env.home, 'perf', 'flashes'); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.png')) : [] }
const records = () => { const f = join(w!.env.home, 'perf', 'app-dev.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"kind":"flash"')) : [] }

describe.skipIf(!access)('a real ⌃⌥F (CGEvent) over a page that swallows every key', () => {
  it('control: without preventDefault the menu\'s Ctrl+Alt+F equivalent fires too - the command runs twice', async () => {
    await ready({ MARVER_APP_KEYS_NO_PREVENT: '1' })
    post(w!.run.pid)
    await sleep(600)
    expect((await w!.log('command')).filter((l) => l.data.cmd === 'mark-flash').length, 'the harness is blind: the case below is inconclusive').toBe(2)
  })

  it('one mark and its picture before the pill; the page never sees the key; a second within 2 s writes none', async () => {
    const c = await ready()
    const since = (await w!.log()).length
    post(w!.run.pid)
    await sleep(2500)   // the record lands once the picture, the AGX read and the +1 s GPU window have ended
    expect(pictures()).toHaveLength(1)
    expect(records()).toHaveLength(1)
    const steps = (await w!.log(undefined, since)).filter((l) => l.topic === 'flash' || (l.topic === 'pill' && l.data.short === 'Flash marked'))
      .map((l) => l.topic === 'pill' ? 'pill-sent' : String(l.data.step))
    expect(steps.indexOf('written')).toBeGreaterThanOrEqual(0)
    expect(steps.indexOf('written')).toBeLessThan(steps.indexOf('pill-sent'))
    expect(c.fake.requests.filter((r) => r.path.startsWith('/__mv/test/key-')).map((r) => r.path)).toEqual([])
    expect((await w!.state()).pill).toMatchObject({ kind: 'confirmation', short: 'Flash marked' })
  })

  it('a second ⌃⌥F at +1 s writes nothing and keeps the pill', async () => {
    await ready()
    post(w!.run.pid)
    await sleep(1000)
    const rev = (await w!.state()).pill?.rev
    post(w!.run.pid)
    await sleep(2500)
    expect(pictures()).toHaveLength(1)
    expect(records()).toHaveLength(1)
    expect((await w!.state()).pill?.rev).toBe(rev)
  })
})
