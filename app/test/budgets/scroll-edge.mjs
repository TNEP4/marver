#!/usr/bin/env node
/**
 * The scroll edge's cost (spec 28 A3.8 #51, S13's gap): the same real board - a `marver dev` of this branch's
 * package on a fixture of sixteen frames - panned by the recorder's script (A3.8 #20: 60 wheel events of deltaX +50
 * then 60 of -50, 16 ms apart on an absolute schedule) in the real window, with `TOP` 44 and with 0. The rAF interval
 * p95 within 5 %, and no more intervals over 33 ms.
 *
 * `TOP` 0 is the one-ground stream's test-build switch, its `ground:inset-off` hook (layout.ts `setInsetOff`: every
 * document told `inset: 0` from its next load), the one switch for #51 - this branch's own env switch is gone. Until
 * the one ground is merged neither exists: every canvas is told 0 anyway, so the 0 run measures without a switch and
 * the 44 run says the canvas said `inset: 0` and is not run - the 0 run's numbers are the baseline. The window is
 * kept on top for the runs (an occluded page gets no animation frames, so a locked screen or a sleeping display is
 * not run, exit 77); each run is three pans, the median of their p95s compared. A pan whose frames stop is reported
 * stalled, and the run is inconclusive.
 *
 *   node app/test/budgets/scroll-edge.mjs [--runs 3] [--out <dir>]
 * Needs the package built (dist/cli.mjs: `pnpm build`) and the app's dev build (node app/scripts/build.mjs --js).
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, sleep, world } from './launcher.ts'
import { screenState } from '../harness/capture.ts'
import { CLI, fixtureRoot, startDev } from '../../../test/dev-server.ts'

const argv = process.argv.slice(2)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const RUNS = Number(val('--runs') ?? 3)
const OUT = resolve(val('--out') ?? '.')
if (!existsSync(CLI)) { process.stdout.write('scroll-edge: the package is not built (dist/cli.mjs): pnpm build\n'); process.exit(2) }
const scr = await screenState()
if (scr.locked || scr.asleep) { process.stdout.write(`scroll-edge: NOT RUN - the ${scr.locked ? 'screen is locked' : 'display is asleep'}: a page gets no animation frames\n`); process.exit(77) }

const FRAME = (i) => `export const meta = { title: 'Frame ${i}', viewport: '${i % 3 ? 'mobile' : 'laptop'}' }
export default () => (
  <main style={{ padding: 24, fontFamily: 'system-ui', background: 'hsl(${(i * 47) % 360} 40% 96%)' }}>
    <h1>Frame ${i}</h1>
    {Array.from({ length: 60 }, (_, k) => <div key={k} style={{ display: 'flex', gap: 8, padding: 6, borderBottom: '1px solid #ddd' }}><b>Row {k}</b><span>Some text for row {k} of frame ${i}</span></div>)}
  </main>
)
`
const files = { 'design/config.ts': `export default { share: { name: 'Edge board' } }\n` }
const nodes = []
for (let i = 0; i < 16; i++) {
  files[`design/scenes/demo/f${i}.tsx`] = FRAME(i)
  nodes.push({ key: `n${i}`, frame: `demo/f${i}`, x: (i % 4) * 1500, y: Math.floor(i / 4) * 1000, ...(i % 3 ? { w: 390, h: 844 } : {}) })
}
files['design/boards/main.json'] = JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes })

const MEASURE = `(function (ms) { return new Promise(function (res) { var xs = [], last = null, end = performance.now() + ms;
  (function f(t) { if (last !== null) xs.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else { xs.sort(function (a, b) { return a - b });
    res({ n: xs.length, p50: xs[Math.floor(xs.length * .5)], p95: xs[Math.floor(xs.length * .95)], over33: xs.filter(function (x) { return x > 33 }).length }) } })(performance.now());
  setTimeout(function () { res({ n: xs.length, stalled: true }) }, ms + 3000) }) })`

const w = await world()
const root = fixtureRoot('mv-edge-', files)
const dev = await startDev(root, { env: { MARVER_HOME: w.home, MARVER_SLOT_BASE: String(w.slotBase) } })
const report = { budget: 'scroll-edge', at: new Date().toISOString(), runs: {} }
try {
  for (const top of [44, 0]) {
    const L = await launch(w, { drive: true })
    try {
      await L.call('onTop', { on: true })
      // TOP 0: the one-ground stream's switch, before the board's first load (it answers the next document)
      const hooks = await L.call('hooks')
      if (top === 0 && hooks.includes('ground:inset-off')) await L.call('ground:inset-off', { on: true })
      const switched = top === 0 ? (hooks.includes('ground:inset-off') ? 'ground:inset-off' : 'none: no one ground, every canvas told 0') : null
      let s = await L.call('state')
      const end = Date.now() + 20_000
      while (!s.tabs.some((t) => t.reg?.port === dev.port && t.reg.state === 'ready') && Date.now() < end) { await sleep(100); s = await L.call('state') }
      const id = s.tabs.find((t) => t.reg?.port === dev.port)?.id
      if (!id) { report.runs[top] = { kind: 'inconclusive', why: 'the board never appeared as a tab' }; continue }
      await L.call('activate', { id })
      const e2 = Date.now() + 30_000
      for (;;) {
        s = await L.call('state')
        const t = s.tabs.find((x) => x.id === id)
        if (t?.doc?.lifted && t.doc.trusted && t.reports?.hello) break
        if (Date.now() > e2) break
        await sleep(200)
      }
      const t = (await L.call('state')).tabs.find((x) => x.id === id)
      const said = t?.reports?.hello?.inset ?? 0
      if (top === 44 && said !== 44) { report.runs[top] = { kind: 'not-run', why: `the canvas said inset: ${said} - the one ground is not built yet` }; continue }
      await L.call('exec', { target: id, js: `__mvStore.getState().nodes.length > 0 && __mvJamCanvas.fitAll(); 1` })
      await sleep(2500)
      const pans = []
      for (let r = 0; r < RUNS; r++) {
        await L.call('exec', { target: id, js: `window.__edge = ${MEASURE}(2300); 1` })
        await L.call('wheel', { tab: id, x: 640, y: 420, dx: 50, n: 60 })
        await L.call('wheel', { tab: id, x: 640, y: 420, dx: -50, n: 60 })
        pans.push(await L.call('exec', { target: id, js: 'window.__edge' }))
        await sleep(600)
      }
      if (pans.some((p) => p.stalled || !p.n)) { report.runs[top] = { kind: 'inconclusive', why: 'a pan got no animation frames to its end (occluded, locked or asleep)', pans }; continue }
      const p95s = pans.map((p) => p.p95).sort((a, b) => a - b)
      if (top === 0 && said !== 0) { report.runs[top] = { kind: 'inconclusive', why: `the TOP 0 run's canvas said inset: ${said} - the switch did not hold`, switched }; continue }
      report.runs[top] = { kind: 'measured', said, switched, pans, medianP95: p95s[Math.floor(p95s.length / 2)], over33: pans.reduce((s2, p) => s2 + p.over33, 0) }
    } finally { await L.stop() }
  }
} finally { await dev.stop(); w.release(); rmSync(root, { recursive: true, force: true }) }

const a = report.runs[44], b = report.runs[0]
report.kind = a?.kind === 'measured' && b?.kind === 'measured'
  ? (Math.abs(a.medianP95 - b.medianP95) <= b.medianP95 * 0.05 && a.over33 <= b.over33 ? 'pass' : 'fail')
  : a?.kind === 'inconclusive' || b?.kind === 'inconclusive' ? 'inconclusive' : 'not-run'
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'scroll-edge.json'), JSON.stringify(report, null, 2))
const say = (top, r) => !r ? `TOP ${top}: -` : r.kind === 'measured' ? `TOP ${top}: rAF p95 ${r.medianP95.toFixed(2)} ms (median of ${r.pans.length} pans: ${r.pans.map((p) => p.p95.toFixed(2)).join(', ')}), ${r.over33} over 33 ms` : `TOP ${top}: ${r.kind} - ${r.why}`
process.stdout.write(`${say(44, a)}\n${say(0, b)}\nscroll-edge: ${report.kind.toUpperCase()}${report.kind === 'not-run' ? ' (the 0 run is the baseline)' : ' (p95 within 5 %, no more intervals over 33 ms)'}\nreport: ${join(OUT, 'scroll-edge.json')}\n`)
process.exit(report.kind === 'pass' ? 0 : report.kind === 'fail' ? 1 : 3)
