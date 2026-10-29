/**
 * A shared canvas on the production-switch harness (spec 28 A4.6 #43, #45), against the remote harness's https hosts
 * (test/harness/remote-canvas.ts): its own beforeunload, the best-effort extra veto after the person's consent
 * (Playwright's loader turns Chromium's beforeunload check off), and "Not responding" (it adds --disable-hang-monitor):
 * a shared page in a busy loop gets the pill and the hang sheet named by its host, and Reload Page ends its process
 * once and reloads its place, counting no crash. Two shared canvases sharing one renderer (a same-site subframe) is
 * Chromium's to place, so that list stays the unit test's (tabpage.ts hangDecision) and the check by hand's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, MAY_LEAVE, REFUSE_UNLOAD, sleep, type WindowRun } from '../harness/window.ts'
import { startRemoteCanvas, type RemoteCanvas } from '../harness/remote-canvas.ts'

let r: RemoteCanvas
let w: WindowRun
beforeAll(async () => {
  r = await startRemoteCanvas()
  r.page('veto', { script: REFUSE_UNLOAD })
  w = await launchWindow('prod', { extraEnv: r.env })
  await w.run.call('onTop', { on: true })
})
afterAll(async () => { await w?.close(); await r?.close() })

describe('a shared page that vetoes after consent keeps its tab (A4.6 #43)', () => {
  it('Close confirmed on its sheet, the page refuses: the tab stays, in front, with "Unsaved work here"; let go, it closes', async () => {
    expect(await w.run.call('remote:open', { url: r.url('veto', '/') })).toEqual({ ok: true })
    const s = await w.until((x) => !!x.tabs.find((t) => t.remote?.origin === r.origin('veto'))?.doc?.lifted, 15_000, 'lifted')
    const id = s.tabs.find((t) => t.remote?.origin === r.origin('veto'))!.id
    for (let i = 0; i < 100 && r.hits('veto', '/__mv/test/script') < 1; i++) await sleep(50)
    await w.run.call('exec', { target: id, js: 'document.body.click(); 1', gesture: true })
    await w.run.call('sheet', { mode: 'confirm' })
    await w.run.call('activate', { id: 'home' })
    expect(await w.run.call('close', { id })).toBe('refused')
    for (let i = 0; i < 40 && r.hits('veto', '/__mv/test/beforeunload') < 1; i++) await sleep(50)
    expect(r.hits('veto', '/__mv/test/beforeunload')).toBeGreaterThanOrEqual(1)
    const after = await w.state()
    expect(after.tabs.find((t) => t.id === id)).toMatchObject({ open: true, held: { action: 'close' } })
    expect(after.active).toBe(id)
    expect(after.pill).toMatchObject({ kind: 'unsaved', tab: id })
    await w.run.call('exec', { target: id, js: MAY_LEAVE })
    expect(await w.run.call('close', { id })).toBe('closed')
  })
})

describe('a shared page that stops responding (A4.6 #45)', () => {
  it('the pill and the sheet named by its host; Reload Page ends its process once and reloads its place, no crash counted', async () => {
    expect(await w.run.call('remote:open', { url: r.url('busy', '/#/b/main') })).toEqual({ ok: true })
    let s = await w.until((x) => !!x.tabs.find((t) => t.remote?.origin === r.origin('busy'))?.doc?.lifted, 15_000, 'lifted')
    const before = s.tabs.find((t) => t.remote?.origin === r.origin('busy'))!
    const id = before.id
    await w.run.call('exec', { target: id, js: 'setTimeout(function () { for (;;) {} }, 50); 1' })
    await sleep(200)
    const poke = setInterval(() => { void w.run.call('click', { target: id }).catch(() => {}) }, 1000)
    try { s = await w.until((x) => x.tabs.find((t) => t.id === id)!.hung, 60_000, 'unresponsive') } finally { clearInterval(poke) }
    expect(s.pill).toMatchObject({ kind: 'not-responding', tab: id })
    await w.run.call('sheet', { mode: 'confirm' })
    const since = (await w.log()).length
    expect(await w.run.call('pill:action', { rev: s.pill!.rev, act: 'button' })).toBe(true)
    s = await w.until((x) => { const y = x.tabs.find((q) => q.id === id)!; return !!y.doc?.lifted && y.doc.commits > before.doc!.commits && !y.hung }, 20_000, 'reloaded')
    const sheet = (await w.run.call<{ shown: { kind: string; message: string }[] }>('sheets')).shown.filter((x) => x.kind === 'hang').at(-1)!
    expect(sheet.message).toBe(`busy.canvas.test:${r.port} isn't responding`)
    expect(s.tabs.find((x) => x.id === id)!.crash).toMatchObject({ count: 0, latched: false })
    expect((await w.log('hang', since)).filter((l) => l.data.ended).length).toBe(1)
    expect(s.tabs.find((x) => x.id === id)!.remote!.url).toBe(r.url('busy', '/#/b/main'))
  })
})
