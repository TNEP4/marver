/**
 * VM-ONLY: write it, do not run it on the owner's Mac. It posts real CGEvents and takes the keyboard (spec 30 R16's R12
 * item, as test/prod/keys-native.test.ts does). Run it in the test VM, alone, once the worktree's build is in place.
 *
 * Real keys through AppKit, which Playwright and sendInputEvent never reach: a real ⌘2 and a real ⇧⌘] are told apart in
 * the `cmd` record's `keys` (`Meta+2`, `Meta+Shift+]`, from `input.code`, whatever the layout), each `in: 'shell'`, each
 * started and ended once though a key equivalent also sits behind it, and the `shown` each one causes carries its `by`
 * (R13: `shown` joins `cmd` by id). A real ⇧F6 is written `Shift+F6`.
 *
 * Needs the terminal running the suite to have Accessibility: without it the cases are skipped and say so.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

const SRC = resolve(import.meta.dirname, '..', 'native', 'keypost.swift')
let KEYPOST = ''
let access = false
try {
  KEYPOST = join(mkdtempSync(join(tmpdir(), 'mvkeys-')), 'keypost')
  execFileSync('swiftc', ['-O', SRC, '-o', KEYPOST], { stdio: 'ignore', timeout: 120_000 })
  access = existsSync(KEYPOST) && /access: true/.test(execFileSync(KEYPOST, ['check'], { encoding: 'utf8' }))
} catch { access = false }
if (!access) process.stdout.write('r30-commands-keys-native: INCONCLUSIVE - this terminal may not post key events (Accessibility); the cases are skipped\n')

// macOS virtual key codes
const VK = { two: 19, rightBracket: 30, f6: 97 }
const post = (pid: number, code: number, mods = '') => execFileSync(KEYPOST, [String(pid), String(code), ...(mods ? [mods] : [])])

let w: WindowRun | undefined
afterEach(async () => { await w?.close(); w = undefined })

type Line = Record<string, unknown> & { kind: string }
const lines = async (): Promise<Line[]> => {
  await w!.run.call('recorder:flush')
  const f = join(w!.env.home, 'perf', 'app-dev.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line) : []
}

async function ready() {
  w = await launchWindow('prod', { extraEnv: { MARVER_APP_SHOW: 'focus' } })
  await w.run.call('onTop', { on: true })
  await w.run.call('show', { focus: true })
  const c = await w.canvas({ slot: 1 })
  const d = await w.canvas({ slot: 2 })
  await w.run.call('activate', { id: d.id })
  await w.until((s) => !!s.tabs.find((t) => t.id === d.id)?.doc?.lifted, 10_000, 'lifted')
  await w.run.call('activate', { id: c.id })
  await w.until((s) => !!s.tabs.find((t) => t.id === c.id)?.doc?.lifted, 10_000, 'lifted')
  await sleep(300)
  return { c, d }
}

describe.skipIf(!access)('real keys, told apart (spec 30 #50, #52)', () => {
  it('⌘2 and ⇧⌘]: each its own `keys`, once, and the `shown` it caused names it', async () => {
    const { c, d } = await ready()
    const before = (await lines()).length

    post(w!.run.pid, VK.two, 'cmd')
    await sleep(800)
    const first = (await lines()).slice(before)
    const start2 = first.filter((l) => l.kind === 'cmd' && l.phase === 'start')
    expect(start2, 'one command for one key').toHaveLength(1)
    expect(start2[0]).toMatchObject({ cmd: 'tab-2', via: 'key', keys: 'Meta+2', in: 'shell', tab: d.id })
    expect(first.find((l) => l.kind === 'shown' && l.tab === d.id)?.by).toBe(start2[0]!.id)
    expect(first.find((l) => l.kind === 'cmd' && l.phase === 'end' && l.id === start2[0]!.id)).toMatchObject({ outcome: 'done' })

    await w!.run.call('activate', { id: c.id })
    await sleep(300)
    const mid = (await lines()).length
    post(w!.run.pid, VK.rightBracket, 'cmd,shift')
    await sleep(800)
    const second = (await lines()).slice(mid)
    const startBracket = second.filter((l) => l.kind === 'cmd' && l.phase === 'start' && l.cmd === 'next-tab')
    expect(startBracket, 'one command for one key').toHaveLength(1)
    expect(startBracket[0]).toMatchObject({ via: 'key', keys: 'Meta+Shift+]', in: 'shell' })
    expect(second.find((l) => l.kind === 'shown')?.by).toBe(startBracket[0]!.id)
  })

  it('a real ⇧F6: keys `Shift+F6`, ended in its turn', async () => {
    await ready()
    const before = (await lines()).length
    post(w!.run.pid, VK.f6, 'shift')
    await sleep(500)
    const got = (await lines()).slice(before).filter((l) => l.kind === 'cmd')
    expect(got.find((l) => l.phase === 'start')).toMatchObject({ cmd: 'focus-strip-back', keys: 'Shift+F6' })
    expect(got.find((l) => l.phase === 'end')).toMatchObject({ outcome: 'done' })
  })
})
