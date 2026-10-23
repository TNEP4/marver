/**
 * Not responding (spec 28 A2.11, A2.14 #22, v1.12 r1 #4), in the production-switch harness: Playwright's loader
 * adds --disable-hang-monitor, so `unresponsive` never fires under it. A page in a busy loop, sent input so
 * Chromium's hang monitor notices, gets the pill; its Reload probes the main frame (silent for 1 s) and opens the
 * sheet, which names what the page last held; Keep Waiting changes nothing; Reload Page ends the process once and
 * reloads the page through recover, counting no crash. Chromium waits a while before `unresponsive`, so the case
 * shares one hang.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

let w: WindowRun
beforeAll(async () => {
  w = await launchWindow('prod')
  await w.run.call('onTop', { on: true })
})
afterAll(async () => { await w?.close() })

describe('a page that stops responding (A2.11)', () => {
  it('the pill, the sheet naming its unsent capture, Keep Waiting, then Reload Page - no crash counted', async () => {
    const { id } = await w.canvas({ slot: 1, name: 'TMS broker' })
    await w.run.call('activate', { id })
    await w.until((x) => !!x.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(id, { unsaved: true, why: ['capture-unsent'] })
    const before = await w.tab(id)
    await w.run.call('exec', { target: id, js: 'setTimeout(function () { for (;;) {} }, 50); 1' })
    await sleep(200)
    // input, so the hang monitor has something unanswered
    const poke = setInterval(() => { void w.run.call('click', { target: id }).catch(() => {}) }, 1000)
    let s
    try { s = await w.until((x) => x.tabs.find((t) => t.id === id)!.hung, 60_000, 'unresponsive') } finally { clearInterval(poke) }
    expect(s.pill).toMatchObject({ kind: 'not-responding', short: 'Not responding', tab: id })

    // Keep Waiting changes nothing
    await w.run.call('sheet', { mode: 'cancel' })
    expect(await w.run.call('pill:action', { rev: s.pill!.rev, act: 'button' })).toBe(true)
    for (let i = 0; i < 40 && !(await w.run.call<{ shown: { kind: string }[] }>('sheets')).shown.some((x) => x.kind === 'hang'); i++) await sleep(100)
    const sheets = (await w.run.call<{ shown: { kind: string; message: string; detail: string; buttons: string[] }[] }>('sheets')).shown.filter((x) => x.kind === 'hang')
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toMatchObject({
      message: 'TMS broker isn\'t responding',
      detail: 'Reloading ends it now and loses what it hasn\'t saved: a capture not yet sent.',
      buttons: ['Keep Waiting', 'Reload Page'],
    })
    await sleep(300)
    let t = await w.tab(id)
    expect(t).toMatchObject({ hung: true, wcId: before.wcId })
    expect(t.doc!.commits).toBe(before.doc!.commits)
    expect(t.crash.count).toBe(0)

    // Reload Page: the process ended once, the page reloaded through recover, no crash counted
    await w.run.call('sheet', { mode: 'confirm' })
    const since = (await w.log()).length
    expect(await w.run.call('pill:action', { rev: (await w.state()).pill!.rev, act: 'button' })).toBe(true)
    s = await w.until((x) => { const y = x.tabs.find((q) => q.id === id)!; return !!y.doc?.lifted && y.doc.commits > before.doc!.commits && !y.hung }, 20_000, 'the forced reload to lift')
    t = s.tabs.find((x) => x.id === id)!
    expect(t.crash).toMatchObject({ count: 0, latched: false })
    const log = await w.log(undefined, since)
    expect(log.filter((l) => l.topic === 'hang' && l.data.ended).length).toBe(1)
    expect(log.find((l) => l.topic === 'gone')!.data).toMatchObject({ tab: id, app: true })
    expect(log.some((l) => l.topic === 'crash' && l.data.reload === 'force')).toBe(true)
    expect(s.pill).toBeNull()
  })
})
