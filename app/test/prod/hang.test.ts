/**
 * Not responding (spec 28 A2.11, A2.14 #22, v1.12 r1 #4), in the production-switch harness: Playwright's loader
 * adds --disable-hang-monitor, so `unresponsive` never fires under it. A page in a busy loop, sent input so
 * Chromium's hang monitor notices, gets the pill; its Reload probes the main frame (silent for 1 s) and opens the
 * sheet, which names what the page last held; Keep Waiting changes nothing; ⌘R stays the guarded reload; Reload
 * Page ends the process once and reloads the page through recover, counting no crash. A page that answers after
 * the first second but before Reload Page is pressed ends nothing: the sheet closes by itself. A cross-process
 * iframe in a busy loop, the canvas's own main frame answering: no sheet, the pill's Reload the guarded reload
 * (proved before the sheet ships). Chromium waits a while before `unresponsive`, so each case shares one hang.
 * (A tab that navigates or joins the process while the sheet is open - the sheet again with the new list - is
 * tabpage.ts hangDecision's, unit-tested: a hung local page commits nothing, and two local canvases share no
 * renderer, so this harness cannot make it.)
 */
import { createServer, type Server } from 'node:http'
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

    // ⌘R on the hung page stays the guarded reload: main's own record (an unsent capture) refuses it, nothing ended
    const k = (await w.log()).length
    await w.run.call('command', { cmd: 'reload' })
    await sleep(300)
    expect((await w.log('guard', k)).find((l) => l.data.tab === id)!.data).toMatchObject({ action: 'reload', answer: 'refused', unsaved: true })
    expect((await w.log('hang', k)).filter((l) => l.data.ended)).toEqual([])
    expect(await w.tab(id)).toMatchObject({ hung: true, wcId: before.wcId })
    // its "Unsaved work here" lasts while the tab is active (A2.14 #33): away and back, Not responding again
    expect((await w.state()).pill).toMatchObject({ kind: 'unsaved', tab: id })
    await w.run.call('activate', { id: 'home' })
    await sleep(200)
    await w.run.call('activate', { id })
    await w.until((x) => x.pill?.kind === 'not-responding', 5000, 'Not responding again')

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

  it('an answer after the first second but before Reload Page ends nothing: the sheet closes by itself', async () => {
    // a page held in a loop of synchronous requests until the case lets it go: silent as long as it likes, then answering
    let release = false
    const { id } = await w.canvas({ slot: 2, name: 'Tidewell', onRequest: (req, res) => {
      if (req.url !== '/__mv/test/hold') return false
      res.writeHead(release ? 200 : 204, { 'cache-control': 'no-store' })
      res.end()
      return true
    } })
    await w.run.call('activate', { id })
    await w.until((x) => !!x.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'lifted')
    await w.report(id, { unsaved: true, why: ['capture-unsent'] })
    const before = await w.tab(id)
    await w.run.call('exec', { target: id, js: "setTimeout(function () { for (;;) { var x = new XMLHttpRequest(); x.open('GET', '/__mv/test/hold', false); x.send(); if (x.status === 200) break } }, 50); 1" })
    await sleep(200)
    const poke = setInterval(() => { void w.run.call('click', { target: id }).catch(() => {}) }, 1000)
    let s
    try { s = await w.until((x) => x.tabs.find((t) => t.id === id)!.hung, 60_000, 'unresponsive') } finally { clearInterval(poke) }
    await w.run.call('sheet', { mode: 'hold' })
    const since = (await w.log()).length
    expect(await w.run.call('pill:action', { rev: s.pill!.rev, act: 'button' })).toBe(true)
    for (let i = 0; i < 60 && (await w.run.call<{ held: number }>('sheets')).held < 1; i++) await sleep(50)
    expect((await w.run.call<{ held: number }>('sheets')).held).toBe(1)   // silent past its first second: the sheet
    release = true
    for (let i = 0; i < 100 && (await w.run.call<{ held: number }>('sheets')).held > 0; i++) await sleep(50)
    expect((await w.run.call<{ held: number }>('sheets')).held).toBe(0)
    for (let i = 0; i < 60 && !(await w.log('hang', since)).some((l) => l.data.answered && l.data.tab === id); i++) await sleep(50)
    const log = await w.log(undefined, since)
    expect(log.some((l) => l.topic === 'sheet' && l.data.closed === 'signal')).toBe(true)
    expect(log.some((l) => l.topic === 'hang' && l.data.answered && l.data.tab === id)).toBe(true)
    expect(log.filter((l) => l.topic === 'hang' && l.data.ended)).toEqual([])
    await w.until((x) => !x.tabs.find((t) => t.id === id)!.hung, 10_000, 'responsive')
    const t = await w.tab(id)
    expect(t).toMatchObject({ wcId: before.wcId, crash: { count: 0 } })
    expect(t.doc!.commits).toBe(before.doc!.commits)
    await w.run.call('sheet', { mode: 'cancel' })
    await w.report(id, { unsaved: false })
  })

  it('a cross-process iframe in a busy loop, the canvas\'s own main frame answering: no sheet ends anything; the pill\'s Reload is the guarded reload (A2.14 #22)', async () => {
    // the frame on another site (127.0.0.1 inside a page on [::1]): its own renderer under site isolation. It loops
    // once, at its first load, for a while - then it is a plain frame
    let served = 0
    const iframe: Server = createServer((_req, res) => {
      served += 1
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(served === 1
        ? '<!doctype html><body style="margin:0;height:100vh;background:#ccd"><script>setTimeout(function () { var e = Date.now() + 60000; while (Date.now() < e) {} }, 300)</script>'
        : '<!doctype html><body style="margin:0">plain')
    })
    const port = w.slotBase + 150
    await new Promise<void>((ok) => iframe.listen(port, '127.0.0.1', () => ok()))
    try {
      const frame = `var f = document.createElement('iframe'); f.src = 'http://127.0.0.1:${port}/'; f.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0'; document.body.appendChild(f);`
      const { id } = await w.canvas({ slot: 3, name: 'Embeds', script: frame })
      await w.run.call('activate', { id })
      await w.until((x) => !!x.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'lifted')
      await w.report(id, { unsaved: false })
      for (let i = 0; i < 50 && served < 1; i++) await sleep(100)
      await sleep(800)
      const before = await w.tab(id)
      const frames = await w.run.call<{ url: string; pid: number; main: boolean }[]>('frames', { target: id })
      const main = frames.find((f) => f.main)!
      const sub = frames.find((f) => f.url.startsWith(`http://127.0.0.1:${port}`))!
      expect(sub.pid, 'the frame runs in a renderer of its own').not.toBe(main.pid)
      const since = (await w.log()).length
      // Chromium first: input into the frame, routed as a real click is (sendInputEvent would stop at the main
      // frame). Electron 45 reports no hang for it - no 'unresponsive' in 25 s, where the main frame's own hang
      // is reported in about 15 (the case above): no pill, no sheet, nothing ended
      const poke = setInterval(() => { void w.run.call('cdpClick', { target: id, x: 200, y: 200 }).catch(() => {}) }, 1000)
      try { await sleep(25_000) } finally { clearInterval(poke) }
      expect((await w.tab(id)).hung).toBe(false)
      expect(await w.run.call<boolean | null>('silent', { target: id, ms: 300 })).toBe(false)   // its main frame answers
      // the app's own half, should Chromium report it: the hang reported by hand while the frame is still busy
      await w.run.call('hang:report', { target: id })
      const s = await w.until((x) => x.tabs.find((t) => t.id === id)!.hung && x.pill?.kind === 'not-responding', 5000, 'the pill')
      for (let i = 0; i < 50 && !(await w.log('hang', since)).some((l) => l.data.tab === id && l.data.answered); i++) await sleep(100)
      expect((await w.log('hang', since)).some((l) => l.data.tab === id && l.data.answered)).toBe(true)   // main asked its main frame
      await w.run.call('sheet', { mode: 'hold' })
      const n = (await w.run.call<{ shown: unknown[] }>('sheets')).shown.length
      expect(await w.run.call('pill:action', { rev: s.pill!.rev, act: 'button' })).toBe(true)
      await w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return (t.doc?.commits ?? 0) > before.doc!.commits }, 15_000, 'the guarded reload')
      const log = await w.log(undefined, since)
      expect((await w.run.call<{ shown: unknown[] }>('sheets')).shown.length).toBe(n)   // no sheet
      expect(log.some((l) => l.topic === 'hang' && l.data.tab === id && l.data.answeredBeforeSheet)).toBe(true)
      expect(log.filter((l) => l.topic === 'hang' && l.data.ended)).toEqual([])
      expect(log.some((l) => l.topic === 'guard' && l.data.tab === id && l.data.action === 'reload')).toBe(true)
      expect((await w.tab(id)).crash.count).toBe(0)
      await w.run.call('sheet', { mode: 'confirm' })
    } finally {
      iframe.closeAllConnections()
      await new Promise<void>((r) => iframe.close(() => r()))
    }
  }, 120_000)
})
