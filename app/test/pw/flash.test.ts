/**
 * Mark a Flash in the app (spec 28 A3.3, A3.7, A3.8 #13, #14), through its own ports (flash-ports.ts: captureApp, the
 * pictures' folder, the strip's pill) with the recorder's half stood in by the `flash:mark` hook: the picture is
 * taken and written before the pill says "Flash marked", a second mark within 2 s writes nothing and keeps the pill,
 * Show selects that mark's picture, a hidden window leaves a mark with no picture and a pill with no button. The
 * key itself (⌃⌥F, caught on every view) is keys.ts's, unit-tested; a real one is the native case's.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppBody } from '../../../src/shared/app-perf.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

let w: WindowRun
let tab: string
beforeAll(async () => {
  w = await launchWindow('pw')
  const c = await w.canvas({ slot: 1, name: 'Tidewell' })
  tab = c.id
  await w.run.call('activate', { id: tab })
  await w.until((x) => !!x.tabs.find((t) => t.id === tab)?.doc?.lifted, 10_000, 'lifted')
  await sleep(300)
})
afterAll(async () => { await w?.close() })

const records = () => w.run.call<AppBody<'flash'>[]>('flash:records')
/** a PNG's width and height, from its IHDR */
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) })

describe('Mark a Flash (A3.8 #13)', () => {
  it('the picture is taken and written before the pill; the record names it; 480 px wide, mode 600', async () => {
    const since = (await w.log()).length
    await w.run.call('flash:mark', { via: 'menu' })
    const rec = (await records()).at(-1)!
    expect(rec).toMatchObject({ via: 'menu', tab, recorder: true })
    expect(rec.picture).toMatch(/^flashes\/\d{8}-\d{6}-\d{3}-[0-9a-f]{4}-dev\.png$/)
    const file = join(w.env.home, 'perf', rec.picture!)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(w.env.home, 'perf', 'flashes')).mode & 0o777).toBe(0o700)
    expect(pngSize(readFileSync(file)).w).toBe(480)
    const lines = (await w.log(undefined, since)).filter((l) => l.topic === 'flash' || (l.topic === 'pill' && (l.data as { short?: string }).short === 'Flash marked'))
    const order = lines.map((l) => l.topic === 'pill' ? 'pill-sent' : String(l.data.step))
    expect(order).toEqual(['capture', 'captured', 'written', 'pill', 'pill-sent', 'record'])
    expect((await w.state()).pill).toMatchObject({ kind: 'confirmation', short: 'Flash marked' })
  })

  it('a second mark within 2 s writes nothing and keeps the pill (no new rev); Show selects that mark\'s picture', async () => {
    const before = (await records()).length
    const pill = (await w.state()).pill!
    await w.run.call('flash:mark', { via: 'key' })
    expect((await records()).length).toBe(before)
    expect((await w.state()).pill!.rev).toBe(pill.rev)
    await w.run.call('effects', { clear: true })
    expect(await w.run.call('pill:action', { rev: pill.rev, act: 'button' })).toBe(true)
    const rec = (await records()).at(-1)!
    expect((await w.run.call<{ shown: string[] }>('effects')).shown).toEqual([join(w.env.home, 'perf', rec.picture!)])
  })

  it('captureApp is the app\'s views as main stacks them, scaled: the canvas below the strip, the cover\'s ground above', async () => {
    const out = join(w.env.dir, 'app.png')
    const r = await w.run.call<{ width: number; height: number; layers: string[] }>('picture:app', { width: 480, path: out })
    expect(r.width).toBe(480)
    expect(r.layers.some((l) => l.startsWith('cover'))).toBe(true)
    expect(r.layers.some((l) => l.includes('localhost') || l.includes('[::1]') || l.includes('127.0.0.1'))).toBe(true)
  })

  it('with the window hidden: a mark with no picture (window hidden), and a pill with no button', async () => {
    await sleep(2100)
    await w.run.call('hide')
    await w.run.call('flash:mark', { via: 'menu' })
    const rec = (await records()).at(-1)!
    expect(rec).toMatchObject({ picture: null, pictureWhy: 'window hidden' })
    await w.run.call('show', { focus: false })
    await sleep(100)
    const pill = (await w.state()).pill
    expect(pill).toMatchObject({ kind: 'confirmation', short: 'Flash marked' })
    expect((pill as { button?: unknown }).button).toBeUndefined()
  })
})
