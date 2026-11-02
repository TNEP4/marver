/**
 * The app's own pages keep up (spec 28 A2.5, A2.12, A2.14 #19), on the real trust - the bridge's page channels as
 * built, with the canvases' proof and admission too (the fake trust hands its app pages to this same bridge): Home's or
 * Settings' renderer that goes comes back, says `app:ready` again and is sent everything; a navigation an app page
 * starts and the policy refuses leaves the page as it was, and still fed; a canvas that keeps crashing has its latched
 * tab page drawn - its words and buttons read from the page itself, as a person sees them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun
const fakes: FakeCanvas[] = []
beforeAll(async () => { w = await launchWindow('pw', { extraEnv: { MARVER_APP_FAKE_TRUST: '0' } }) })
afterAll(async () => { await w?.close(); for (const f of fakes) await f.close().catch(() => {}) })

const homeText = () => w.run.call<string>('exec', { target: 'home', js: 'document.body ? document.body.innerText : ""' })
async function canvas(slot: number, name: string): Promise<string> {
  const f = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot, name })
  fakes.push(f)
  await f.ready
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.instance === f.instance), 5000, `${name}'s tab`)
  return s.tabs.find((t) => t.reg?.instance === f.instance)!.id
}
async function homeSays(words: string, ms = 5000): Promise<string> {
  const end = Date.now() + ms
  let t = await homeText()
  while (!t.includes(words) && Date.now() < end) { await sleep(50); t = await homeText() }
  return t
}

describe('Home and Settings (A2.5)', () => {
  it('Home\'s renderer goes: Home comes back, says ready again and is sent everything - and Settings\' too', async () => {
    await w.run.call('activate', { id: 'home' })
    await canvas(1, 'Before the crash')
    expect(await homeSays('Before the crash')).toContain('Before the crash')
    const since = (await w.log()).length
    expect(await w.run.call('crash', { target: 'home' })).toBe(true)
    for (let i = 0; i < 100 && !(await w.log('page', since)).some((l) => l.data.ready === 'home'); i++) await sleep(50)
    expect((await w.log('app-page', since)).map((l) => l.data)).toContainEqual(expect.objectContaining({ page: 'home' }))
    expect((await w.log('page', since)).map((l) => l.data)).toContainEqual({ ready: 'home' })
    expect(await homeSays('Before the crash')).toContain('Before the crash')   // everything sent again
    await canvas(2, 'After the crash')
    expect(await homeSays('After the crash')).toContain('After the crash')     // and what comes after
    // Settings the same
    await w.run.call('settings:open')
    for (let i = 0; i < 60 && !(await w.log('page', since)).some((l) => l.data.ready === 'settings'); i++) await sleep(50)
    const since2 = (await w.log()).length
    expect(await w.run.call('crash', { target: 'settings' })).toBe(true)
    for (let i = 0; i < 100 && !(await w.log('page', since2)).some((l) => l.data.ready === 'settings'); i++) await sleep(50)
    expect((await w.log('page', since2)).map((l) => l.data)).toContainEqual({ ready: 'settings' })
    await w.run.call('activate', { id: 'home' })
  })

  it('a navigation an app page starts and the policy refuses keeps the page fed: Home still lists what starts after', async () => {
    await w.run.call('activate', { id: 'home' })
    const since = (await w.log()).length
    await w.run.call('exec', { target: 'home', js: "location.href = 'https://example.com/'; 1" })
    await sleep(500)
    expect((await w.log('policy', since)).map((l) => l.data)).toContainEqual(expect.objectContaining({ event: 'navigation-refused', url: 'https://example.com/' }))
    expect(await homeText()).toMatch(/On this Mac|Welcome to Marver/)   // the page stayed
    expect((await w.log('page', since)).filter((l) => l.data.ready === 'home')).toEqual([])   // it never reloaded
    await canvas(3, 'After the refused navigation')
    expect(await homeSays('After the refused navigation')).toContain('After the refused navigation')
  })
})

describe('a tab page (A2.11, A2.14 #19)', () => {
  it('a canvas that keeps crashing: its page says ready over the bridge, and draws the latched snapshot main sends it', async () => {
    const id = await canvas(4, 'Keeps crashing')
    const lifted = (n: number) => (s: Awaited<ReturnType<WindowRun['state']>>) => { const t = s.tabs.find((x) => x.id === id)!; return !!t.doc?.lifted && t.doc.commits > n && t.view === 'live' }
    await w.run.call('activate', { id })
    const s0 = await w.until(lifted(0), 10_000, 'lifted')
    await w.run.call('crash', { target: id })
    await w.until(lifted(s0.tabs.find((t) => t.id === id)!.doc!.commits), 10_000, 'the reload after the first crash')
    const since = (await w.log()).length
    await w.run.call('crash', { target: id })
    await w.until((x) => x.tabs.find((t) => t.id === id)!.crash.latched, 5000, 'the latch')
    expect(await w.run.call('page', { tab: id })).toMatchObject({ body: { page: 'crashed', latched: true } })
    // what the person sees: the page's own words, drawn from main's snapshot (polled: the page loads, says ready, is sent it)
    const js = `({ title: document.title, heading: document.getElementById('tp-title')?.textContent ?? null, buttons: Array.from(document.querySelectorAll('#content button')).map((b) => b.textContent) })`
    type Drawn = { title: string; heading: string | null; buttons: string[] } | null
    let drawn: Drawn = null
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) {
      drawn = await w.run.call<Drawn>('exec', { target: `${id}:page`, js }).catch(() => null)
      if (drawn?.heading) break
    }
    expect(drawn).toEqual({
      title: 'Keeps crashing\'s page keeps crashing', heading: 'Keeps crashing\'s page keeps crashing',
      buttons: ['Reload', 'Copy Details', 'Export Performance Report…'],
    })
    expect((await w.log('page', since)).map((l) => l.data)).toContainEqual({ ready: 'tabpage' })
  })
})
