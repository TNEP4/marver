/**
 * Clicks over the strip (spec 28 A3.8 #38, S13's gap): real mouse events, posted as CGEvents to the app's pid
 * (test/native/clickpost.swift), never moving the person's cursor. In the strip's empty part - over a full-height
 * canvas once the one ground is in - the page logs no `pointerdown` and no `wheel`, and a drag there moves the
 * window; on a tab, the tab activates and the page logs nothing. The strip's empty part comes from the strip itself
 * (its tabs' right edge, its pill's left), never guessed.
 *
 * The control case comes first: a click and a scroll at y 100 both reach the page, or every case after it is
 * skipped and says INCONCLUSIVE (review of a3-native, major #7: a case that asserts nothing happens passes when posted
 * events are dropped, so it never runs without its control). The empty-part case reads the views' bounds first: with
 * the canvas view at y 44 or below (the opaque layout, before the one ground) no canvas sits under the strip, the
 * case would pass by construction, and it says NOT APPLICABLE and skips. Needs the terminal running the suite to have
 * Accessibility: without it every case is skipped and says INCONCLUSIVE, never passed. Also checked by hand in the
 * first 0.2 build.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nativeTool, responsibleApp } from '../harness/capture.ts'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import type { FakeCanvas } from '../harness/fake-canvas.ts'

let CLICK = ''
let access = false
try {
  CLICK = nativeTool('clickpost')
  access = /access: true/.test(execFileSync(CLICK, ['check'], { encoding: 'utf8' }))
} catch { access = false }
if (!access) process.stdout.write(`clicks-native: INCONCLUSIVE - not run: ${responsibleApp()} may not post mouse events (Accessibility); the cases are skipped\n`)

/** A page that tells the server about every pointerdown and wheel it sees. */
const LOG_INPUT = `addEventListener('pointerdown', function (e) { navigator.sendBeacon('/__mv/test/pointerdown-' + Math.round(e.clientY)) }, true);
addEventListener('wheel', function () { navigator.sendBeacon('/__mv/test/wheel') }, { capture: true, passive: true });`

let w: WindowRun
let a: { fake: FakeCanvas; id: string }
let b: { fake: FakeCanvas; id: string }
const click = (...xs: number[]) => execFileSync(CLICK, ['click', String(w.run.pid), ...xs.map((x) => String(Math.round(x)))])
const scroll = (x: number, y: number) => execFileSync(CLICK, ['scroll', String(w.run.pid), String(Math.round(x)), String(Math.round(y)), '0', '-40'])
const drag = (x0: number, y0: number, x1: number, y1: number) => execFileSync(CLICK, ['drag', String(w.run.pid), ...[x0, y0, x1, y1].map((x) => String(Math.round(x)))])
const content = async () => (await w.run.call<{ content: { x: number; y: number; width: number; height: number }; bounds: { x: number; y: number } }>('window'))
const seen = (f: FakeCanvas, prefix: string) => f.requests.filter((r) => r.path.startsWith(`/__mv/test/${prefix}`)).length
/** the strip's empty part, from the strip: between its last tab and its pill (or its right padding) */
/** the control's outcome: a click and a scroll at y 100 reached the page (null: it has not run) */
let control: { click: boolean; scroll: boolean } | null = null
/** every case after the control needs it: else it is skipped, saying INCONCLUSIVE - never passed */
const needControl = (ctx: { skip: (note?: string) => never }) => {
  if (control?.click && control.scroll) return
  const why = `INCONCLUSIVE - the control ${!control ? 'did not run' : `posted ${[!control.click && 'a click', !control.scroll && 'a scroll'].filter(Boolean).join(' and ')} at y 100 that never reached the page`}: nothing below can be told from a dropped event`
  process.stdout.write(`clicks-native: ${why}\n`)
  ctx.skip(why)
}
const emptyX = async () => w.run.call<number>('exec', { target: 'strip', js: `(() => { const t = [...document.querySelectorAll('#tabs > *')].pop(); const p = document.getElementById('pill'); const l = t ? t.getBoundingClientRect().right : 120; const r = p && !p.hidden ? p.getBoundingClientRect().left : innerWidth - 20; return Math.round((l + r) / 2) })()` })

describe.skipIf(!access)('clicks over the strip (CGEvent)', () => {
  beforeAll(async () => {
    w = await launchWindow('prod', { extraEnv: { MARVER_APP_SHOW: 'focus' } })
    await w.run.call('onTop', { on: true })
    await w.run.call('show', { focus: true })
    a = await w.canvas({ slot: 1, name: 'Alpha', script: LOG_INPUT })
    b = await w.canvas({ slot: 2, name: 'Beta', script: LOG_INPUT })
    await w.run.call('activate', { id: a.id })
    await w.until((s) => !!s.tabs.find((t) => t.id === a.id)?.doc?.lifted, 10_000, 'lifted')
    await sleep(400)
  }, 60_000)
  afterAll(async () => { await w?.close() })

  it('control: a click and a scroll at y 100 reach the page (else every case below is inconclusive)', async () => {
    const c = (await content()).content
    const before = { down: seen(a.fake, 'pointerdown'), wheel: seen(a.fake, 'wheel') }
    click(c.x + c.width / 2, c.y + 100)
    scroll(c.x + c.width / 2, c.y + 100)
    await sleep(500)
    control = { click: seen(a.fake, 'pointerdown') === before.down + 1, scroll: seen(a.fake, 'wheel') > before.wheel }
    expect(control.click, 'the harness is blind to clicks: the cases below are inconclusive').toBe(true)
    expect(control.scroll, 'the harness is blind to scrolls: the cases below are inconclusive').toBe(true)
  })

  it('in the strip\'s empty part: no pointerdown and no wheel reach the page', async (ctx) => {
    needControl(ctx)
    // a canvas under the strip's empty part, or the case measures nothing
    const views = await w.run.call<{ key: string; bounds: { y: number } }[]>('views')
    const y = views.find((v) => v.key === `${a.id}:view`)?.bounds.y
    if (y === undefined || y >= 44) {
      const why = `NOT APPLICABLE - the canvas view sits at y ${y ?? 'unknown'} (the opaque layout): no canvas is under the strip, so nothing could reach the page; the case needs the one ground`
      process.stdout.write(`clicks-native: ${why}\n`)
      ctx.skip(why)
    }
    const c = (await content()).content
    const x = c.x + await emptyX()
    const before = { down: seen(a.fake, 'pointerdown'), wheel: seen(a.fake, 'wheel') }
    click(x, c.y + 22)
    scroll(x, c.y + 22)
    await sleep(500)
    expect(seen(a.fake, 'pointerdown')).toBe(before.down)
    expect(seen(a.fake, 'wheel')).toBe(before.wheel)
  })

  it('a drag in the strip\'s empty part moves the window', async (ctx) => {
    needControl(ctx)
    const was = await content()
    const x = was.content.x + await emptyX()
    drag(x, was.content.y + 22, x + 60, was.content.y + 22 + 30)
    await sleep(500)
    const now = await content()
    expect(Math.round(now.bounds.x - was.bounds.x)).toBe(60)
    expect(Math.round(now.bounds.y - was.bounds.y)).toBe(30)
    drag(x + 60, now.content.y + 22, x, now.content.y + 22 - 30)
  })

  it('on a tab: the tab activates and the page logs nothing', async (ctx) => {
    needControl(ctx)
    const c = (await content()).content
    const r = await w.run.call<{ x: number; y: number }>('exec', { target: 'strip', js: `(() => { const e = document.querySelector('[data-id="${b.id}"]').getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2 } })()` })
    const before = seen(a.fake, 'pointerdown') + seen(b.fake, 'pointerdown')
    click(c.x + r.x, c.y + r.y)
    await w.until((s) => s.active === b.id, 3000, 'the tab activated')
    await sleep(300)
    expect(seen(a.fake, 'pointerdown') + seen(b.fake, 'pointerdown')).toBe(before)
  })
})
