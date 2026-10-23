/**
 * The white-out detector on the real app (spec 28 A3.3, A3.7, A3.8 #15, #16, r1 #5), production switches, the real
 * trust and bridge: a ground-mode fake canvas (test/harness/fake-canvas.ts) sends the recorder's gestures and
 * answers probe asks as a 0.27.2 shell does, and stages what the cases need. Checked: a white overlay held 1 s
 * during a gesture is one candidate, white at its observed moments; a frame white on purpose is none, its samples
 * completed and clear; at 2 Hz an overlay held 1.5 s is a candidate at 2 Hz; and the detector's cost - the same
 * animated page measured with the detector on and off, five runs each, the median rAF interval p95 within 1 ms (a
 * fixture page standing for a heavy board: the real board needs the shell's gestures, which the recorder stream wires).
 * The window is kept on top (an occluded view gives capturePage nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { launchWindow, sleep, type LogLine, type WindowRun } from '../harness/window.ts'

/** A page that keeps the compositor and the main thread busy: 1,200 boxes scaled and moved every frame, and a
 *  measure of its own animation-frame intervals. */
const HEAVY = `
  var wrap = document.createElement('div'); wrap.style.cssText = 'position:fixed;left:0;top:60px;right:0;bottom:0;overflow:hidden;z-index:1';
  var inner = document.createElement('div'); inner.style.cssText = 'position:absolute;left:0;top:0;width:3000px;height:2000px;transform-origin:0 0';
  for (var b = 0; b < 1200; b++) { var d = document.createElement('div'); d.className = 'mv-node'; d.style.cssText = 'position:absolute;width:40px;height:30px;border-radius:4px;background:hsl(' + (b * 37 % 360) + ',60%,45%);left:' + (b % 40) * 72 + 'px;top:' + Math.floor(b / 40) * 60 + 'px'; inner.appendChild(d) }
  wrap.appendChild(inner); document.body.appendChild(wrap);
  var t0 = performance.now();
  (function spin() { var t = (performance.now() - t0) / 1000; inner.style.transform = 'translate(' + (-200 + Math.sin(t) * 150) + 'px,' + (Math.cos(t) * 80) + 'px) scale(' + (0.7 + 0.3 * Math.sin(t * 1.3)) + ')'; requestAnimationFrame(spin) })();
  window.__mvMeasure = function (ms) { return new Promise(function (res) { var xs = [], last = null, end = performance.now() + ms;
    (function f(t) { if (last !== null) xs.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else { xs.sort(function (a, b) { return a - b }); res({ n: xs.length, p50: xs[Math.floor(xs.length * .5)], p95: xs[Math.floor(xs.length * .95)], over33: xs.filter(function (x) { return x > 33 }).length }) } })(performance.now()) }) };`

async function open(extraEnv: Record<string, string> = {}, script = ''): Promise<{ w: WindowRun; fake: FakeCanvas; id: string }> {
  // the real trust: the detector's asks go through the bridge to an admitted, trusted document
  const w = await launchWindow('prod', { extraEnv: { MARVER_APP_FAKE_TRUST: '0', ...extraEnv } })
  await w.run.call('onTop', { on: true })
  const fake = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot: 1, ground: true, name: 'Ground', script })
  await fake.ready
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.instance === fake.instance && t.reg.state === 'ready'), 15_000, 'the canvas tab')
  const id = s.tabs.find((t) => t.reg?.instance === fake.instance)!.id
  await w.run.call('activate', { id })
  await w.until((x) => { const t = x.tabs.find((y) => y.id === id); return !!t?.doc?.lifted && !!t.doc.trusted }, 15_000, 'lifted and trusted')
  await sleep(600)
  return { w, fake, id }
}
const exec = <T = unknown>(w: WindowRun, id: string, js: string) => w.run.call<T>('exec', { target: id, js })
const whiteout = async (w: WindowRun, since: number) => (await w.log('whiteout', since)) as LogLine[]
const count = (ls: LogLine[], f: (d: Record<string, unknown>) => boolean) => ls.filter((l) => f(l.data)).length

describe('a staged white-out and a white frame on purpose, at 4 Hz', () => {
  let r: Awaited<ReturnType<typeof open>>
  beforeAll(async () => { r = await open() }, 60_000)
  afterAll(async () => { await r?.w.close(); await r?.fake.close() })

  it('a white overlay held 1 s during a gesture is one candidate, white at its observed moments only', async () => {
    const since = (await r.w.log()).length
    await exec(r.w, r.id, `__mvGesture(true); setTimeout(function () { __mvOverlay(1000) }, 250); 1`)
    await sleep(1700)
    await exec(r.w, r.id, `__mvGesture(false); 1`)
    await sleep(1500)
    const ls = await whiteout(r.w, since)
    const cands = ls.filter((l) => typeof l.data.candidate === 'number')
    expect(count(ls, (d) => d.window === 'open'), JSON.stringify(ls.slice(0, 6))).toBe(1)
    expect(count(ls, (d) => d.verdict === 'white')).toBeGreaterThanOrEqual(2)
    expect(cands).toHaveLength(1)
    expect(cands[0]!.data.candidate).toBeGreaterThanOrEqual(2)
    expect(cands[0]!.data.candidate).toBeLessThanOrEqual(5)
  })

  it('a frame white on purpose is none: the view is white, the probes below it are not', async () => {
    await exec(r.w, r.id, `__mvWhiteFrame(true)`)
    await sleep(300)
    const since = (await r.w.log()).length
    await exec(r.w, r.id, `__mvGesture(true); 1`)
    await sleep(1500)
    await exec(r.w, r.id, `__mvGesture(false); 1`)
    await sleep(1200)
    await exec(r.w, r.id, `__mvWhiteFrame(false)`)
    const ls = await whiteout(r.w, since)
    expect(count(ls, (d) => typeof d.candidate === 'number')).toBe(0)
    expect(count(ls, (d) => d.verdict === 'clear'), JSON.stringify(ls.slice(0, 8))).toBeGreaterThanOrEqual(3)
    expect(count(ls, (d) => d.verdict === 'white')).toBe(0)
  })
})

describe('at 2 Hz (the detector\'s fallback, A3.8 #15, r1 #5)', () => {
  it('a white overlay held 1.5 s is a candidate at 2 Hz', async () => {
    const r = await open({ MARVER_APP_TIMINGS: JSON.stringify({ whiteoutTickMs: 500 }) })
    try {
      const since = (await r.w.log()).length
      await exec(r.w, r.id, `__mvGesture(true); setTimeout(function () { __mvOverlay(1500) }, 300); 1`)
      await sleep(2200)
      await exec(r.w, r.id, `__mvGesture(false); 1`)
      await sleep(1800)
      const ls = await whiteout(r.w, since)
      expect(count(ls, (d) => typeof d.candidate === 'number'), JSON.stringify(ls)).toBe(1)
    } finally { await r.w.close(); await r.fake.close() }
  }, 60_000)
})

describe('the detector\'s cost (A3.8 #15)', () => {
  it('the same animated page, detector on and off, five runs each: the median rAF interval p95 within 1 ms', async () => {
    const r = await open({}, HEAVY)
    try {
      const on: { p95: number; p50: number; n: number; over33: number }[] = []
      const off: typeof on = []
      for (let i = 0; i < 5; i++) {
        off.push(await exec(r.w, r.id, `__mvMeasure(3000)`))
        await sleep(300)
        await exec(r.w, r.id, `__mvGesture(true); 1`)
        on.push(await exec(r.w, r.id, `__mvMeasure(3000)`))
        await exec(r.w, r.id, `__mvGesture(false); 1`)
        await sleep(800)
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[2]!
      const report = { rate: '4 Hz', onP95: on.map((x) => +x.p95.toFixed(2)), offP95: off.map((x) => +x.p95.toFixed(2)), medianOn: +med(on.map((x) => x.p95)).toFixed(2), medianOff: +med(off.map((x) => x.p95)).toFixed(2),
        over33On: on.reduce((s, x) => s + x.over33, 0), over33Off: off.reduce((s, x) => s + x.over33, 0), frames: on.map((x) => x.n) }
      process.stdout.write(`whiteout cost: ${JSON.stringify(report)}\n`)
      const ls = await whiteout(r.w, 0)
      expect(count(ls, (d) => d.verdict === 'clear')).toBeGreaterThan(20)   // the detector did run
      expect(Math.abs(report.medianOn - report.medianOff), 'past 1 ms: the detector drops to 2 Hz (T.whiteoutTickMs 500) and the detection cases run again at 2 Hz').toBeLessThanOrEqual(1)
    } finally { await r.w.close(); await r.fake.close() }
  }, 120_000)
})
