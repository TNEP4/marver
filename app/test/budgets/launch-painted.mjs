#!/usr/bin/env node
/**
 * Launch to the first canvas tab painted (spec 28 A3.8 #50; the Budgets): pixels, not A2's frame-callback proxy. No
 * test hook. A fake canvas paints its body a sentinel colour unlike its view's ground; one first launch makes the
 * profile (its time reported, not gated); then, for each warm launch, the capture helper's display stream starts (a
 * window stream cannot exist before the window) with its heartbeat, looking for a 64 x 64 block of the sentinel, and
 * the binary is spawned directly. The time is from spawn to the display time of the first frame showing the block.
 *
 * A run is conclusive only if the two clocks agree within 5 ms (the helper's ready line against this process), no
 * frame before the spawn already shows the sentinel, the frame before the detection is at most three refreshes
 * earlier (the time is then exact within that: a display stream on this Mac skips a refresh now and then even with
 * a heartbeat - narrowed from "no gap at all before detection", stated), and the page had focus at its first frame
 * (`document.hasFocus()`). Gate: five conclusive warm launches, the median under 1 s, every one reported and any over
 * 1.5 s failing; an inconclusive one is run again, three times at most. A2's proxy (spawn to the page's first
 * animation-frame request) is recorded beside each.
 *
 *   node app/test/budgets/launch-painted.mjs [--app <Marver.app>] [--out <dir>]
 *
 * Each launch takes the focus for about a second (the page must have it): the windows appear on the screen. Exit 77
 * when Screen Recording is not granted to the process running it (blind: not run).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, sleep, world } from './launcher.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'
import { blindLine, captureAccess, startCapture } from '../harness/capture.ts'

const argv = process.argv.slice(2)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const APP = val('--app') ? resolve(val('--app')) : undefined
const OUT = resolve(val('--out') ?? '.')
const SENTINEL = '00c853'
const SAY = "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'painted-' + Math.random().toString(36).slice(2, 10) }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }\n"
  + "requestAnimationFrame(function () { navigator.sendBeacon('/__mv/test/focus-' + document.hasFocus()) });"

const access = await captureAccess()
if (access !== true) {
  process.stdout.write(`launch-painted: BLIND - not run. ${blindLine(access)}\n`)
  process.exit(77)
}

const w = await world()
const fake = await startFakeCanvas({ home: w.home, slotBase: w.slotBase, slot: 1, name: 'Painted', sentinel: SENTINEL, script: SAY, root: join(w.dir, 'repo') })
await fake.ready
// Marver Dev keeps its state in state-dev/ (A2.14 #23)
const STATE = join(w.home, APP ? 'state' : 'state-dev')
mkdirSync(STATE, { recursive: true, mode: 0o700 })
writeFileSync(join(STATE, 'launched'), '')
writeFileSync(join(STATE, 'tabs.json'), JSON.stringify({ v: 1, active: { kind: 'canvas', ws: fake.ws, origin: fake.origin },
  canvases: [{ ws: fake.ws, origin: fake.origin, path: '/', shownAt: Date.now() }], settings: false, closed: [] }))

/** One launch watched by a display stream: spawn to the first sentinel frame, and what makes it conclusive. */
async function painted(label) {
  const cap = await startCapture({ mode: 'display', detect: { hex: SENTINEL, minPx: 64, belowY: 0 }, heartbeat: true })
  const skewMs = Number(process.hrtime.bigint() - BigInt(cap.ready.hostNs)) / 1e6
  const refreshNs = 1e9 / cap.ready.refreshHz
  await sleep(300)
  const since = fake.requests.length
  const L = await launch(w, { app: APP })
  let hit = null
  const end = Date.now() + 5000
  while (!hit && Date.now() < end) {
    hit = cap.frames.find((f) => f.detect?.found && BigInt(f.hostNs) >= L.spawnNs) ?? null
    if (!hit) await sleep(20)
  }
  await sleep(400)
  const reqs = fake.requests.slice(since)
  const raf = reqs.find((r) => r.path.startsWith('/__mv/test/focus-'))
  await L.stop()
  await cap.stop()
  const why = []
  if (Math.abs(skewMs) > 5) why.push(`the clocks are ${skewMs.toFixed(1)} ms apart`)
  if (cap.frames.some((f) => f.detect?.found && BigInt(f.hostNs) < L.spawnNs)) why.push('the sentinel was on the screen before the spawn')
  let gapMs = null
  if (!hit) why.push('no frame showed the sentinel within 5 s')
  else {
    const i = cap.frames.indexOf(hit)
    const prev = cap.frames[i - 1]
    gapMs = prev ? Number(BigInt(hit.hostNs) - BigInt(prev.hostNs)) / 1e6 : null
    if (gapMs === null || gapMs > (refreshNs * 3) / 1e6 + 0.5) why.push(`the frame before the detection is ${gapMs?.toFixed(1)} ms earlier`)
  }
  if (!raf) why.push('the page never reported its first frame')
  else if (raf.path !== '/__mv/test/focus-true') why.push('the page did not have focus')
  const ms = hit ? Number(BigInt(hit.hostNs) - L.spawnNs) / 1e6 : null
  const proxyMs = raf ? raf.t - L.t0 : null
  return { label, ms: ms === null ? null : Math.round(ms), proxyMs, skewMs: Math.round(skewMs * 10) / 10, gapMs: gapMs === null ? null : Math.round(gapMs * 10) / 10, refreshHz: cap.ready.refreshHz, conclusive: !why.length, why }
}

const report = { budget: 'launch-painted', at: new Date().toISOString(), build: APP ?? 'dev (app/dist, production switches, no test hook)', first: null, warm: [] }
try {
  report.first = await painted('first')
  // a first launch that shows nothing is a broken setup: no warm launch is worth the screen time
  if (report.first.ms === null) throw Object.assign(new Error('the first launch never painted the sentinel'), { setup: true })
  await sleep(500)
  let tries = 0
  while (report.warm.filter((r) => r.conclusive).length < 5 && tries < 8) {
    tries++
    report.warm.push(await painted(`warm-${tries}`))
    await sleep(500)
  }
} catch (e) { if (!e.setup) throw e; report.setup = e.message } finally { await fake.close(); w.release() }

const ok = report.warm.filter((r) => r.conclusive)
const sorted = ok.map((r) => r.ms).sort((a, b) => a - b)
report.medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
report.kind = ok.length < 5 ? 'inconclusive' : report.medianMs < 1000 && sorted.every((x) => x <= 1500) ? 'pass' : 'fail'
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'launch-painted.json'), JSON.stringify(report, null, 2))
const line = (r) => `${r.label}: ${r.ms ?? '-'} ms painted (A2's proxy ${r.proxyMs ?? '-'} ms), clocks ${r.skewMs} ms, frame before ${r.gapMs ?? '-'} ms at ${r.refreshHz} Hz${r.conclusive ? '' : ` - inconclusive: ${r.why.join('; ')}`}`
process.stdout.write([line(report.first) + ' (first launch: reported, not gated)', ...report.warm.map(line),
  `launch-painted: ${report.kind.toUpperCase()} - median of ${ok.length} conclusive warm launches ${report.medianMs ?? '-'} ms (under 1000, none over 1500)`, `report: ${join(OUT, 'launch-painted.json')}`].join('\n') + '\n')
process.exit(report.kind === 'pass' ? 0 : report.kind === 'fail' ? 1 : 3)
