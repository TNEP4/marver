/**
 * A shared canvas's own beforeunload, the best-effort extra veto after the person's consent (spec 28 A4.6 #43), on the
 * production-switch harness: Playwright's loader turns Chromium's beforeunload check off, so this is the one place a
 * page's refusal is real. Against the remote harness's https hosts (test/harness/remote-canvas.ts).
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
